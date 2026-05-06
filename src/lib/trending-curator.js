// Curated investment candidates — pulls DexScreener trending Solana tokens,
// applies hard safety filters, returns a short list the agent can actually
// consider for `invest` decisions.
//
// The agent is NOT allowed to invest into any token — it's constrained to
// this curated set. That way prompt injection or a bad LLM call can't drain
// the treasury into random scam mints.

import { request } from "undici";
import { cfg } from "../config.js";
import { log } from "../log.js";

const DEXS_BASE = "https://api.dexscreener.com";

// Thresholds — only BIG or HYPED tokens. Boss's rule: "only big ones or hyped
// ones to get attraction". This filters out random pump.fun launches and keeps
// the agent in tokens that actually drive narrative when we buy.
const MIN_LIQUIDITY_USD = 150_000;     // was 50k — raised for "big" tier
const MIN_VOL_24H_USD = 500_000;        // was 30k — raised for "hyped" tier
const MIN_MARKET_CAP_USD = 1_000_000;   // min MC to qualify as "big"
const MIN_AGE_HOURS = 48;               // was 24 — more proven survival
const MAX_PRICE_CHANGE_24H = 300;
const MIN_PRICE_CHANGE_24H = -50;
const TOP_N = 8;

// "Hype" shortcut: if volume/MC ratio > 0.5 (exceptional turnover), accept
// even if MC is below the "big" threshold — those are the viral tokens.
const HYPE_TURNOVER_RATIO = 0.5;

// Static blocklist — stables + majors we don't want the agent yoloing into
// (they're not memecoin bets, and some require permits/special flows).
const NEVER_INVEST = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "So11111111111111111111111111111111111111112", // wSOL (agent holds native SOL)
]);

async function trendingPairs() {
  try {
    // DexScreener trending by category. 'trending/solana' returns active pairs with momentum.
    const url = `${DEXS_BASE}/token-profiles/latest/v1`;
    const { body } = await request(url);
    const data = await body.json();
    return Array.isArray(data) ? data.filter((t) => t.chainId === "solana") : [];
  } catch (e) {
    log.warn({ err: e.message }, "trending: fetch failed");
    return [];
  }
}

async function pairDetails(mint) {
  try {
    const url = `${DEXS_BASE}/latest/dex/tokens/${mint}`;
    const { body } = await request(url);
    const data = await body.json();
    const pairs = (data.pairs || []).filter((p) => p.chainId === "solana");
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs[0];
  } catch {
    return null;
  }
}

// Applies safety filters. Returns curated candidate list for the agent.
export async function curatedCandidates({ ownMint, redZone = [] } = {}) {
  const redSet = new Set([...redZone, ...NEVER_INVEST, ownMint].filter(Boolean));
  const seeds = await trendingPairs();

  const candidates = [];
  const checked = new Set();

  for (const seed of seeds.slice(0, 30)) {
    const mint = seed.tokenAddress;
    if (!mint || checked.has(mint) || redSet.has(mint)) continue;
    checked.add(mint);

    const p = await pairDetails(mint);
    if (!p) continue;

    const liqUsd = p.liquidity?.usd || 0;
    const vol24 = p.volume?.h24 || 0;
    const mcUsd = p.marketCap || p.fdv || 0;
    const change24 = p.priceChange?.h24 || 0;
    const ageMs = p.pairCreatedAt ? Date.now() - p.pairCreatedAt : 0;
    const ageHours = ageMs / (3600 * 1000);
    const turnover = mcUsd > 0 ? vol24 / mcUsd : 0;

    // Hard filters — common baseline
    if (liqUsd < MIN_LIQUIDITY_USD) continue;
    if (ageHours < MIN_AGE_HOURS) continue;
    if (change24 > MAX_PRICE_CHANGE_24H) continue;
    if (change24 < MIN_PRICE_CHANGE_24H) continue;

    // Must qualify as BIG or HYPED (not both required, but at least one)
    const isBig = mcUsd >= MIN_MARKET_CAP_USD && vol24 >= MIN_VOL_24H_USD * 0.3;
    const isHyped =
      vol24 >= MIN_VOL_24H_USD && turnover >= HYPE_TURNOVER_RATIO;
    if (!isBig && !isHyped) continue;

    const tier = isBig && isHyped ? "big+hyped" : isBig ? "big" : "hyped";

    // Score prioritizes volume×liquidity, penalizes extreme pumps.
    const score =
      Math.log10(liqUsd) * 0.3 +
      Math.log10(vol24 + 1) * 0.4 +
      Math.log10(mcUsd + 1) * 0.2 +
      Math.max(-1, Math.min(1, change24 / 100)) * 0.1;

    candidates.push({
      mint,
      symbol: p.baseToken?.symbol,
      name: p.baseToken?.name,
      tier,
      priceUsd: Number(p.priceUsd || 0),
      marketCapUsd: mcUsd,
      liquidityUsd: liqUsd,
      volume24hUsd: vol24,
      turnover24h: Number(turnover.toFixed(3)),
      priceChange24h: change24,
      priceChange1h: p.priceChange?.h1 || 0,
      ageHours: Math.round(ageHours),
      score: Number(score.toFixed(3)),
    });

    if (candidates.length >= TOP_N * 2) break;
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, TOP_N);
}
