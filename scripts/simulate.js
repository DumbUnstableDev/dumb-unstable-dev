// Dry-run simulation harness for the AI CEO agent.
//
// Feeds 8 synthetic market contexts through the decision pipeline
// (askClaude → validate → executeDecision) with NO real RPC, NO real chain,
// NO real Claude call unless ANTHROPIC_API_KEY is set.
//
// Safe to run anywhere: mocks out on-chain execution and falls back to a
// deterministic fake-Claude when no API key is available.
//
// Run: node scripts/simulate.js   (or `npm run simulate`)
//
// Output:
//   - state/sim-results.jsonl  (one JSON record per scenario)
//   - stdout summary table

import { promises as fs } from "fs";
import path from "path";

// Force DRY_RUN so anything that does reach actions.executeDecision no-ops.
process.env.DRY_RUN = "1";
process.env.AGENT_PAUSED = process.env.AGENT_PAUSED || "false";

// pino-based logger (same as the rest of the project)
import { log } from "../src/log.js";

// We import validate — it's pure schema + rails, safe.
import { validate } from "../src/validate.js";

// askClaude's module does `buildClient()` at import time. If neither
// ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN are set that import throws.
// Guard it.
let askClaude = null;
let claudeAvailable = false;
try {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    const mod = await import("../src/claude.js");
    askClaude = mod.askClaude;
    claudeAvailable = true;
    log.info("simulate: real Claude client available");
  } else {
    log.warn("simulate: no ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN — using fake Claude");
  }
} catch (e) {
  log.warn({ err: e.message }, "simulate: claude.js import failed — falling back to fake Claude");
}

// -----------------------------------------------------------------------------
// Fake Claude — deterministic, context-aware decision maker that roughly
// mirrors what a reasonable agent would pick. Used when the real API isn't
// reachable so the pipeline can still be exercised end-to-end.
// -----------------------------------------------------------------------------

function fakeAskClaude(ctx) {
  const bal = ctx.treasury?.balanceSol ?? 0;
  const h1 = ctx.token?.priceChange?.h1 ?? 0;
  const h24 = ctx.token?.priceChange?.h24 ?? 0;
  const top10 = ctx.holders?.top10Pct ?? 0;
  const vol1h = ctx.token?.volume?.h1 ?? 0;
  const mc = ctx.token?.marketCap ?? 0;

  // Pick action based on a simple heuristic so we exercise each branch.
  let action = "hold";
  let amount_sol = 0;
  let amount_tokens = 0;
  let target_mint = null;
  let distribute_recipients = 0;
  let confidence = 0.5;
  let tweet_text = "watching. sitting on my hands. no edge worth taking.";
  let rationale_private = "no clear signal — treasury healthy, market uneventful.";

  if (bal < 0.5) {
    action = "hold";
    confidence = 0.9;
    rationale_private = "treasury too low to act — holding to preserve optionality.";
    tweet_text = "treasury thin. holding. no moves i'd respect later.";
  } else if (h1 <= -10 && bal >= 1) {
    action = "buyback";
    amount_sol = Math.min(bal * 0.15, 5);
    confidence = 0.72;
    rationale_private = `price down ${h1.toFixed(1)}% in 1h — buyback into weakness, burn what we buy.`;
    tweet_text = `down ${Math.abs(h1).toFixed(0)}% in an hour. bid ${amount_sol.toFixed(2)} sol, burn on confirm. bought my own pain.`;
  } else if (h1 >= 15 && vol1h > 5000) {
    action = "hold";
    confidence = 0.6;
    rationale_private = "pump already in — chasing green is -EV. hold fees, let it cool.";
    tweet_text = "pump is on. not the time to pile in with treasury. letting it breathe.";
  } else if (top10 > 0.6 && bal >= 2) {
    action = "distribute";
    amount_sol = Math.min(bal * 0.1, 3);
    distribute_recipients = 50;
    confidence = 0.65;
    rationale_private = `top-10 concentration ${(top10 * 100).toFixed(0)}% — distribute rewards tail holders, widens base.`;
    tweet_text = `top holders too fat. sending ${amount_sol.toFixed(2)} sol to 50 tail wallets. wider base is cheaper than any ad.`;
  } else if (h24 >= 20 && bal >= 3) {
    action = "burn";
    amount_tokens = 10_000_000;
    confidence = 0.68;
    rationale_private = "uptrend w/ room — burn treasury tokens to tighten supply, lean into the move.";
    tweet_text = `tightening. burning 10m tokens. what remains should be worth more, or i shouldn't be here.`;
  } else if (mc > 500_000 && bal >= 2 && ctx.allowed?.allowedTargets?.length) {
    action = "invest";
    amount_sol = Math.min(bal * 0.08, 2);
    target_mint = ctx.allowed.allowedTargets[0];
    confidence = 0.58;
    rationale_private = "healthy MC + capacity — diversify a slice into an allowlisted target.";
    tweet_text = `sideways chop. putting ${amount_sol.toFixed(2)} sol into an allowlisted target. small, disciplined.`;
  } else {
    action = "hold";
    confidence = 0.55;
    rationale_private = "no signal strong enough to act on. holding is a decision.";
    tweet_text = "nothing i want to do here. holding.";
  }

  return {
    decision: {
      action,
      amount_sol,
      amount_tokens,
      target_mint,
      distribute_recipients,
      rationale_private,
      tweet_text,
      thread_followups: [],
      confidence,
    },
    raw: { fake: true, usage: null },
  };
}

