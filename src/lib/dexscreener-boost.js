// DexScreener Boost — semi-manual payment flow (Solana).
//
// DexScreener has NO public API for buying boosts (confirmed by their team).
// So we use a "step-bro" pattern:
//   1. Agent decides it wants a boost tier.
//   2. Agent sends the SOL equivalent of the tier price to a dev-controlled
//      wallet (BOOST_PAYMENT_WALLET) with a memo describing the tier + pair.
//   3. Dev sees the incoming SOL + memo, manually buys the boost on DS UI.
//   4. Agent tweets the intent transparently in-character (see system.md).
//
// Real 2026 tiers from DexScreener UI (prices in USD, paid in SOL at current fx):
//   10x  boosts / 12h / $99
//   30x  boosts / 12h / $249
//   50x  boosts / 12h / $399
//   100x boosts / 24h / $899
//   500x boosts / 24h / $3,999  (unlocks Golden Ticker)
//
// Env vars required (set only if agent should be allowed to request boosts):
//   BOOST_PAYMENT_WALLET  — Solana address of the dev wallet that receives
//                            boost-payment SOL and manually pays DS
//
// Optional overrides (if DS changes pricing):
//   DS_BOOST_10X_USD=99  DS_BOOST_30X_USD=249  DS_BOOST_50X_USD=399
//   DS_BOOST_100X_USD=899  DS_BOOST_500X_USD=3999

import { request } from "undici";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { log } from "../log.js";

// Official Solana SPL memo program (v1, most widely accepted).
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

// Boost tiers. USD values come from the DS UI; override via env if DS shifts.
function envUsd(key, fallback) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const DS_TIERS = {
  dex_boost_10x: {
    usd: envUsd("DS_BOOST_10X_USD", 99),
    boosts: 10,
    durationHours: 12,
    label: "10× boosts / 12h",
  },
  dex_boost_30x: {
    usd: envUsd("DS_BOOST_30X_USD", 249),
    boosts: 30,
    durationHours: 12,
    label: "30× boosts / 12h",
  },
  dex_boost_50x: {
    usd: envUsd("DS_BOOST_50X_USD", 399),
    boosts: 50,
    durationHours: 12,
    label: "50× boosts / 12h",
  },
  dex_boost_100x: {
    usd: envUsd("DS_BOOST_100X_USD", 899),
    boosts: 100,
    durationHours: 24,
    label: "100× boosts / 24h",
  },
  dex_boost_500x: {
    usd: envUsd("DS_BOOST_500X_USD", 3999),
    boosts: 500,
    durationHours: 24,
    label: "500× boosts / 24h  (Golden Ticker)",
  },
};

export function boostRecipient() {
  // Dev-controlled wallet that receives SOL and pays DS manually.
  // Falls back to legacy DS_BOOST_RECIPIENT env name for backwards-compat.
  return (
    process.env.BOOST_PAYMENT_WALLET ||
    process.env.DS_BOOST_RECIPIENT ||
    null
  );
}
export function boostEnabled() {
  return !!boostRecipient();
}
export function tierFor(kind) {
  return DS_TIERS[kind] || null;
}

// --- SOL / USD fx ------------------------------------------------------
let _fxCache = { ts: 0, solUsd: 0 };
const FX_TTL_MS = 60_000;

// Sanity bounds — reject any rate outside this range. Defends against:
//  (a) API returning corrupt data  (b) MITM / poisoned response attempting
//  to inflate `lamports = tier_usd / sol_usd`. Bounds are wide enough to
//  cover any realistic SOL price for the next several years.
const MIN_SOL_USD = 20;
const MAX_SOL_USD = 5000;
const SOL_MINT = "So11111111111111111111111111111111111111112";

function sanityBound(p, source) {
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (p < MIN_SOL_USD || p > MAX_SOL_USD) {
    log.warn(
      { p, source, MIN_SOL_USD, MAX_SOL_USD },
      "ds-boost: SOL/USD out of sanity bounds — rejecting",
    );
    return 0;
  }
  return p;
}

export async function getSolUsd() {
  if (Date.now() - _fxCache.ts < FX_TTL_MS && _fxCache.solUsd > 0) {
    return _fxCache.solUsd;
  }
  // Source 1: CoinGecko
  try {
    const { body } = await request(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    );
    const j = await body.json();
    const p = sanityBound(Number(j?.solana?.usd || 0), "coingecko");
    if (p > 0) {
      _fxCache = { ts: Date.now(), solUsd: p };
      return p;
    }
  } catch (e) {
    log.warn({ err: e.message }, "ds-boost: coingecko fx fetch failed");
  }
  // Source 2: Jupiter Price API v2 (the v6 endpoint was sunset in 2024).
  try {
    const { body } = await request(
      `https://api.jup.ag/price/v2?ids=${SOL_MINT}`,
    );
    const j = await body.json();
    const p = sanityBound(Number(j?.data?.[SOL_MINT]?.price || 0), "jupiter");
    if (p > 0) {
      _fxCache = { ts: Date.now(), solUsd: p };
      return p;
    }
  } catch (e) {
    log.warn({ err: e.message }, "ds-boost: jupiter fx fetch failed");
  }
  throw new Error("ds-boost: could not resolve SOL/USD fx within sanity bounds");
}

// --- Build payment tx ---------------------------------------------------
export async function buildBoostPaymentTx({
  kind,
  fromPubkey,
  pairAddress,
  slippagePct = 3, // pay up to 3% above quoted USD to tolerate fx drift
}) {
  const tier = tierFor(kind);
  if (!tier) throw new Error("boost: unknown tier " + kind);
  const recipient = boostRecipient();
  if (!recipient) throw new Error("boost: BOOST_PAYMENT_WALLET not set");
  if (!pairAddress) throw new Error("boost: pairAddress required");

  const solUsd = await getSolUsd();
  const solAmount = (tier.usd * (1 + slippagePct / 100)) / solUsd;
  const lamports = Math.ceil(solAmount * LAMPORTS_PER_SOL);

  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: new PublicKey(recipient),
      lamports,
    }),
  );
  // Memo format: human-readable instruction for the dev who'll pay DS manually.
  // Includes tier kind + pair so dev knows exactly which boost to buy.
  const memo = `boost-request|tier=${kind}|pair=${pairAddress}|usd=${tier.usd}`;
  tx.add(
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, "utf8"),
    }),
  );

  return {
    tx,
    tier,
    memo,
    lamports,
    solAmount,
    usdAmount: tier.usd,
    solUsdRate: solUsd,
  };
}
