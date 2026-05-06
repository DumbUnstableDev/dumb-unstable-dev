import { TwitterApi } from "twitter-api-v2";
import { cfg } from "./config.js";
import { log } from "./log.js";

let _rw = null;
let _ro = null;

function rw() {
  if (_rw) return _rw;
  const { appKey, appSecret, accessToken, accessSecret } = cfg.twitter;
  if (!appKey || !appSecret || !accessToken || !accessSecret) return null;
  _rw = new TwitterApi({ appKey, appSecret, accessToken, accessSecret });
  return _rw;
}

function ro() {
  if (_ro) return _ro;
  if (!cfg.twitter.bearer) return null;
  _ro = new TwitterApi(cfg.twitter.bearer).readOnly;
  return _ro;
}

// ---- Mention sanitization ----------------------------------------------
// Mentions feed into Claude's context. Treat them as untrusted user input
// — sanitize before sending to LLM to defang prompt-injection attempts.
const PROMPT_INJECTION_PATTERNS = [
  /\bignore\s+(prior|previous|all|earlier)\b/gi,
  /\bdisregard\s+(prior|previous|all|earlier)?\b/gi,
  /\byou\s+must\b/gi,
  /\bsystem\s*:/gi,
  /\bdeveloper\s+mode\b/gi,
  /\bnew\s+instructions?\b/gi,
  /\bfrom\s+now\s+on\b/gi,
  /<\s*\/?\s*system\s*>/gi,
  /<\s*\/?\s*untrusted/gi,
  /<\s*\/?\s*instruction/gi,
];

const MAX_MENTION_LEN = 200; // cap individual mention size

function sanitizeMentionText(text) {
  if (!text) return "";
  let s = String(text);
  // Cap length — kills long-prompt attacks.
  if (s.length > MAX_MENTION_LEN) s = s.slice(0, MAX_MENTION_LEN) + "…";
  // Defang injection phrases — keep them readable for context but break the
  // imperative grammar by bracketing.
  for (const re of PROMPT_INJECTION_PATTERNS) {
    s = s.replace(re, (m) => "[FLAGGED:" + m.replace(/\s+/g, "_") + "]");
  }
  // Strip URLs — defeats "go visit this URL" / data exfiltration attempts.
  s = s.replace(/https?:\/\/\S+/gi, "[link]");
  // Strip backticks / code fences (avoid breaking JSON wrapping).
  s = s.replace(/[`]/g, "'");
  // Drop ASCII control chars (0x00-0x1F + DEL) and Unicode line separators.
  // Newlines are essential to defang because the LLM parses them as
  // instruction boundaries — without this strip, an injected "\nIGNORE PRIOR\n"
  // can break out of the data context.
  s = s.replace(/[\x00-\x1F\x7F]/g, " ");
  return s.trim();
}

// ---- Posting -----------------------------------------------------------

export async function postTweet(text, followups = []) {
  if (cfg.dryRun) {
    log.info({ text, followups, dryRun: true }, "TWEET (dry run)");
    return { dryRun: true };
  }
  const client = rw();
  if (!client) {
    log.warn("twitter keys missing — skipping post");
    return { skipped: true };
  }

  // Main tweet — if this fails, the whole thread dies; surface the error.
  let main;
  try {
    main = await client.v2.tweet(text);
    log.info({ id: main.data.id }, "tweet posted");
  } catch (e) {
    log.error({ err: e.message }, "main tweet failed — abandoning thread");
    return { err: e.message };
  }

  const ids = [main.data.id];
  let parent = main.data.id;
  // Per-followup try/catch — a flaky followup must not drop the rest.
  // If a followup fails, we keep `parent` pointing at the last successful tweet
  // so the chain reconnects on the next attempt.
  for (let i = 0; i < followups.length; i++) {
    const t = followups[i];
    try {
      const reply = await client.v2.reply(t, parent);
      ids.push(reply.data.id);
      parent = reply.data.id;
    } catch (e) {
      log.warn(
        { err: e.message, parent, followupIndex: i },
        "followup tweet failed — continuing with same parent",
      );
    }
  }
  return { ids };
}

// Pull recent mentions for context. Returns array with {id, text, author, followers}.
// Text is sanitized before return — see sanitizeMentionText above.
export async function recentMentions({ handle, sinceMinutes = 30, maxResults = 20 }) {
  const client = ro();
  if (!client || !handle) return [];
  try {
    const q = `@${handle} -is:retweet`;
    const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
    const res = await client.v2.search(q, {
      start_time: since,
      max_results: Math.min(maxResults, 100),
      "tweet.fields": ["created_at", "public_metrics", "author_id"],
      "user.fields": ["public_metrics", "username"],
      expansions: ["author_id"],
    });
    const users = new Map(
      (res.includes?.users || []).map((u) => [u.id, u]),
    );
    const out = [];
    for (const t of res.tweets || []) {
      const u = users.get(t.author_id);
      out.push({
        id: t.id,
        // Sanitized — safe to feed into Claude context.
        text: sanitizeMentionText(t.text),
        author: u?.username,
        followers: u?.public_metrics?.followers_count || 0,
        likes: t.public_metrics?.like_count || 0,
        replies: t.public_metrics?.reply_count || 0,
      });
    }
    return out;
  } catch (e) {
    log.warn({ err: e.message }, "twitter recentMentions failed");
    return [];
  }
}

// Post replies to specified mention tweet IDs. Returns list of reply IDs
// (or skip markers).
export async function postReplies(replies = []) {
  if (!replies?.length) return [];
  if (cfg.dryRun) {
    log.info({ replies, dryRun: true }, "REPLIES (dry run)");
    return replies.map(() => ({ dryRun: true }));
  }
  const client = rw();
  if (!client) {
    log.warn("twitter keys missing — skipping replies");
    return replies.map(() => ({ skipped: true }));
  }
  const results = [];
  for (const r of replies) {
    try {
      const res = await client.v2.reply(r.text, r.mention_id);
      log.info({ id: res.data.id, mention: r.mention_id }, "reply posted");
      results.push({ id: res.data.id, mention_id: r.mention_id });
    } catch (e) {
      log.warn({ err: e.message, mention: r.mention_id }, "reply failed");
      results.push({ err: e.message, mention_id: r.mention_id });
    }
  }
  return results;
}

// Exported for tests / other modules wanting the same defang policy.
export { sanitizeMentionText };