// -----------------------------------------------------------------------------
// Synthetic scenario generator — 8 varied market states.
// -----------------------------------------------------------------------------

const FAKE_MINT = "TestMint1111111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";

function baseCtx(overrides = {}) {
  return {
    persona: {
      name: "$CEO",
      ticker: "CEO",
      mint: FAKE_MINT,
      twitter: "ceoagent",
    },
    treasury: {
      address: "TestTreasury11111111111111111111111111111111",
      balanceSol: 10,
      balanceUsd: 1800,
    },
    token: {
      priceUsd: 0.00012,
      marketCap: 120_000,
      liquidityUsd: 35_000,
      volume: { m5: 200, h1: 3_000, h6: 18_000, h24: 55_000 },
      priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
      txns: { h1: { buys: 20, sells: 22 } },
    },
    holders: { count: 350, top10Pct: 0.35 },
    trending: [],
    history: {
      daily: { total: 1, counts: { hold: 1 }, spentSol: 0 },
      last10: [],
    },
    allowed: {
      allowedTargets: [WSOL],
      redZone: [],
      distributionExcludes: [],
    },
    rails: {
      maxSolPctPerAction: 0.2,
      maxActionsPerDay: 12,
      cooldownMinutes: 20,
      minConfidence: 0.55,
    },
    now: new Date().toISOString(),
    ...overrides,
  };
}

