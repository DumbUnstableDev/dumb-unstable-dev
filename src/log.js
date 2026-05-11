import pino from "pino";
import { cfg } from "./config.js";

// Redact paths — keep secrets out of logs even when objects are dumped.
// Pino uses lodash-like paths. We cover both the cfg shape and common
// HTTP-header-bearing log shapes.
const REDACT_PATHS = [
  // Top-level (env-name shaped if someone logs process.env directly)
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "TREASURY_SECRET_KEY",
  "GMGN_API_KEY",
  "HELIUS_API_KEY",
  "TWITTER_APP_KEY",
  "TWITTER_APP_SECRET",
  "TWITTER_ACCESS_TOKEN",
  "TWITTER_ACCESS_SECRET",
  "TWITTER_BEARER_TOKEN",
  "TWITTER_AUTH_TOKEN",
  "TWITTER_CT0",
  "FEED_GITHUB_TOKEN",

  // cfg.* shape (from config.js)
  "cfg.anthropicKey",
  "cfg.anthropicOAuth",
  "cfg.heliusKey",
  "cfg.twitter.appKey",
  "cfg.twitter.appSecret",
  "cfg.twitter.accessToken",
  "cfg.twitter.accessSecret",
  "cfg.twitter.bearer",
  "cfg.twitterCookies.authToken",
  "cfg.twitterCookies.ct0",
  "cfg.treasury.secretKey",

  // Nested wildcards (catch any object passed with these keys)
  "*.appKey",
  "*.appSecret",
  "*.accessToken",
  "*.accessSecret",
  "*.bearer",
  "*.authToken",
  "*.ct0",
  "*.apiKey",
  "*.secretKey",
  "*.privateKey",

  // Common HTTP header shapes
  '*.headers.authorization',
  '*.headers.Authorization',
  '*.headers["x-route-key"]',
  '*.headers["x-api-key"]',
];

export const log = pino({
  level: cfg.logLevel,
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
    remove: false,
  },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
});
