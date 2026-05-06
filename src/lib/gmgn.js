// GMGN.ai Solana trading API adapter.
//
// Docs: https://docs.gmgn.ai/index/cooperation-api-integrate-gmgn-solana-trading-api
//
// Flow:
//   1. GET /defi/router/v1/sol/tx/get_swap_route → quote + raw_tx
//   2. Local sign with treasury keypair (Ed25519 via VersionedTransaction)
//   3. POST /txproxy/v1/send_transaction → submitted hash
//   4. Poll /defi/router/v1/sol/tx/get_transaction_status until confirmed
//
// Auth: `x-route-key` header. Rate limit: 1 call per 5s per key.
//
// Why GMGN over Jupiter for some flows:
//   - Anti-MEV (JITO bundles) — important for invests into thin pools.
//   - Faster route resolution for new pump.fun pairs.
// Tradeoffs:
//   - Adds dependency; their API down → trades fail.
//   - Tight rate limit (5s) — fine for our 30-min tick cadence.
//   - Trust GMGN's signed tx is what they advertise (we DO sign locally,
//     so they can't redirect funds — but a malicious tx body could still
//     spend more than expected; we should sanity-check `outputMint` matches
//     what we asked for before signing).

import { VersionedTransaction } from "@solana/web3.js";
import { request } from "undici";
import { log } from "../log.js";

const GMGN_BASE = "https://gmgn.ai";
// GMGN limits to 1 req / 5s per API key. We add a buffer to avoid edge bursts.
const RATE_LIMIT_MS = 5_500;
let _lastCallTs = 0;

async function rateLimit() {
  const since = Date.now() - _lastCallTs;
  if (since < RATE_LIMIT_MS) {
    const wait = RATE_LIMIT_MS - since;
    log.debug({ waitMs: wait }, "gmgn: rate-limit wait");
    await new Promise((r) => setTimeout(r, wait));
  }
  _lastCallTs = Date.now();
}

function apiKey() {
  const k = process.env.GMGN_API_KEY;
  if (!k) throw new Error("gmgn: GMGN_API_KEY not set");
  return k;
}

export function gmgnEnabled() {
  return !!process.env.GMGN_API_KEY;
}

async function gmgnFetch(path, { method = "GET", body, query } = {}) {
  await rateLimit();
  const qs = query
    ? "?" + new URLSearchParams(query).toString()
    : "";
  const url = `${GMGN_BASE}${path}${qs}`;
  const headers = { "x-route-key": apiKey() };
  if (body) headers["Content-Type"] = "application/json";

  const res = await request(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.body.json();
  } catch (e) {
    throw new Error(`gmgn ${path}: non-JSON response (status ${res.statusCode})`);
  }
  if (json.code !== 0) {
    throw new Error(`gmgn ${path}: code=${json.code} msg=${json.msg || "unknown"}`);
  }
  return json.data;
}

// ---- Public API -------------------------------------------------------

/**
 * Get a swap route + signed-ready transaction.
 * @param {Object} p
 * @param {string} p.inputMint
 * @param {string} p.outputMint
 * @param {string|number} p.inAmount  raw lamports/atomic-units
 * @param {string} p.fromAddress      pubkey base58
 * @param {number} p.slippagePct      e.g. 1.0 for 1%
 * @param {boolean} [p.isAntiMev]     defaults to true
 */
export async function getSwapRoute({
  inputMint,
  outputMint,
  inAmount,
  fromAddress,
  slippagePct = 1,
  isAntiMev = true,
}) {
  return gmgnFetch("/defi/router/v1/sol/tx/get_swap_route", {
    query: {
      token_in_address: inputMint,
      token_out_address: outputMint,
      in_amount: String(inAmount),
      from_address: fromAddress,
      slippage: String(slippagePct),
      is_anti_mev: String(!!isAntiMev),
    },
  });
}

