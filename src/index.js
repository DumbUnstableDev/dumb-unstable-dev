import cron from "node-cron";
import readline from "readline";
import { cfg } from "./config.js";
import { log } from "./log.js";
import { buildContext, contextSummary } from "./context.js";
import { askClaude, askClaudeForReplies } from "./claude.js";
import { validate } from "./validate.js";
import { executeDecision, claimCreatorFees } from "./actions.js";
import { postTweet, postReplies } from "./twitter.js";
import { recentMentions } from "./twitter.js";
import { appendAction } from "./memory.js";
import { appendDecision, syncFeed } from "./feed.js";
import { startStatusServer } from "./status-server.js";

let _tickInFlight = false;
let _replyTickInFlight = false;
const _repliedMentionIds = new Set(); // de-dup: don't reply to the same mention twice

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
    // Record skipped triggers so overlapping/dropped ticks are visible in the log.
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

    // 8. Record (private memory + public feed).
    const tx_sig =
      execRes?.sig || execRes?.swapSig || execRes?.sigs?.[0] || null;
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
      tx_sig,
      tweet_id: tweetRes?.ids?.[0] || null,
      tweet_dry_run: tweetRes?.dryRun || false,
      exec_dry_run: execRes?.dryRun || false,
      replies: replyRes || null,
      lottery_winners: execRes?.winners || null,
      boost_kind: d.boost_kind || null,
    });
    // Public feed — sanitization is handled inside feed.js (stealth-aware).
    await appendDecision({
      trigger,
      action: d.action,
      amount_sol: d.amount_sol,
      amount_tokens: d.amount_tokens,
      target: d.target_mint,
      confidence: d.confidence,
      tweet_text: d.tweet_text,
      rationale_private: d.rationale_private,
      tx_sig,
    });
    log.info({ ms: Date.now() - started }, "=== tick end (executed) ===");
  } finally {
    _tickInFlight = false;
  }
}

// Reply-only tick — runs on a faster cadence than the main decision loop.
// Just reads recent mentions, asks Claude (in voice) which deserve replies,
// and posts them. No on-chain action, no main tweet.
//
// Why split? Per Jmean: less main posts (only when there's something to say)
// + more replies (engagement is alpha). Hourly main + 15-min replies hits
// that ratio well.
export async function replyTick() {
  if (_replyTickInFlight) {
    log.debug("reply tick already in flight — skipping");
    return;
  }
  if (cfg.dryRun) {
    log.debug("reply tick: dryRun — skipping");
    return;
  }
  if (!cfg.twitterHandle) {
    log.debug("reply tick: no TWITTER_HANDLE — skipping");
    return;
  }
  _replyTickInFlight = true;
  try {
    const mentions = await recentMentions({
      handle: cfg.twitterHandle,
      sinceMinutes: 30, // overlap with cron interval; de-dup handles repeats
      maxResults: 20,
    });
    // Filter out already-replied
    const fresh = mentions.filter((m) => m.id && !_repliedMentionIds.has(m.id));
    if (fresh.length === 0) {
      log.debug("reply tick: no fresh mentions");
      return;
    }
    log.info({ fresh: fresh.length }, "reply tick: asking claude");

    let result;
    try {
      result = await askClaudeForReplies(fresh);
    } catch (e) {
      log.error({ err: e.message }, "reply tick: claude call failed");
      return;
    }
    const replies = result.replies || [];
    if (!replies.length) {
      log.info("reply tick: claude chose to skip all mentions");
      // Still mark them seen — re-asking won't change the answer.
      fresh.forEach((m) => _repliedMentionIds.add(m.id));
      return;
    }

    // Validator-style stealth check on reply text (light — main validator
    // is for full decisions; we re-implement a tiny piece here).
    if (cfg.stealthMode && cfg.tokenMint) {
      const mintStr = cfg.tokenMint.toBase58().toLowerCase();
      const blocked = replies.some(
        (r) =>
          r.text?.toLowerCase().includes(mintStr) ||
          r.text?.toLowerCase().includes("pump.fun/coin/"),
      );
      if (blocked) {
        log.warn("reply tick: stealth guard blocked a reply containing CA");
        return;
      }
    }

    // Confirm mention_ids are real mentions (avoid hallucinations)
    const realIds = new Set(fresh.map((m) => m.id));
    const validReplies = replies.filter((r) => realIds.has(r.mention_id));

    const posted = await postReplies(validReplies);
    log.info({ posted: posted?.length }, "reply tick: posted");

    // Mark all as seen (reply or skip — won't ask again)
    validReplies.forEach((r) => _repliedMentionIds.add(r.mention_id));
    fresh.forEach((m) => _repliedMentionIds.add(m.id));

    await appendAction({
      trigger: "reply_cron",
      action: "reply_only",
      status: "executed",
      replies: posted,
      mention_count: fresh.length,
    });

    // Cap memory of replied IDs (keep last 1000)
    if (_repliedMentionIds.size > 1000) {
      const arr = Array.from(_repliedMentionIds);
      _repliedMentionIds.clear();
      arr.slice(-500).forEach((id) => _repliedMentionIds.add(id));
    }
  } finally {
    _replyTickInFlight = false;
  }
}

async function main() {
  const once = process.argv.includes("--once");

  log.info(
    {
      ticker: cfg.tokenTicker,
      mint: cfg.tokenMint?.toBase58() ?? "(not set)",
      dryRun: cfg.dryRun,
      paused: cfg.paused,
      stealth: cfg.stealthMode,
      manualApproval: cfg.manualApproval,
    },
    "ai-agent-ceo boot",
  );

  if (once) {
    await tick({ trigger: "manual" });
    process.exit(0);
  }

  // Main decision cron — slower cadence, agent picks an action and (if not
  // hold) tweets about it. Default: hourly.
  cron.schedule(cfg.tickCron, () => {
    tick({ trigger: "cron" }).catch((e) =>
      log.error({ err: e.message }, "cron tick error"),
    );
  });
  log.info({ cron: cfg.tickCron }, "main cron scheduled");

  // Reply-only cron — faster cadence, just checks mentions and replies to
  // worthy ones. No main action. Default: every 15 min.
  cron.schedule(cfg.replyCron, () => {
    replyTick().catch((e) =>
      log.error({ err: e.message }, "reply cron error"),
    );
  });
  log.info({ cron: cfg.replyCron }, "reply cron scheduled");

  // Public feed sync — pushes docs/feed.json to GitHub.
  // Slow cadence (every 5 min) since the data only changes on ticks and
  // we want to avoid spammy commit history.
  const feedCron = cfg.feedCron || "*/5 * * * *";
  cron.schedule(feedCron, () => {
    syncFeed().catch((e) =>
      log.warn({ err: e.message }, "feed sync error (non-fatal)"),
    );
  });
  log.info({ cron: feedCron }, "feed sync cron scheduled");

  // Optional HTTP /status endpoint (set STATUS_PORT=3030 in .env to enable).
  startStatusServer();

  log.info("running — ctrl-c to stop");
}

main().catch((e) => {
  log.fatal({ err: e.message }, "boot failed");
  process.exit(1);
});
