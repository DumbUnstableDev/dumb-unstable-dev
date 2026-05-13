import dotenv from "dotenv";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import bs58 from "bs58";

// Override system env vars — Claude Code (and other dev envs) set ANTHROPIC_API_KEY=""
// which would otherwise silently win over our .env file.
dotenv.config({ override: true });

const req = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};
const opt = (k, d) => {
  const v = process.env[k];
  return v == null || v === "" ? d : v;
};
const bool = (k, d) => {
  const v = process.env[k];
  if (v == null) return d;
  return v === "1" || v.toLowerCase() === "true";
};
const num = (k, d) => {
  const v = process.env[k];
  return v == null ? d : Number(v);
};

function loadKeypair() {
  const sk = process.env.TREASURY_SECRET_KEY;
  if (!sk) return null;
  return Keypair.fromSecretKey(bs58.decode(sk));
}

export const cfg = {
  tokenMint: process.env.TOKEN_MINT ? new PublicKey(process.env.TOKEN_MINT) : null,
  tokenTicker: opt("TOKEN_TICKER", "CEO"),
  personaName: opt("AGENT_PERSONA_NAME", "$CEO"),
  twitterHandle: opt("TWITTER_HANDLE", ""),

  rpcUrl: opt("RPC_URL", "https://api.mainnet-beta.solana.com"),
  treasury: loadKeypair(),

  // Three auth paths for Claude. Picked in this priority order by `claude.js`:
  //   1. ANTHROPIC_API_KEY  — direct Anthropic API (cleanest)
  //   2. OPENROUTER_API_KEY — Anthropic-compatible skin via OpenRouter
  //                           (separate quota pool, OpenAI-style billing)
  //   3. CLAUDE_CODE_OAUTH_TOKEN — Max subscription via `claude setup-token`
  //                                (gray-zone ToS; conflicts with your chats)
  anthropicKey: opt("ANTHROPIC_API_KEY", ""),
  openrouterKey: opt("OPENROUTER_API_KEY", ""),
  anthropicOAuth: opt("CLAUDE_CODE_OAUTH_TOKEN", ""),
  // OpenRouter routes by `provider/model` (e.g. `anthropic/claude-sonnet-4-5`).
  // We auto-prefix when OpenRouter is the active provider so existing CLAUDE_MODEL
  // values (which are bare Anthropic names) keep working unchanged.
  claudeModel: (() => {
    const m = opt("CLAUDE_MODEL", "claude-sonnet-4-5");
    const useOpenRouter =
      !process.env.ANTHROPIC_API_KEY && !!process.env.OPENROUTER_API_KEY;
    return useOpenRouter && !m.includes("/") ? `anthropic/${m}` : m;
  })(),
  claudeModelDeep: (() => {
    const m = opt("CLAUDE_MODEL_DEEP", "claude-opus-4-7");
    const useOpenRouter =
      !process.env.ANTHROPIC_API_KEY && !!process.env.OPENROUTER_API_KEY;
    return useOpenRouter && !m.includes("/") ? `anthropic/${m}` : m;
  })(),

  twitter: {
    appKey: opt("TWITTER_APP_KEY", ""),
    appSecret: opt("TWITTER_APP_SECRET", ""),
    accessToken: opt("TWITTER_ACCESS_TOKEN", ""),
    accessSecret: opt("TWITTER_ACCESS_SECRET", ""),
    bearer: opt("TWITTER_BEARER_TOKEN", ""),
  },
  // Cookie-auth path (free, via agent-twitter-client). When both authToken
  // and ct0 are set, twitter.js prefers this over the official API.
  twitterCookies: {
    authToken: opt("TWITTER_AUTH_TOKEN", ""),
    ct0: opt("TWITTER_CT0", ""),
    username: opt("TWITTER_USERNAME", ""),
  },

  heliusKey: opt("HELIUS_API_KEY", ""),
  pumpportalWs: opt("PUMPPORTAL_WS", "wss://pumpportal.fun/api/data"),
  dexscreenerBase: opt("DEXSCREENER_BASE", "https://api.dexscreener.com"),

  rails: {
    maxSolPctPerAction: num("MAX_SOL_PCT_PER_ACTION", 0.2),
    maxActionsPerDay: num("MAX_ACTIONS_PER_DAY", 12),
    cooldownMinutes: num("COOLDOWN_MINUTES", 20),
    minConfidence: num("MIN_CONFIDENCE", 0.55),
    drawdownHaltPct: num("DRAWDOWN_HALT_PCT", 0.3),
  },

  paused: bool("AGENT_PAUSED", false),
  dryRun: bool("DRY_RUN", true),
  manualApproval: bool("MANUAL_APPROVAL", true),
  logLevel: opt("LOG_LEVEL", "info"),
  tickCron: opt("TICK_CRON", "0 * * * *"),
  replyCron: opt("REPLY_CRON", "*/15 * * * *"),
  feedCron: opt("FEED_CRON", "*/5 * * * *"),

  // Stealth-launch flag. When true:
  //   - validator hard-blocks tweets/replies containing the mint or
  //     pump.fun/coin/<mint> link
  //   - claude.js injects extra cryptic-mode rules into the system prompt
  //   - decisions tend toward `hold` more (mostly cryptic musings, not actions)
  stealthMode: bool("STEALTH_MODE", false),

  // Auto-boost trigger — when treasury accumulates AT_SOL, automatically
  // transfer that amount to BOOST_PAYMENT_WALLET (step-bro) for manual DS
  // Boost purchase. Cooldown'd to prevent repeated firing.
  autoBoost: {
    enabled: bool("AUTO_BOOST_ENABLED", true),
    thresholdSol: num("AUTO_BOOST_AT_SOL", 3),
    cooldownHours: num("AUTO_BOOST_COOLDOWN_HOURS", 24),
    targetWallet: opt("BOOST_PAYMENT_WALLET", ""),
  },
};

export function connection() {
  return new Connection(cfg.rpcUrl, "confirmed");
}
