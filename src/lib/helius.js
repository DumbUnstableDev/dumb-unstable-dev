import { request } from "undici";
import { cfg } from "../config.js";
import { log } from "../log.js";

const HELIUS_RPC = () =>
  cfg.heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${cfg.heliusKey}` : null;

const BASE_V0 = "https://api.helius.xyz/v0";

async function rpc(method, params) {
  const url = HELIUS_RPC();
  if (!url) return null;
  const { body } = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await body.json();
  if (data.error) throw new Error(`${method}: ${data.error.message}`);
  return data.result;
}

// --- Holders (paged DAS) -------------------------------------------------

// Returns ALL holders (paged) of a mint, as Map<owner, uiAmount>.
export async function snapshotHolders(mint, { minUi = 0 } = {}) {
  const out = new Map();
  if (!cfg.heliusKey) {
    log.warn("HELIUS_API_KEY missing — skipping holder snapshot");
    return out;
  }
  let cursor;
  let pages = 0;
  while (true) {
    const res = await rpc("getTokenAccounts", {
      mint,
      limit: 1000,
      cursor,
      options: { showZeroBalance: false },
    });
    const items = res?.token_accounts || [];
    for (const a of items) {
      const dec = a.decimals ?? 6;
      const ui = Number(a.amount) / 10 ** dec;
      if (ui < minUi) continue;
      out.set(a.owner, (out.get(a.owner) || 0) + ui);
    }
    if (!res?.cursor || items.length === 0) break;
    cursor = res.cursor;
    if (++pages > 50) break; // safety: 50k holders cap
  }
  return out;
}

// Short top-10 view (cheap) for context payload.
export async function getHolders(mint, limit = 1000) {
  if (!cfg.heliusKey) return [];
  try {
    const res = await rpc("getTokenAccounts", {
      mint,
      page: 1,
      limit,
      options: { showZeroBalance: false },
    });
    const accounts = res?.token_accounts || [];
    return accounts.map((a) => ({
      owner: a.owner,
      amount: Number(a.amount),
      decimals: a.decimals ?? 6,
    }));
  } catch (e) {
    log.warn({ err: e.message, mint }, "helius getHolders failed");
    return [];
  }
}

export async function getHolderStats(mint, exclude = []) {
  const map = await snapshotHolders(mint);
  const excludeSet = new Set(exclude);
  const entries = [...map.entries()].filter(([o]) => !excludeSet.has(o));
  if (!entries.length) return { holderCount: 0, top10Pct: 0, top50Pct: 0, totalUi: 0, top50: [] };
  entries.sort((a, b) => b[1] - a[1]);
  const totalUi = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const top10 = entries.slice(0, 10).reduce((s, [, v]) => s + v, 0);
  const top50 = entries.slice(0, 50).reduce((s, [, v]) => s + v, 0);
  return {
    holderCount: entries.length,
    top10Pct: (top10 / totalUi) * 100,
    top50Pct: (top50 / totalUi) * 100,
    totalUi,
    top50: entries.slice(0, 50).map(([owner, ui]) => ({ owner, ui })),
  };
}

// --- Balances -----------------------------------------------------------

export async function getSolBalance(pubkey) {
  const r = await rpc("getBalance", [pubkey]);
  return (r?.value || 0) / 1e9;
}

export async function getSplBalance(owner, mint) {
  const r = await rpc("getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed" },
  ]);
  let total = 0;
  for (const acc of r?.value || []) {
    total += Number(acc.account.data.parsed.info.tokenAmount.uiAmount || 0);
  }
  return total;
}

// --- Recent activity ---------------------------------------------------

export async function recentTransactions(address, limit = 20) {
  if (!cfg.heliusKey) return [];
  const url = `${BASE_V0}/addresses/${address}/transactions?api-key=${cfg.heliusKey}&limit=${limit}`;
  try {
    const { body } = await request(url);
    const data = await body.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    log.warn({ err: e.message }, "helius recentTransactions failed");
    return [];
  }
}
