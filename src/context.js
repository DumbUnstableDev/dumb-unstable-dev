import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { cfg, connection } from "./config.js";
import { getPairByMint, getTrendingSolana } from "./lib/dexscreener.js";
import { getHolderStats } from "./lib/helius.js";
import { readRecent, summarize24h, openPositions } from "./memory.js";
import { loadAllowedTargets } from "./allowlist.js";
import { curatedCandidates } from "./lib/trending-curator.js";
import { log } from "./log.js";

const WSOL = "So11111111111111111111111111111111111111112";

export async function buildContext() {
  const conn = connection();
  const treasury = cfg.treasury?.publicKey;
  const mint = cfg.tokenMint?.toBase58();

  const [pair, holders, trending, recent, daily, solBal, positions] =
    await Promise.all([
      mint ? getPairByMint(mint) : null,
      mint ? getHolderStats(mint) : { count: 0, top10Pct: 0 },
      getTrendingSolana(10).catch(() => []),
      readRecent(10),
      summarize24h(),
      treasury ? conn.getBalance(treasury).catch(() => 0) : 0,
      openPositions().catch(() => []),
    ]);

  const allowed = await loadAllowedTargets();
  const candidates = await curatedCandidates({
    ownMint: mint,
    redZone: allowed.redZone,
  }).catch((e) => {
    log.warn({ err: e.message }, "curator failed");
    return [];
  });

  const treasurySol = solBal / LAMPORTS_PER_SOL;
  const treasuryUsd =
    pair?.priceUsd && pair?.priceNative
      ? treasurySol * (pair.priceUsd / pair.priceNative)
      : null;

  return {
    persona: {
      name: cfg.personaName,
      ticker: cfg.tokenTicker,
      mint,
      twitter: cfg.twitterHandle,
    },
    treasury: {
      address: treasury?.toBase58() ?? null,
      balanceSol: treasurySol,
      balanceUsd: treasuryUsd,
    },
    token: pair
      ? {
          pairAddress: pair.pairAddress, // needed for DS boost attribution
          priceUsd: pair.priceUsd,
          marketCap: pair.marketCap,
          liquidityUsd: pair.liquidityUsd,
          volume: pair.volume,
          priceChange: pair.priceChange,
          txns: pair.txns,
        }
      : null,
    holders,
    trending: trending.slice(0, 5),
    curated_candidates: candidates, // safety-filtered list for 'invest' action
    open_positions: positions,       // tokens the agent has already bought
    history: {
      daily,
      last10: recent.map((r) => ({
        ts: r.ts,
        action: r.action,
        status: r.status,
        amountSol: r.amount_sol,
        target: r.target,
        txSig: r.tx_sig,
      })),
    },
    allowed,
    rails: cfg.rails,
    now: new Date().toISOString(),
  };
}

export function contextSummary(ctx) {
  return {
    treasurySol: ctx.treasury.balanceSol?.toFixed(4),
    priceUsd: ctx.token?.priceUsd,
    mc: ctx.token?.marketCap,
    h1Change: ctx.token?.priceChange?.h1,
    holders: ctx.holders?.count,
    top10Pct: ctx.holders?.top10Pct,
    actions24h: ctx.history.daily.total,
  };
}
