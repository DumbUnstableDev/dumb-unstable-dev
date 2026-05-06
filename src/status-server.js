// Optional HTTP /status endpoint. Read-only snapshot for dashboards / curl.
//
// Enable by setting STATUS_PORT in .env; disabled if blank.
// Binds to 127.0.0.1 by default (loopback only). Override with STATUS_HOST=0.0.0.0
// only if you intentionally want it reachable from the network — and in that
// case ALWAYS set STATUS_TOKEN to require Bearer auth.

import http from "http";
import crypto from "crypto";
import { cfg } from "./config.js";
import { log } from "./log.js";
import { readRecent, summarize24h } from "./memory.js";

const PORT = Number(process.env.STATUS_PORT || 0);
const BIND_HOST = process.env.STATUS_HOST || "127.0.0.1";
const ACCESS_TOKEN = process.env.STATUS_TOKEN || "";

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function authorized(req) {
  // If no token configured AND we're bound to loopback, allow.
  if (!ACCESS_TOKEN) {
    return BIND_HOST === "127.0.0.1" || BIND_HOST === "localhost" || BIND_HOST === "::1";
  }
  // Token configured — require Bearer match. Use constant-time compare to
  // defeat timing-attack token recovery on remote-bound deployments.
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  const provided = Buffer.from(m[1]);
  const expected = Buffer.from(ACCESS_TOKEN);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

async function buildStatus() {
  const [recent, daily] = await Promise.all([readRecent(20), summarize24h()]);
  return {
    ticker: cfg.tokenTicker,
    persona: cfg.personaName,
    mint: cfg.tokenMint?.toBase58() || null,
    treasury: cfg.treasury?.publicKey?.toBase58() || null,
    paused: cfg.paused,
    dryRun: cfg.dryRun,
    manualApproval: cfg.manualApproval,
    last24h: daily,
    recent: recent.map((r) => ({
      ts: r.ts,
      action: r.action,
      status: r.status,
      amountSol: r.amount_sol,
      conf: r.confidence,
    })),
  };
}

export function startStatusServer() {
  if (!PORT) return null;
  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) {
      return send(res, 401, { err: "unauthorized" });
    }
    if (req.url === "/status" || req.url === "/") {
      try {
        send(res, 200, await buildStatus());
      } catch (e) {
        send(res, 500, { err: e.message });
      }
      return;
    }
    if (req.url === "/health") return send(res, 200, { ok: true, t: Date.now() });
    send(res, 404, { err: "not_found" });
  });
  server.listen(PORT, BIND_HOST, () =>
    log.info(
      { port: PORT, host: BIND_HOST, authRequired: !!ACCESS_TOKEN },
      "status server listening (loopback by default)",
    ),
  );
  return server;
}
