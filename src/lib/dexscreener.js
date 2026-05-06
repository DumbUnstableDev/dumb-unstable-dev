import { request } from "undici";
import { cfg } from "../config.js";
import { log } from "../log.js";

// Returns the most liquid Solana pair for a mint, with price + 1h/24h stats.
export async function getPairByMint(mint) {
  const url = `${cfg.dexscreenerBase}/latest/dex/tokens/${mint}`;
  try {
    const { body } = await request(url, { method: "GET" });
    const data = await body.json();
    const pairs = (data.pairs || []).filter((p) => p.chainId === "solana");
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    return {
      pairAddress: p.pairAddress,
      dex: p.dexId,
      priceUsd: Number(p.priceUsd || 0),
      priceNative: Number(p.priceNative || 0),
      liquidityUsd: p.liquidity?.usd || 0,
      fdv: p.fdv || 0,
      marketCap: p.marketCap || 0,
      volume: {
        m5: p.volume?.m5 || 0,
        h1: p.volume?.h1 || 0,
        h6: p.volume?.h6 || 0,
        h24: p.volume?.h24 || 0,
      },
      priceChange: {
        m5: p.priceChange?.m5 || 0,
        h1: p.priceChange?.h1 || 0,
        h6: p.priceChange?.h6 || 0,
        h24: p.priceChange?.h24 || 0,
      },
      txns: p.txns || {},
    };
  } catch (e) {
    log.warn({ err: e.message, mint }, "dexscreener getPairByMint failed");
    return null;
  }
}

// Trending Solana tokens — used to feed AI when it's considering 'invest'.
export async function getTrendingSolana(limit = 20) {
  const url = `${cfg.dexscreenerBase}/token-profiles/latest/v1`;
  try {
    const { body } = await request(url, { method: "GET" });
    const data = await body.json();
    const items = (Array.isArray(data) ? data : []).filter((t) => t.chainId === "solana");
    return items.slice(0, limit).map((t) => ({
      mint: t.tokenAddress,
      name: t.description?.slice(0, 80) || "",
      links: t.links || [],
    }));
  } catch (e) {
    log.warn({ err: e.message }, "dexscreener trending failed");
    return [];
  }
}
