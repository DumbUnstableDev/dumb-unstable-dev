// Unified trading provider — picks GMGN or Jupiter based on env.
//
//   TRADING_PROVIDER=jupiter  (default)  → on-chain Jupiter Aggregator
//   TRADING_PROVIDER=gmgn                → GMGN.ai (anti-MEV, rate-limited)
//
// Falls back to Jupiter automatically if GMGN is selected but no key is set.

import { connection } from "../config.js";
import { log } from "../log.js";
import { getQuote, buildSwapTx } from "./jupiter.js";
import { gmgnSwap, gmgnEnabled } from "./gmgn.js";

function selectProvider() {
  const want = (process.env.TRADING_PROVIDER || "jupiter").toLowerCase();
  if (want === "gmgn") {
    if (!gmgnEnabled()) {
      log.warn(
        "trade: TRADING_PROVIDER=gmgn but GMGN_API_KEY missing — falling back to Jupiter",
      );
      return "jupiter";
    }
    return "gmgn";
  }
  return "jupiter";
}

/**
 * Swap inputMint -> outputMint, signed by `treasury` keypair.
 *
 * @param {Object} p
 * @param {string} p.inputMint
 * @param {string} p.outputMint
 * @param {number|bigint|string} p.amountLamports  raw atomic units of inputMint
 * @param {number} [p.slippageBps]
 * @param {Keypair} p.treasury
 * @returns {Promise<{ sig: string, outAmount: number, provider: 'jupiter' | 'gmgn' }>}
 */
export async function swap({
  inputMint,
  outputMint,
  amountLamports,
  slippageBps = 100,
  treasury,
}) {
  const provider = selectProvider();

  if (provider === "gmgn") {
    return gmgnSwap({
      inputMint,
      outputMint,
      inAmount: amountLamports,
      slippageBps,
      treasury,
    });
  }

  // ---- Jupiter path ----
  const quote = await getQuote({
    inputMint,
    outputMint,
    amount: amountLamports,
    slippageBps,
  });
  const vtx = await buildSwapTx(quote, treasury.publicKey.toBase58());
  vtx.sign([treasury]);
  const conn = connection();
  const sig = await conn.sendTransaction(vtx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await conn.confirmTransaction(sig, "confirmed");
  log.info(
    {
      sig,
      provider: "jupiter",
      inputMint,
      outputMint,
      outAmount: quote.outAmount,
    },
    "jupiter: swap confirmed",
  );
  return {
    sig,
    outAmount: Number(quote.outAmount),
    provider: "jupiter",
  };
}

export function activeProvider() {
  return selectProvider();
}
