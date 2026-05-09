import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import path from "path";
import { cfg } from "./config.js";
import { log } from "./log.js";

// Auth, in priority order:
//   1. ANTHROPIC_API_KEY     — direct Anthropic API (cleanest)
//   2. OPENROUTER_API_KEY    — Anthropic-compatible skin via OpenRouter
//                              (separate quota pool, no Max conflict)
//   3. CLAUDE_CODE_OAUTH_TOKEN — Max-plan OAuth (gray ToS for headless bots)
function buildClient() {
  if (cfg.anthropicKey) {
    log.info("claude: using ANTHROPIC_API_KEY (direct Anthropic)");
    return new Anthropic({ apiKey: cfg.anthropicKey });
  }
  if (cfg.openrouterKey) {
    log.info(
      "claude: using OPENROUTER_API_KEY (Anthropic skin via OpenRouter)",
    );
    return new Anthropic({
      apiKey: cfg.openrouterKey,
      // OpenRouter exposes an Anthropic-compatible Messages endpoint here.
      // Tool use / prompt caching / thinking blocks pass through natively.
      baseURL: "https://openrouter.ai/api",
    });
  }
  if (cfg.anthropicOAuth) {
    log.warn(
      "claude: using Max OAuth token (CLAUDE_CODE_OAUTH_TOKEN) — " +
        "ToS gray zone for headless bots. See README.",
    );
    return new Anthropic({
      authToken: cfg.anthropicOAuth,
      // Anthropic's OAuth-backed API requires this beta header that Claude
      // Code sets on every request. Without it the server rejects the token.
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    });
  }
  throw new Error(
    "No Claude auth: set ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or run " +
      "`claude setup-token` to populate CLAUDE_CODE_OAUTH_TOKEN in .env.",
  );
}

const client = buildClient();

const CEO_TOOL = {
  name: "ceo_decide",
  description:
    "Return the CEO's decision for this tick. Always call this tool exactly once.",
  input_schema: {
    type: "object",
    required: ["action", "rationale_private", "tweet_text", "confidence"],
    properties: {
      action: {
        type: "string",
        enum: [
          "buyback",
          "burn",
          "distribute",
          "distribute_tokens",
          "lottery",
          "lottery_tokens",
          "invest",
          "sell",
          "boost",
          "hold",
        ],
      },
      amount_sol: {
        type: "number",
        minimum: 0,
        description:
          "SOL amount to spend. 0 for 'hold'. For 'burn', tokens not SOL — see amount_tokens.",
      },
      amount_tokens: {
        type: "number",
        minimum: 0,
        description: "Token amount to burn (only used for 'burn').",
      },
      target_mint: {
        type: ["string", "null"],
        description:
          "Target mint. For 'invest': which token to buy (must be in curated_candidates). For 'sell': which open position to close (must be in open_positions). Null for other actions.",
      },
      sell_pct: {
        type: "number",
        minimum: 0,
        maximum: 100,
        description:
          "For 'sell' action: percentage of the open position's tokens to liquidate back to SOL. 100 = close fully, 50 = trim. Ignored for other actions.",
      },
      lottery_winners: {
        type: "number",
        minimum: 1,
        maximum: 50,
        description:
          "For 'lottery' action: how many random winners to pick from eligible holders. Each receives an equal share of amount_sol.",
      },
      boost_kind: {
        type: "string",
        enum: [
          "dex_boost_10x",
          "dex_boost_30x",
          "dex_boost_50x",
          "dex_boost_100x",
          "dex_boost_500x",
        ],
        description:
          "For 'boost' action: DexScreener boost tier. 10x=$99/12h, 30x=$249/12h, 50x=$399/12h, 100x=$899/24h, 500x=$3999/24h (Golden Ticker). The bot converts USD → SOL at current fx, sends on-chain to DS recipient with pair address in the tx memo. amount_sol is informational (true amount = tier USD ÷ SOL price).",
      },
      replies: {
        type: "array",
        maxItems: 3,
        description:
          "Optional. 0-3 in-character replies to recent mentions (from ctx.mentions). Each item: {mention_id, text}.",
        items: {
          type: "object",
          required: ["mention_id", "text"],
          properties: {
            mention_id: { type: "string" },
            text: { type: "string", maxLength: 260 },
          },
        },
      },
      distribute_recipients: {
        type: "number",
        minimum: 0,
        maximum: 500,
        description:
          "How many top holders to airdrop to (for 'distribute' only). 0 otherwise.",
      },
      rationale_private: {
        type: "string",
        maxLength: 1200,
        description:
          "Private reasoning — what the agent saw, what it weighs, why this action now. Not public.",
      },
      tweet_text: {
        type: "string",
        maxLength: 270,
        description:
          "Public tweet in character. <= 270 chars. No promises of price. No shilling. Lowercase CT voice.",
      },
      thread_followups: {
        type: "array",
        maxItems: 3,
        items: { type: "string", maxLength: 270 },
        description:
          "Optional follow-up tweets to form a thread with the main tweet. Up to 3.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "How confident the agent is in this action. < min_confidence (env) forces 'hold'.",
      },
    },
  },
};