/** Submit a locally-signed base64 tx for broadcast (with optional JITO bundle). */
export async function submitSwap({ signedTxBase64, isAntiMev = true }) {
  return gmgnFetch("/txproxy/v1/send_transaction", {
    method: "POST",
    body: { chain: "sol", signedTx: signedTxBase64, isAntiMev },
  });
}

/** Poll status by signature + lastValidBlockHeight. */
export async function getStatus({ hash, lastValidHeight }) {
  return gmgnFetch("/defi/router/v1/sol/tx/get_transaction_status", {
    query: { hash, last_valid_height: String(lastValidHeight) },
  });
}

/**
 * Full swap flow: route → sign → submit → poll until confirmed.
 * Treasury must be a Solana web3.js Keypair (cfg.treasury).
 *
 * Returns { sig, outAmount, provider }.
 */
export async function gmgnSwap({
  inputMint,
  outputMint,
  inAmount,
  slippageBps = 100,
  treasury,
}) {
  if (!treasury) throw new Error("gmgn: treasury keypair required");

  const route = await getSwapRoute({
    inputMint,
    outputMint,
    inAmount,
    fromAddress: treasury.publicKey.toBase58(),
    slippagePct: slippageBps / 100,
    isAntiMev: true,
  });

  // Sanity check: response MUST contain matching mints. Fail closed —
  // a missing or mismatched mint = refuse to sign anything (don't trust an
  // ambiguous response from a third-party signer).
  if (!route?.quote?.inputMint || route.quote.inputMint !== inputMint) {
    throw new Error(
      `gmgn: route inputMint missing or mismatched (got ${route?.quote?.inputMint || "<missing>"} vs ${inputMint})`,
    );
  }
  if (!route?.quote?.outputMint || route.quote.outputMint !== outputMint) {
    throw new Error(
      `gmgn: route outputMint missing or mismatched (got ${route?.quote?.outputMint || "<missing>"} vs ${outputMint})`,
    );
  }
  if (!route?.raw_tx?.swapTransaction) {
    throw new Error("gmgn: route response missing raw_tx.swapTransaction");
  }

  const txBuf = Buffer.from(route.raw_tx.swapTransaction, "base64");
  const vtx = VersionedTransaction.deserialize(txBuf);
  vtx.sign([treasury]);
  const signedTx = Buffer.from(vtx.serialize()).toString("base64");

  const submitted = await submitSwap({
    signedTxBase64: signedTx,
    isAntiMev: true,
  });
  const sig = submitted.hash;
  log.info(
    {
      sig,
      inputMint,
      outputMint,
      inAmount: String(inAmount),
      outAmount: route.quote.outAmount,
    },
    "gmgn: swap submitted",
  );

  // Poll up to 90s. `getStatus` itself awaits the 5.5s rate-limit gate, so
  // we don't add an explicit sleep here — that would double the wait and
  // we'd only get ~5 polls in 60s, often missing confirmation.
  const lastValidHeight = route.raw_tx.lastValidBlockHeight;
  const startTs = Date.now();
  const POLL_TIMEOUT_MS = 90_000;
  while (Date.now() - startTs < POLL_TIMEOUT_MS) {
    try {
      const status = await getStatus({ hash: sig, lastValidHeight });
      if (status?.success === true || status?.confirmed === true) {
        log.info({ sig }, "gmgn: confirmed");
        return {
          sig,
          outAmount: Number(route.quote.outAmount),
          provider: "gmgn",
        };
      }
      if (status?.expired === true) {
        throw new Error("gmgn: tx expired (last_valid_height passed)");
      }
      if (status?.failed === true || status?.err) {
        throw new Error(`gmgn: tx failed — ${status?.err || "unknown"}`);
      }
      // Otherwise still pending — keep polling.
    } catch (e) {
      // Non-fatal status-poll error; loop and retry until timeout.
      log.warn({ err: e.message, sig }, "gmgn: status-poll error, retrying");
    }
  }
  throw new Error(`gmgn: tx ${sig} not confirmed within ${POLL_TIMEOUT_MS}ms`);
}
