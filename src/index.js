import cron from "node-cron";
import readline from "readline";
import { cfg } from "./config.js";
import { log } from "./log.js";
import { buildContext, contextSummary } from "./context.js";
import { askClaude } from "./claude.js";
import { validate } from "./validate.js";
import { executeDecision, claimCreatorFees } from "./actions.js";
import { postTweet, postReplies } from "./twitter.js";
import { recentMentions } from "./twitter.js";
import { appendAction } from "./memory.js";
import { subscribeTokenTrades } from "./lib/pumpportal.js";
import { startStatusServer } from "./status-server.js";

let _tickInFlight = false;

async function tryClaimFeesSafely() {
  if (cfg.dryRun) return null;
  if (!cfg.tokenMint || !cfg.treasury) return null;
  try {
    const sig = await claimCreatorFees();
    log.info({ sig }, "creator fees claimed");
    return sig;
  } catch (e) {
    log.warn({ err: e.message }, "fee claim skipped (no fees or not yet creator)");
    return null;
  }
}

async function askApproval(summary) {
  if (!cfg.manualApproval) return true;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n>>> APPROVE action: ${summary} ? [y/N] `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

export async function tick({ trigger = "cron" } = {}) {
  if (_tickInFlight) {
    log.info({ trigger }, "tick already in flight — skipping");
    // Record skipped triggers so dropped whale events are visible in the log.
    try {
      await appendAction({
        trigger,
        action: "skip",
        status: "tick_in_flight",
      });
    } catch {
      // best-effort; don't crash on log-write failure
    }
    return;
  }
  _tickInFlight = true;
  const started = Date.now();
  try {
    log.info({ trigger }, "=== tick start ===");

    // 1. (Optional) claim fees before we decide.
    await tryClaimFeesSafely();

    // 2. Build context.
    const ctx = await buildContext();
    // Augment with recent mentions if handle configured.
    if (cfg.twitterHandle) {
      ctx.mentions = await recentMentions({ handle: cfg.twitterHandle, sinceMinutes: 60 });
    }
    log.info(contextSummary(ctx), "context built");

    // 3. Ask Claude.
    let result;
    try {
      result = await askClaude(ctx);
    } catch (e) {
      log.error({ err: e.message }, "claude call failed — skipping tick");
      await appendAction({ trigger, action: "error", status: "llm_failed", err: e.message });
      return;
    }
    const decision = result.decision;
    log.info({ action: decision.action, conf: decision.confidence }, "claude decision");

    // 4. Validate.
    let v = await validate(decision, ctx);
    if (!v.ok) {
      log.warn({ err: v.err }, "decision rejected — forcing hold");
      await appendAction({
        trigger,
        action: decision.action,
        status: "rejected",
        reason: v.err,
        tweet_text: decision.tweet_text,
        rationale: decision.rationale_private,
      });
      return;
    }
    const d = v.decision;

    // 5. Approval gate.
    // Build a richer summary for boost so the human sees WHERE the SOL is going.
    let summary = `${d.action} amount=${d.amount_sol} SOL target=${d.target_mint || "-"} conf=${d.confidence}`;
    if (d.action === "boost") {
      const wallet =
        process.env.BOOST_PAYMENT_WALLET ||
        process.env.DS_BOOST_RECIPIENT ||
        "(none)";
      summary += `  tier=${d.boost_kind} → step-bro=${wallet}`;
    }
    if (d.action === "lottery") {
      summary += `  winners=${d.lottery_winners}`;
    }
    if (d.action === "distribute") {
      summary += `  recipients=${d.distribute_recipients}`;
    }
    const ok = await askApproval(summary);
    if (!ok) {
      log.info({ summary }, "action denied by human — skipping");
      await appendAction({
        trigger,
        action: d.action,
        status: "denied_by_human",
        amount_sol: d.amount_sol,
        tweet_text: d.tweet_text,
      });
      return;
    }

    // 6. Execute on-chain.
    let execRes = null;
    try {
      execRes = await executeDecision(d, ctx);
    } catch (e) {
      log.error({ err: e.message }, "execution failed");
      await appendAction({
        trigger,
        action: d.action,
        status: "exec_failed",
        err: e.message,
        amount_sol: d.amount_sol,
      });
      return;
    }

    // 7. Post tweet + any replies to mentions.
    let tweetRes = null;
    try {
      tweetRes = await postTweet(d.tweet_text, d.thread_followups || []);
    } catch (e) {
      log.error({ err: e.message }, "tweet post failed — action did execute though");
    }
    let replyRes = null;
    if (Array.isArray(d.replies) && d.replies.length) {
      try {
        replyRes = await postReplies(d.replies);
      } catch (e) {
        log.warn({ err: e.message }, "replies failed");
      }
    }

    // 8. Record.
    await appendAction({
      trigger,
      action: d.action,
      status: "executed",
      amount_sol: d.amount_sol,
      amount_tokens: d.amount_tokens,
      target: d.target_mint,
      recipients: d.distribute_recipients,
      confidence: d.confidence,
      tweet_text: d.tweet_text,
      rationale: d.rationale_private,
      tx_sig: execRes?.sig || execRes?.swapSig || execRes?.sigs?.[0] || null,
      tweet_id: tweetRes?.ids?.[0] || null,
      tweet_dry_run: tweetRes?.dryRun || false,
      exec_dry_run: execRes?.dryRun || false,
      replies: replyRes || null,
      lottery_winners: execRes?.winners || null,
      boost_kind: d.boost_kind || null,
    });
    log.info({ ms: Date.now() - started }, "=== tick end (executed) ===");
  } finally {
    _tickInFlight = false;
  }
}

// Whale detection — triggers a tick if a big buy/sell hits the token.
function onTrade(msg) {
  const sol = Number(msg.solAmount || 0);
  const isWhale = sol >= 3;
  if (!isWhale) return;
  log.info({ sol, type: msg.txType }, "whale trade detected — firing tick");
  tick({ trigger: "whale_trade" }).catch((e) => log.error({ err: e.message }, "event tick error"));
}

async function main() {
  const once = process.argv.includes("--once");

  log.info(
    {
      ticker: cfg.tokenTicker,
      mint: cfg.tokenMint?.toBase58() ?? "(not set)",
      dryRun: cfg.dryRun,
      paused: cfg.paused,
      manualApproval: cfg.manualApproval,
    },
    "ai-agent-ceo boot",
  );

  if (once) {
    await tick({ trigger: "manual" });
    process.exit(0);
  }

  // Cron heartbeat.
  cron.schedule(cfg.tickCron, () => {
    tick({ trigger: "cron" }).catch((e) => log.error({ err: e.message }, "cron tick error"));
  });
  log.info({ cron: cfg.tickCron }, "cron scheduled");

  // Event trigger: whale trades on our token.
  if (cfg.tokenMint) {
    subscribeTokenTrades([cfg.tokenMint.toBase58()], onTrade);
  }

  // Optional HTTP /status endpoint (set STATUS_PORT=3030 in .env to enable).
  startStatusServer();

  log.info("running — ctrl-c to stop");
}

main().catch((e) => {
  log.fatal({ err: e.message }, "boot failed");
  process.exit(1);
});
