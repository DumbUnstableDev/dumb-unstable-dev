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

let _systemCache = null;
async function loadSystem() {
  if (_systemCache) return _systemCache;
  const base = await fs.readFile(
    path.resolve("src/prompts/system.md"),
    "utf8",
  );
  const examples = JSON.parse(
    await fs.readFile(path.resolve("src/prompts/examples.json"), "utf8"),
  );
  const exBlock = examples
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");
  _systemCache = base.replace("{{EXAMPLES}}", exBlock);
  return _systemCache;
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
