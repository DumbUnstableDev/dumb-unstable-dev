// Twitter (X) integration — hybrid auth.
//
// Auth priority:
//   1. Cookie auth via agent-twitter-client (TWITTER_AUTH_TOKEN + TWITTER_CT0)
//      → free, gray-zone, account-suspension risk. Preferred for budget bots.
//   2. Official API v2 via twitter-api-v2 (TWITTER_APP_KEY + secrets)
//      → paid ($200/mo for Basic), stable, white-listed.
//
// External contract (used by index.js / context.js) is unchanged:
//   postTweet(text, followups)         → { ids: [...], dryRun?, err?, skipped? }
//   recentMentions({ handle, ... })    → [{ id, text, author, followers, ... }]
//   postReplies(replies)               → [{ id, mention_id } | { err, ... }]
//
// All return shapes are the same regardless of which path was taken,
// so downstream code (memory.js, index.js) doesn't care.

import { TwitterApi } from "twitter-api-v2";
import { Scraper, SearchMode } from "agent-twitter-client";
import { cfg } from "./config.js";
import { log } from "./log.js";

// ---- Auth-mode detection ------------------------------------------------

function cookieAuthAvailable() {
  return !!(cfg.twitterCookies?.authToken && cfg.twitterCookies?.ct0);
}

// ---- Cookie-mode (agent-twitter-client) ---------------------------------

let _scraper = null;
let _scraperReady = false;
let _scraperPromise = null;

async function scraper() {
  if (_scraperReady) return _scraper;
  if (!cookieAuthAvailable()) return null;
  // Concurrent callers share the same init promise.
  if (_scraperPromise) return _scraperPromise;
  _scraperPromise = (async () => {
    // Two upstream-library quirks we patch via the `transform` hook:
    //
    // 1. agent-twitter-client@0.0.18 hardcodes a bearer Twitter has since
    //    rotated → every authenticated request 401s. We swap it for the
    //    current public web bearer (same one twitter.com itself uses).
    //
    // 2. The library doesn't set User-Agent. Twitter's CDN 404s requests
    //    coming from default node UA strings. We force a Chrome UA.
    const CURRENT_BEARER =
      "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
    const UA =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    const s = new Scraper({
      transform: {
        request: async (url, init) => {
          const h = new Headers(init?.headers || {});
          if (h.get("authorization")?.startsWith("Bearer ")) {
            h.set("authorization", `Bearer ${CURRENT_BEARER}`);
          }
          h.set("user-agent", UA);
          return [url, { ...init, headers: h }];
        },
      },
    });
    const { authToken, ct0 } = cfg.twitterCookies;
    // agent-twitter-client hits twitter.com (not x.com) for all GraphQL calls,
    // and its tough-cookie jar rejects .x.com entries when the host is
    // twitter.com. So we only set .twitter.com domain.
    const cookies = [
      `auth_token=${authToken}; Domain=.twitter.com; Path=/; Secure; HttpOnly`,
      `ct0=${ct0}; Domain=.twitter.com; Path=/; Secure`,
    ];
    await s.setCookies(cookies);
    // CRITICAL second patch: sendTweet/sendReply DO NOT go through
    // the transform hook above — they build their own headers manually
    // using `auth.bearerToken` directly. So we have to mutate the auth
    // instance after setCookies populates it. Without this, posting 401s
    // even though reads work.
    s.auth.bearerToken = CURRENT_BEARER;
    if (s.authTrends) s.authTrends.bearerToken = CURRENT_BEARER;
    // NOTE: agent-twitter-client@0.0.18's isLoggedIn() probes v1.1
    // /account/verify_credentials.json which Twitter has deprecated for
    // cookie-only auth (returns code 34 "page does not exist") — useless
    // as a readiness check. Instead we hit a GraphQL profile lookup which
    // is what the bot actually uses for posting/reading anyway.
    const username = cfg.twitterCookies.username;
    if (username) {
      try {
        const profile = await s.getProfile(username);
        if (!profile?.username) {
          log.warn("twitter cookie auth: profile probe returned empty");
          return null;
        }
      } catch (e) {
        log.warn({ err: e.message }, "twitter cookie auth: profile probe failed — cookies may be expired");
        return null;
      }
    }
    _scraper = s;
    _scraperReady = true;
    log.info({ username: username || "(unknown)" }, "twitter: cookie auth ready");
    return _scraper;
  })().catch((e) => {
    log.warn({ err: e.message }, "twitter cookie auth init failed");
    return null;
  });
  return _scraperPromise;
}