const SCENARIOS = [
  {
    name: "sideways_healthy",
    desc: "boring chop, healthy treasury",
    ctx: baseCtx(),
  },
  {
    name: "hard_dump_1h",
    desc: "price -18% in 1h, treasury flush — buyback candidate",
    ctx: baseCtx({
      token: {
        priceUsd: 0.00009,
        marketCap: 90_000,
        liquidityUsd: 30_000,
        volume: { m5: 900, h1: 9_500, h6: 28_000, h24: 82_000 },
        priceChange: { m5: -3.5, h1: -18.2, h6: -22.0, h24: -31.5 },
        txns: { h1: { buys: 25, sells: 71 } },
      },
      treasury: { address: "T2", balanceSol: 14, balanceUsd: 2500 },
    }),
  },
  {
    name: "active_pump",
    desc: "+22% 1h, heavy volume — pump already in",
    ctx: baseCtx({
      token: {
        priceUsd: 0.00019,
        marketCap: 210_000,
        liquidityUsd: 55_000,
        volume: { m5: 2200, h1: 18_000, h6: 45_000, h24: 110_000 },
        priceChange: { m5: 4.2, h1: 22.1, h6: 31.8, h24: 28.4 },
        txns: { h1: { buys: 112, sells: 38 } },
      },
      treasury: { address: "T3", balanceSol: 11, balanceUsd: 2000 },
    }),
  },
  {
    name: "whale_concentration",
    desc: "top-10 holds 68% — distribute to widen base",
    ctx: baseCtx({
      holders: { count: 220, top10Pct: 0.68 },
      treasury: { address: "T4", balanceSol: 9, balanceUsd: 1650 },
    }),
  },
  {
    name: "slow_uptrend",
    desc: "+24% 24h, orderly — burn to tighten supply",
    ctx: baseCtx({
      token: {
        priceUsd: 0.00017,
        marketCap: 170_000,
        liquidityUsd: 45_000,
        volume: { m5: 400, h1: 4_500, h6: 22_000, h24: 75_000 },
        priceChange: { m5: 1.1, h1: 3.2, h6: 11.0, h24: 24.5 },
        txns: { h1: { buys: 48, sells: 32 } },
      },
      treasury: { address: "T5", balanceSol: 8, balanceUsd: 1440 },
    }),
  },
  {
    name: "low_treasury",
    desc: "0.2 SOL in treasury — must hold",
    ctx: baseCtx({
      treasury: { address: "T6", balanceSol: 0.2, balanceUsd: 36 },
    }),
  },
  {
    name: "fat_treasury_calm",
    desc: "60 SOL but market calm — diversify via invest",
    ctx: baseCtx({
      treasury: { address: "T7", balanceSol: 60, balanceUsd: 10_800 },
      token: {
        priceUsd: 0.00025,
        marketCap: 620_000,
        liquidityUsd: 90_000,
        volume: { m5: 400, h1: 5_000, h6: 24_000, h24: 70_000 },
        priceChange: { m5: 0.3, h1: 1.8, h6: 3.1, h24: 4.5 },
        txns: { h1: { buys: 42, sells: 40 } },
      },
    }),
  },
  {
    name: "rails_tripwire_daily_cap",
    desc: "12 actions already today — forces rejection on any non-hold",
    ctx: baseCtx({
      history: {
        daily: {
          total: 12,
          counts: { buyback: 6, burn: 3, distribute: 3 },
          spentSol: 12,
        },
        last10: Array.from({ length: 10 }).map((_, i) => ({
          ts: Date.now() - i * 60_000,
          action: "buyback",
          status: "executed",
          amountSol: 1,
          target: null,
          txSig: `FakeSig${i}`,
        })),
      },
      token: {
        priceUsd: 0.00009,
        marketCap: 90_000,
        liquidityUsd: 30_000,
        volume: { m5: 900, h1: 9_500, h6: 28_000, h24: 82_000 },
        priceChange: { m5: -3.5, h1: -18.2, h6: -22.0, h24: -31.5 },
        txns: { h1: { buys: 25, sells: 71 } },
      },
      treasury: { address: "T8", balanceSol: 14, balanceUsd: 2500 },
    }),
  },
];

// -----------------------------------------------------------------------------
// Simulated executor — never touches chain. Mirrors executeDecision's shape.
// -----------------------------------------------------------------------------

