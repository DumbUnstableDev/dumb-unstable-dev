import { request } from "undici";
import { VersionedTransaction } from "@solana/web3.js";

const QUOTE = "https://quote-api.jup.ag/v6/quote";
const SWAP = "https://quote-api.jup.ag/v6/swap";

export async function getQuote({ inputMint, outputMint, amount, slippageBps = 100 }) {
  const u = new URL(QUOTE);
  u.searchParams.set("inputMint", inputMint);
  u.searchParams.set("outputMint", outputMint);
  u.searchParams.set("amount", String(amount));
  u.searchParams.set("slippageBps", String(slippageBps));
  u.searchParams.set("onlyDirectRoutes", "false");
  const { body } = await request(u.toString());
  const data = await body.json();
  if (!data?.outAmount) throw new Error("jupiter quote empty");
  return data;
}

export async function buildSwapTx(quote, userPubkey) {
  const { body } = await request(SWAP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: userPubkey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  const data = await body.json();
  if (!data?.swapTransaction) throw new Error("jupiter swap build failed");
  return VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, "base64"));
}
