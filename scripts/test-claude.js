// Dry-test the Claude decision call with a mocked context.
// Requires: ANTHROPIC_API_KEY.
import { askClaude } from "../src/claude.js";

const ctx = {
  persona: { name: "$CEO", ticker: "CEO", mint: "TestMint", twitter: "ceoagent" },
  treasury: { address: "Test...", balanceSol: 12.4, balanceUsd: 2100 },
  token: {
    priceUsd: 0.00014,
    marketCap: 180_000,
    liquidityUsd: 42_000,
    volume: { m5: 400, h1: 6_800, h6: 33_000, h24: 94_000 },
    priceChange: { m5: -1.2, h1: 3.4, h6: 8.1, h24: -11.2 },
    txns: { h1: { buys: 38, sells: 29 } },
  },
  holders: { count: 412, top10Pct: 0.41 },
  trending: [],
  history: { daily: { total: 2, counts: { hold: 1, buyback: 1 }, spentSol: 1.2 }, last10: [] },
  allowed: { allowedTargets: ["So11111111111111111111111111111111111111112"], redZone: [] },
  rails: { maxSolPctPerAction: 0.2, maxActionsPerDay: 12, cooldownMinutes: 20, minConfidence: 0.55 },
  now: new Date().toISOString(),
};

const { decision, raw } = await askClaude(ctx);
console.log("=== decision ===");
console.log(decision);
console.log("\n=== usage ===");
console.log(raw.usage);