// agent-twitter-client's sendTweet returns a raw fetch Response. We have to
// dig the new tweet's id out of the GraphQL body.
async function extractTweetId(res) {
  if (!res) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  return (
    body?.data?.create_tweet?.tweet_results?.result?.rest_id ||
    body?.data?.create_tweet?.tweet_results?.result?.legacy?.id_str ||
    null
  );
}

async function postTweetCookie(text, followups = []) {
  const s = await scraper();
  if (!s) return null;

  let main;
  try {
    const res = await s.sendTweet(text);
    main = await extractTweetId(res);
    if (!main) {
      log.error("cookie tweet posted but no rest_id returned — possibly rate-limited");
      return { err: "no_rest_id" };
    }
    log.info({ id: main }, "cookie tweet posted");
  } catch (e) {
    log.error({ err: e.message }, "cookie main tweet failed");
    return { err: e.message };
  }

  const ids = [main];
  let parent = main;
  for (let i = 0; i < followups.length; i++) {
    const t = followups[i];
    try {
      const res = await s.sendTweet(t, parent);
      const id = await extractTweetId(res);
      if (id) {
        ids.push(id);
        parent = id;
      } else {
        log.warn({ followupIndex: i }, "cookie followup: no rest_id");
      }
    } catch (e) {
      log.warn(
        { err: e.message, parent, followupIndex: i },
        "cookie followup failed — keeping parent",
      );
    }
  }
  return { ids };
}

async function recentMentionsCookie({ handle, sinceMinutes = 30, maxResults = 20 }) {
  const s = await scraper();
  if (!s || !handle) return [];
  try {
    // Twitter has no time-window param on search-the-web-style endpoints,
    // so we over-fetch and filter by created_at locally.
    const cutoff = Date.now() - sinceMinutes * 60 * 1000;
    const q = `@${handle} -filter:retweets`;
    const fetchN = Math.min(maxResults * 3, 100);
    const result = await s.fetchSearchTweets(q, fetchN, SearchMode.Latest);
    const out = [];
    for (const t of result?.tweets || []) {
      const ts = t.timeParsed ? new Date(t.timeParsed).getTime() : Date.now();
      if (ts < cutoff) continue;
      out.push({
        id: t.id,
        text: sanitizeMentionText(t.text || ""),
        author: t.username,
        followers: 0, // not surfaced by this endpoint; left at 0 (downstream tolerates)
        likes: t.likes || 0,
        replies: t.replies || 0,
      });
      if (out.length >= maxResults) break;
    }
    return out;
  } catch (e) {
    log.warn({ err: e.message }, "twitter cookie recentMentions failed");
    return [];
  }
}

async function postRepliesCookie(replies = []) {
  const s = await scraper();
  if (!s) return null;
  const out = [];
  for (const r of replies) {
    try {
      const res = await s.sendTweet(r.text, r.mention_id);
      const id = await extractTweetId(res);
      if (id) {
        log.info({ id, mention: r.mention_id }, "cookie reply posted");
        out.push({ id, mention_id: r.mention_id });
      } else {
        log.warn({ mention: r.mention_id }, "cookie reply: no rest_id");
        out.push({ err: "no_rest_id", mention_id: r.mention_id });
      }
    } catch (e) {
      log.warn({ err: e.message, mention: r.mention_id }, "cookie reply failed");
      out.push({ err: e.message, mention_id: r.mention_id });
    }
  }
  return out;
}

