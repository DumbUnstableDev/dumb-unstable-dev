import { promises as fs } from "fs";
import path from "path";

const FILE = path.resolve("state/memory.jsonl");

export async function appendAction(entry) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
  await fs.appendFile(FILE, line, "utf8");
}

export async function readRecent(n = 50) {
  try {
    const txt = await fs.readFile(FILE, "utf8");
    const lines = txt.split("\n").filter(Boolean);
    return lines
      .slice(-n)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

export async function summarize24h() {
  const recent = await readRecent(200);
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const last24 = recent.filter((r) => r.ts >= cutoff);
  const counts = {};
  let spent = 0;
  for (const r of last24) {
    counts[r.action] = (counts[r.action] || 0) + 1;
    if (r.status === "executed" && r.amount_sol) spent += r.amount_sol;
  }
  return {
    total: last24.length,
    counts,
    spentSol: spent,
    lastAction: last24[last24.length - 1] || null,
  };
}

export async function countActionsInWindow(minutes) {
  const recent = await readRecent(200);
  const cutoff = Date.now() - minutes * 60 * 1000;
  return recent.filter((r) => r.ts >= cutoff && r.status === "executed").length;
}

export async function lastExecutedAt() {
  const recent = await readRecent(50);
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].status === "executed") return recent[i].ts;
  }
  return 0;
}

// --- Position tracking (for multi-token trading) ------------------------
// Positions aren't stored separately — they're reconstructed from the log
// (invest opens, sell closes). This keeps one source of truth.

export async function openPositions() {
  const all = await readRecent(500);
  const open = new Map(); // mint -> {mint, entryTs, entrySolSpent, entryAmountTokens}

  for (const r of all) {
    if (r.status !== "executed") continue;
    if (r.action === "invest" && r.target) {
      open.set(r.target, {
        mint: r.target,
        openedAt: r.ts,
        solSpent: r.amount_sol || 0,
        tokensAcquired: r.amount_tokens || null,
        entryPriceUsd: r.entry_price_usd || null,
        tx: r.tx_sig || null,
      });
    }
    if (r.action === "sell" && r.target) {
      open.delete(r.target);
    }
  }
  return [...open.values()];
}

// True if a given mint is in our current open positions.
export async function hasOpenPosition(mint) {
  const list = await openPositions();
  return list.some((p) => p.mint === mint);
}