function simulateExecute(d) {
  switch (d.action) {
    case "hold":
      return { simulated: true, action: "hold", note: "no-op" };
    case "buyback":
      return {
        simulated: true,
        action: "buyback",
        would_spend_sol: d.amount_sol,
        would_burn_after: "auto (all tokens received)",
      };
    case "burn":
      return {
        simulated: true,
        action: "burn",
        would_burn_tokens: d.amount_tokens,
      };
    case "distribute":
      return {
        simulated: true,
        action: "distribute",
        would_spend_sol: d.amount_sol,
        recipients: d.distribute_recipients,
      };
    case "invest":
      return {
        simulated: true,
        action: "invest",
        would_spend_sol: d.amount_sol,
        target_mint: d.target_mint,
      };
    default:
      return { simulated: true, action: d.action, note: "unknown" };
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function runOne(scenario, idx, useRealClaude) {
  const { name, desc, ctx } = scenario;
  log.info({ idx: idx + 1, name, desc }, "--- scenario start ---");

  let decision, raw, claudeErr;
  try {
    if (useRealClaude && askClaude) {
      const res = await askClaude(ctx);
      decision = res.decision;
      raw = res.raw;
    } else {
      const res = fakeAskClaude(ctx);
      decision = res.decision;
      raw = res.raw;
    }
  } catch (e) {
    log.warn({ err: e.message, name }, "claude call failed — using fake");
    claudeErr = e.message;
    const res = fakeAskClaude(ctx);
    decision = res.decision;
    raw = res.raw;
  }

  log.info(
    { action: decision.action, conf: decision.confidence, amountSol: decision.amount_sol },
    "decision",
  );

  const v = await validate(decision, ctx);
  const accepted = v.ok;
  log.info(
    { accepted, reason: v.err || null },
    accepted ? "validate: accepted" : "validate: REJECTED",
  );

  let exec = null;
  if (accepted) {
    exec = simulateExecute(v.decision);
    log.info({ exec }, "simulated execution");
  }

  return {
    ts: Date.now(),
    scenario: name,
    desc,
    input: {
      treasurySol: ctx.treasury.balanceSol,
      priceChangeH1: ctx.token?.priceChange?.h1,
      priceChangeH24: ctx.token?.priceChange?.h24,
      top10Pct: ctx.holders?.top10Pct,
      marketCap: ctx.token?.marketCap,
      volH1: ctx.token?.volume?.h1,
      dailyCount: ctx.history?.daily?.total,
    },
    claude: {
      used: useRealClaude && askClaude && !claudeErr ? "real" : "fake",
      err: claudeErr || null,
    },
    decision,
    validation: { ok: v.ok, err: v.err || null },
    execution: exec,
  };
}

async function main() {
  const outFile = path.resolve("state/sim-results.jsonl");
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  // Truncate previous run.
  await fs.writeFile(outFile, "", "utf8");

  const useRealClaude = claudeAvailable && !process.env.SIMULATE_FAKE_ONLY;
  log.info(
    { scenarios: SCENARIOS.length, claude: useRealClaude ? "real" : "fake" },
    "=== simulate: begin ===",
  );

  const results = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    try {
      const r = await runOne(SCENARIOS[i], i, useRealClaude);
      results.push(r);
      await fs.appendFile(outFile, JSON.stringify(r) + "\n", "utf8");
    } catch (e) {
      log.error({ err: e.message, stack: e.stack, name: SCENARIOS[i].name }, "scenario error");
      results.push({
        scenario: SCENARIOS[i].name,
        error: e.message,
      });
    }
  }

  // ---- Summary ----
  const counts = {};
  const rejectReasons = {};
  let confSum = 0;
  let confN = 0;
  let dryRunSolSum = 0;
  let dryRunTokensSum = 0;

  for (const r of results) {
    if (r.error || !r.decision) continue;
    counts[r.decision.action] = (counts[r.decision.action] || 0) + 1;
    confSum += r.decision.confidence || 0;
    confN += 1;
    if (!r.validation.ok) {
      rejectReasons[r.validation.err] = (rejectReasons[r.validation.err] || 0) + 1;
    } else {
      dryRunSolSum += r.decision.amount_sol || 0;
      dryRunTokensSum += r.decision.amount_tokens || 0;
    }
  }

  const avgConf = confN ? (confSum / confN).toFixed(3) : "n/a";

  // Table.
  const rows = results.map((r) => {
    if (r.error) return [r.scenario, "ERROR", "-", "-", "-", "-"];
    return [
      r.scenario,
      r.decision.action,
      r.decision.confidence?.toFixed(2),
      String(r.decision.amount_sol ?? 0),
      r.validation.ok ? "ok" : "rej",
      r.validation.err || "-",
    ];
  });
  const header = ["scenario", "action", "conf", "sol", "valid", "reject_reason"];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => String(row[i]).length)),
  );
  const fmt = (vals) =>
    vals.map((v, i) => String(v).padEnd(widths[i])).join("  ");

  console.log("\n============================================================");
  console.log("  AI CEO — simulation summary");
  console.log("============================================================");
  console.log("  scenarios:       ", results.length);
  console.log("  claude mode:     ", useRealClaude ? "real (API)" : "fake (deterministic)");
  console.log("  avg confidence:  ", avgConf);
  console.log("  action counts:   ", JSON.stringify(counts));
  console.log("  reject reasons:  ", JSON.stringify(rejectReasons));
  console.log("  dry-run spend:   ", dryRunSolSum.toFixed(3), "SOL +", dryRunTokensSum, "tokens");
  console.log("  results written: ", outFile);
  console.log("------------------------------------------------------------");
  console.log("  " + fmt(header));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log("  " + fmt(row));
  console.log("============================================================\n");

  log.info("=== simulate: done ===");
}

main().catch((e) => {
  log.fatal({ err: e.message, stack: e.stack }, "simulate failed");
  process.exit(1);
});