// ---- API-mode (twitter-api-v2) — fallback only --------------------------

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

const MAX_MENTION_LEN = 200;

function sanitizeMentionText(text) {
  if (!text) return "";
  let s = String(text);
  if (s.length > MAX_MENTION_LEN) s = s.slice(0, MAX_MENTION_LEN) + "…";
  for (const re of PROMPT_INJECTION_PATTERNS) {
    s = s.replace(re, (m) => "[FLAGGED:" + m.replace(/\s+/g, "_") + "]");
  }
  s = s.replace(/https?:\/\/\S+/gi, "[link]");
  s = s.replace(/[`]/g, "'");
  s = s.replace(/[\x00-\x1F\x7F]/g, " ");
  return s.trim();
}

// ---- Public API (auth-agnostic) -----------------------------------------

export async function postTweet(text, followups = []) {
  if (cfg.dryRun) {
    log.info({ text, followups, dryRun: true }, "TWEET (dry run)");
    return { dryRun: true };
  }

  // Cookie path first.
  if (cookieAuthAvailable()) {
    const r = await postTweetCookie(text, followups);
    if (r) return r;
    log.warn("cookie post failed/unavailable — falling back to API");
  }

  // API fallback.
  const client = rw();
  if (!client) {
    log.warn("twitter: no auth (cookies or api) — skipping post");
    return { skipped: true };
  }

  let main;
  try {
    main = await client.v2.tweet(text);
    log.info({ id: main.data.id }, "api tweet posted");
  } catch (e) {
    log.error({ err: e.message }, "api main tweet failed");
    return { err: e.message };
  }

  const ids = [main.data.id];
  let parent = main.data.id;
  for (let i = 0; i < followups.length; i++) {
    const t = followups[i];
    try {
      const reply = await client.v2.reply(t, parent);
      ids.push(reply.data.id);
      parent = reply.data.id;
    } catch (e) {
      log.warn(
        { err: e.message, parent, followupIndex: i },
        "api followup failed — keeping parent",
      );
    }
  }
  return { ids };
}

export async function recentMentions({ handle, sinceMinutes = 30, maxResults = 20 }) {
  if (cookieAuthAvailable()) {
    return recentMentionsCookie({ handle, sinceMinutes, maxResults });
  }
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
    const users = new Map((res.includes?.users || []).map((u) => [u.id, u]));
    const out = [];
    for (const t of res.tweets || []) {
      const u = users.get(t.author_id);
      out.push({
        id: t.id,
        text: sanitizeMentionText(t.text),
        author: u?.username,
        followers: u?.public_metrics?.followers_count || 0,
        likes: t.public_metrics?.like_count || 0,
        replies: t.public_metrics?.reply_count || 0,
      });
    }
    return out;
  } catch (e) {
    log.warn({ err: e.message }, "api recentMentions failed");
    return [];
  }
}

export async function postReplies(replies = []) {
  if (!replies?.length) return [];
  if (cfg.dryRun) {
    log.info({ replies, dryRun: true }, "REPLIES (dry run)");
    return replies.map(() => ({ dryRun: true }));
  }

  if (cookieAuthAvailable()) {
    const r = await postRepliesCookie(replies);
    if (r) return r;
    log.warn("cookie replies failed — falling back to API");
  }

  const client = rw();
  if (!client) {
    log.warn("twitter: no auth (cookies or api) — skipping replies");
    return replies.map(() => ({ skipped: true }));
  }
  const results = [];
  for (const r of replies) {
    try {
      const res = await client.v2.reply(r.text, r.mention_id);
      log.info({ id: res.data.id, mention: r.mention_id }, "api reply posted");
      results.push({ id: res.data.id, mention_id: r.mention_id });
    } catch (e) {
      log.warn({ err: e.message, mention: r.mention_id }, "api reply failed");
      results.push({ err: e.message, mention_id: r.mention_id });
    }
  }
  return results;
}

// Exported for tests / other modules wanting the same defang policy.
export { sanitizeMentionText };
