// Public transparency feed.
//
// On every tick / reply, the agent appends a sanitized record to a rolling
// in-memory buffer. Periodically the buffer is flushed to docs/feed.json
// (local) and pushed to a public GitHub repo via the Contents API.
//
// The website reads that public JSON file and renders the agent's
// decisions in a terminal-style live log.
//
// STEALTH HANDLING: while cfg.stealthMode is true, fields that could leak
// the contract address are omitted:
//   - tx_sig            (clicking solscan reveals treasury wallet → CA)
//   - wallet addresses
//   - token_mint
//   - pump.fun / dexscreener URLs
// On reveal (cfg.stealthMode = false) the feed automatically unlocks
// those fields. Historical entries get retro-enriched from memory.jsonl
// at next flush.
//
// Operationally idempotent: re-running flush with the same buffer is safe.
// GitHub push uses ETag-style sha matching to prevent concurrent overwrite.

import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { cfg } from "./config.js";
import { log } from "./log.js";

const FEED_PATH = path.resolve("docs/feed.json");
const MAX_ENTRIES = 200; // ring buffer cap

// In-memory state
let _buffer = null; // loaded on first append
let _lastPushedSha = null; // GitHub blob sha — for atomic update
let _dirty = false;

// --- Loading / persistence ----------------------------------------------

async function loadOrInit() {
  if (_buffer) return _buffer;
  try {
    const raw = await fs.readFile(FEED_PATH, "utf8");
    _buffer = JSON.parse(raw);
    log.info({ entries: _buffer.entries?.length || 0 }, "feed: loaded existing");
  } catch {
    _buffer = {
      stealth: cfg.stealthMode,
      agent: {
        ticker: cfg.tokenTicker,
        handle: cfg.twitterHandle || null,
      },
      treasury: null, // populated post-reveal
      uptime_start_iso:
        process.env.UPTIME_START_ISO || new Date().toISOString(),
      last_updated_iso: new Date().toISOString(),
      stats: {
        decisions_total: 0,
        by_action: {},
        sol_spent_total: 0,
        tokens_burned_total: 0,
      },
      entries: [],
    };
    await fs.mkdir(path.dirname(FEED_PATH), { recursive: true });
    _dirty = true; // ensure first flush writes the init state
    log.info("feed: initialized new buffer");
  }
  return _buffer;
}

// --- Sanitization for stealth -------------------------------------------

function sanitizeEntry(rawEntry) {
  // Always-safe fields
  const safe = {
    ts: rawEntry.ts,
    trigger: rawEntry.trigger,
    action: rawEntry.action,
    amount_sol: rawEntry.amount_sol ?? null,
    tokens: rawEntry.amount_tokens ?? null,
    confidence: rawEntry.confidence ?? null,
    tweet: rawEntry.tweet_text || rawEntry.tweet || null,
    rationale: rawEntry.rationale || rawEntry.rationale_private || null,
  };

  // Stealth-gated fields
  if (!cfg.stealthMode) {
    if (rawEntry.tx_sig) safe.tx_sig = rawEntry.tx_sig;
    if (rawEntry.target) safe.target_mint = rawEntry.target;
  }

  // Strip any sneaky leakage from rationale/tweet text during stealth
  if (cfg.stealthMode) {
    const mint = cfg.tokenMint?.toBase58();
    const treas = cfg.treasury?.publicKey?.toBase58?.();
    const scrub = (s) => {
      if (typeof s !== "string") return s;
      let out = s;
      if (mint) out = out.replaceAll(mint, "[mint]");
      if (treas) out = out.replaceAll(treas, "[wallet]");
      out = out.replace(/https?:\/\/pump\.fun\/coin\/\S+/gi, "[link]");
      out = out.replace(
        /https?:\/\/(www\.)?(solscan\.io|dexscreener\.com)\S+/gi,
        "[link]",
      );
      return out;
    };
    if (safe.tweet) safe.tweet = scrub(safe.tweet);
    if (safe.rationale) safe.rationale = scrub(safe.rationale);
  }

  return safe;
}

// --- Public API ---------------------------------------------------------

/**
 * Append a sanitized record of an agent decision to the public feed buffer.
 * Safe to call from anywhere; never throws — feed failures must not block
 * the main decision loop.
 */
