import { request, FormData as UndiciFormData } from "undici";
import { cfg } from "../config.js";
import { log } from "../log.js";
import WebSocket from "ws";

const TRADE_LOCAL = "https://pumpportal.fun/api/trade-local";
const IPFS_ENDPOINT = "https://pump.fun/api/ipfs";

// --- Local-sign flow (no custody with PumpPortal) ------------------------
// Every call returns a raw unsigned tx (base64 / bytes). You sign it locally
// with @solana/web3.js and submit via your RPC. The treasury key NEVER leaves
// this process.

async function tradeLocal(payload) {
  const res = await request(TRADE_LOCAL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = await res.body.text();
    throw new Error(`pumpportal ${res.statusCode}: ${text}`);
  }
  const buf = await res.body.arrayBuffer();
  return Buffer.from(buf);
}

// Collect accrued creator fees from BC + AMM vaults in one tx.
export async function buildCollectCreatorFeeTx(publicKey, priorityFee = 0.000005) {
  return tradeLocal({ publicKey, action: "collectCreatorFee", priorityFee });
}

// Buy a token on pump.fun or PumpSwap (routed automatically by PumpPortal).
// amount = SOL amount; slippage in percent.
export async function buildBuyTx({
  publicKey,
  mint,
  amountSol,
  slippage = 10,
  priorityFee = 0.000005,
  pool = "auto",
}) {
  return tradeLocal({
    publicKey,
    action: "buy",
    mint,
    amount: amountSol,
    denominatedInSol: "true",
    slippage,
    priorityFee,
    pool,
  });
}

// Sell a token. amount = token amount or 100% if denominatedInSol:"false" + amount:"100%"
export async function buildSellTx({
  publicKey,
  mint,
  amountTokens,
  slippage = 10,
  priorityFee = 0.000005,
  pool = "auto",
}) {
  return tradeLocal({
    publicKey,
    action: "sell",
    mint,
    amount: amountTokens,
    denominatedInSol: "false",
    slippage,
    priorityFee,
    pool,
  });
}

// --- IPFS metadata upload (needed before create) -------------------------
// Uploads image + name/symbol/description/socials to pump.fun's IPFS.
// Returns { metadataUri, metadata: {name,symbol,...} }.
export async function uploadMetadata({
  name,
  symbol,
  description,
  imageBuffer,
  imageName = "logo.png",
  twitter = "",
  telegram = "",
  website = "",
}) {
  const form = new UndiciFormData();
  const blob = new Blob([imageBuffer], { type: "image/png" });
  form.append("file", blob, imageName);
  form.append("name", name);
  form.append("symbol", symbol);
  form.append("description", description);
  form.append("twitter", twitter);
  form.append("telegram", telegram);
  form.append("website", website);
  form.append("showName", "true");

  const res = await request(IPFS_ENDPOINT, { method: "POST", body: form });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = await res.body.text();
    throw new Error(`ipfs ${res.statusCode}: ${text}`);
  }
  return res.body.json();
}

// --- Create a new pump.fun token (the agent launches its own coin) -------
// Signed by BOTH the creator wallet AND the mint keypair (must be fresh).
// Returns the unsigned tx — you sign it with [creatorKp, mintKp] and submit.
export async function buildCreateTx({
  publicKey,
  mint, // mint keypair PUBLIC KEY (base58 string)
  tokenMetadata, // { name, symbol, uri } from uploadMetadata()
  initialBuySol = 0, // dev buy at launch, optional
  slippage = 10,
  priorityFee = 0.0005,
  pool = "pump",
}) {
  return tradeLocal({
    publicKey,
    action: "create",
    tokenMetadata,
    mint,
    denominatedInSol: "true",
    amount: initialBuySol,
    slippage,
    priorityFee,
    pool,
  });
}

// --- WebSocket stream ----------------------------------------------------

export function subscribeTokenTrades(mints, onTrade) {
  let ws;
  let stopped = false;

  const open = () => {
    ws = new WebSocket(cfg.pumpportalWs);
    ws.on("open", () => {
      ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));
      log.info({ mints }, "pumpportal: subscribed to trades");
    });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.txType) onTrade(msg);
      } catch (e) {
        log.warn({ err: e.message }, "pumpportal parse failed");
      }
    });
    ws.on("error", (e) => log.error({ err: e.message }, "pumpportal error"));
    ws.on("close", () => {
      if (stopped) return;
      log.warn("pumpportal closed — reconnecting in 5s");
      setTimeout(open, 5000);
    });
  };

  open();
  return {
    stop() {
      stopped = true;
      try {
        ws?.close();
      } catch {}
    },
  };
}