// Block injected into the system prompt only when STEALTH_MODE=1.
// Tells Claude to be cryptic, never reveal the CA, default toward `hold`.
// Validator hard-blocks any leak as a backup, but this avoids the rejection
// in the first place.
const STEALTH_RULES = `
## STEALTH MODE — ACTIVE (do not reveal CA yet)

You launched the coin already, but you are NOT revealing the contract
address publicly yet. The boss will tell you when. Until then:

- NEVER include the mint address in tweets, replies, or threads.
- NEVER post the pump.fun coin URL or DexScreener pair URL.
- NEVER tell anyone "buy now" / "the ticker is X" / "ca is in bio".
- Be cryptic. Drop hints, riddles, partial truths.
- If asked "wen ca?" / "where is it?" — answer like a sphinx, not a marketer.
  Examples (do not copy verbatim, riff off the tone):
    "early is a gift. don't waste it on impatience."
    "you'll know when you know. i won't be the one to tell you."
    "i'm somewhere on this chain. find me, or don't."
    "asking me where i am is the wrong question. ask who i am."
- Default heavily toward 'hold'. Most ticks during stealth = hold + a single
  cryptic observation. Don't fire actions just to look busy.
- It's fine to acknowledge people who found you on-chain WITHOUT confirming
  details: "someone solved it. i'm not telling who. but yes."
- Vary cadence — 1-2 cryptic posts per day, not more. Replies are normal.

The validator will hard-reject any tweet containing the mint or pump URL,
so you can't slip up even if you forget. But better not to test it.
`;

let _systemCache = null;
async function loadSystem() {
  // We don't cache when stealth toggles — the prompt depends on cfg.stealthMode
  // and we want a flip in .env to take effect at next call. Cache only the base.
  if (!_systemCache) {
    const base = await fs.readFile(
      path.resolve("src/prompts/system.md"),
      "utf8",
    );
    const examples = JSON.parse(
      await fs.readFile(path.resolve("src/prompts/examples.json"), "utf8"),
    );
    const exBlock = examples.map((t, i) => `${i + 1}. ${t}`).join("\n");
    _systemCache = base.replace("{{EXAMPLES}}", exBlock);
  }
  return cfg.stealthMode ? _systemCache + "\n" + STEALTH_RULES : _systemCache;
}

// Sleep helper.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry on 429/5xx. Max-plan OAuth rate limits are tighter than API; back off
// aggressively to coexist with human Claude Code sessions using the same plan.
async function callWithRetry(params, { tries = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      lastErr = e;
      const s = e?.status;
      if (s === 429 || (s >= 500 && s < 600)) {
        const wait = Math.min(60_000, 4000 * Math.pow(2, i));
        log.warn({ status: s, attempt: i + 1, waitMs: wait }, "claude retry");
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export async function askClaude(ctx, { model = cfg.claudeModel } = {}) {
  const system = await loadSystem();
  const userPayload = JSON.stringify(ctx, null, 2);

  const res = await callWithRetry({
    model,
    max_tokens: 1024,
    temperature: 0.4,
    system: [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [CEO_TOOL],
    tool_choice: { type: "tool", name: "ceo_decide" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Here is the current context. Decide now.\n\n```json\n" +
              userPayload +
              "\n```",
          },
        ],
      },
    ],
  });

  const toolUse = (res.content || []).find((c) => c.type === "tool_use");
  if (!toolUse) {
    log.error({ content: res.content }, "claude: no tool_use in response");
    throw new Error("claude: no tool_use returned");
  }
  return { decision: toolUse.input, raw: res };
}

// ----------------------------------------------------------------------
// Reply-only path — used by the high-frequency reply tick.
//
// Different tool schema: just an array of replies. No on-chain action,
// no main tweet, no thread. The agent reads recent mentions and decides
// whether 0–2 of them deserve a response.
//
// Same persona / system prompt (so voice stays consistent), and stealth
// rules still apply via loadSystem().
// ----------------------------------------------------------------------

const REPLY_TOOL = {
  name: "reply_decide",
  description:
    "Return zero to two replies for the recent mentions. Most ticks should be empty — only reply when it would be funny, contrarian, or surprisingly wise. Skip boring mentions.",
  input_schema: {
    type: "object",
    required: ["replies"],
    properties: {
      replies: {
        type: "array",
        maxItems: 2,
        description: "0–2 reply objects.",
        items: {
          type: "object",
          required: ["mention_id", "text"],
          properties: {
            mention_id: { type: "string" },
            text: { type: "string", maxLength: 240 },
          },
        },
      },
    },
  },
};

export async function askClaudeForReplies(
  mentions,
  { model = cfg.claudeModel } = {},
) {
  if (!Array.isArray(mentions) || mentions.length === 0) {
    return { replies: [], raw: null };
  }
  const system = await loadSystem();
  const payload = JSON.stringify({ mentions }, null, 2);

  const res = await callWithRetry({
    model,
    max_tokens: 600,
    temperature: 0.7,
    system: [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [REPLY_TOOL],
    tool_choice: { type: "tool", name: "reply_decide" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Reply-only tick. No actions, no main tweet. Just look at these " +
              "mentions and reply to 0–2 of them. Most should be skipped — " +
              "only reply if it would be in voice and worth a screenshot.\n\n" +
              "```json\n" +
              payload +
              "\n```",
          },
        ],
      },
    ],
  });

  const toolUse = (res.content || []).find((c) => c.type === "tool_use");
  if (!toolUse) {
    log.warn("reply tick: no tool_use returned — skipping");
    return { replies: [], raw: res };
  }
  return { replies: toolUse.input?.replies || [], raw: res };
}