export async function appendDecision(rawEntry) {
  try {
    const buf = await loadOrInit();
    const entry = sanitizeEntry({ ts: new Date().toISOString(), ...rawEntry });
    buf.entries.unshift(entry); // newest first
    if (buf.entries.length > MAX_ENTRIES) {
      buf.entries.length = MAX_ENTRIES;
    }
    buf.last_updated_iso = new Date().toISOString();
    buf.stealth = cfg.stealthMode;

    // Stats roll-up
    buf.stats.decisions_total += 1;
    buf.stats.by_action[entry.action] =
      (buf.stats.by_action[entry.action] || 0) + 1;
    if (entry.action !== "hold" && typeof entry.amount_sol === "number") {
      buf.stats.sol_spent_total = +(
        buf.stats.sol_spent_total + entry.amount_sol
      ).toFixed(6);
    }
    if (entry.action === "burn" && typeof entry.tokens === "number") {
      buf.stats.tokens_burned_total += entry.tokens;
    }

    _dirty = true;
  } catch (e) {
    log.warn({ err: e.message }, "feed: appendDecision failed (non-fatal)");
  }
}

/**
 * Flush in-memory buffer to disk. Cheap. Call before pushToGitHub.
 */
export async function flushToDisk() {
  if (!_buffer || !_dirty) return;
  try {
    await fs.mkdir(path.dirname(FEED_PATH), { recursive: true });
    await fs.writeFile(
      FEED_PATH,
      JSON.stringify(_buffer, null, 2),
      "utf8",
    );
    _dirty = false;
  } catch (e) {
    log.warn({ err: e.message }, "feed: flushToDisk failed (non-fatal)");
  }
}

/**
 * Push docs/feed.json to GitHub via Contents API.
 * Uses ETag-style sha matching for concurrency safety.
 * Returns true on success, false on failure (caller should retry next cycle).
 */
export async function pushToGitHub() {
  const repo = process.env.FEED_GITHUB_REPO;
  const filePath = process.env.FEED_GITHUB_PATH || "docs/feed.json";
  const branch = process.env.FEED_GITHUB_BRANCH || "main";
  const token = process.env.FEED_GITHUB_TOKEN;

  if (!repo || !token) {
    log.debug("feed: GitHub push skipped (FEED_GITHUB_REPO/TOKEN missing)");
    return false;
  }

  try {
    await loadOrInit(); // make sure _buffer is populated (fresh process case)
    await flushToDisk(); // ensure local is current
    const content = await fs.readFile(FEED_PATH, "utf8");

    // Get current SHA (if file exists) — required for update.
    const headRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`,
      { headers: { Authorization: `token ${token}` } },
    );
    let currentSha = null;
    if (headRes.status === 200) {
      const meta = await headRes.json();
      currentSha = meta.sha;
    } else if (headRes.status !== 404) {
      const text = await headRes.text();
      log.warn(
        { status: headRes.status, body: text.slice(0, 200) },
        "feed: HEAD failed",
      );
      return false;
    }

    // Skip push if content unchanged (compare hash to avoid empty commits)
    const localHash = crypto
      .createHash("sha1")
      .update("blob " + content.length + "\0" + content)
      .digest("hex");
    if (localHash === _lastPushedSha) {
      log.debug("feed: content unchanged since last push — skipping");
      return true;
    }

    const body = {
      message: `feed: ${_buffer.stats.decisions_total} decisions, ${_buffer.stats.sol_spent_total} SOL spent`,
      content: Buffer.from(content).toString("base64"),
      branch,
    };
    if (currentSha) body.sha = currentSha;

    const putRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filePath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!putRes.ok) {
      const text = await putRes.text();
      log.warn(
        { status: putRes.status, body: text.slice(0, 200) },
        "feed: PUT failed",
      );
      return false;
    }
    const result = await putRes.json();
    _lastPushedSha = localHash;
    log.info(
      { sha: result.content?.sha?.slice(0, 7), entries: _buffer.entries.length },
      "feed: pushed to GitHub",
    );
    return true;
  } catch (e) {
    log.warn({ err: e.message }, "feed: pushToGitHub failed");
    return false;
  }
}

/**
 * Convenience: flush + push. Called from index.js cron.
 */
export async function syncFeed() {
  await flushToDisk();
  await pushToGitHub();
}
