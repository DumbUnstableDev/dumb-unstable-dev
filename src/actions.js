import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import bs58 from "bs58";
import { cfg, connection } from "./config.js";
import { log } from "./log.js";
import { swap } from "./lib/trade.js";
import { buildCollectCreatorFeeTx } from "./lib/pumpportal.js";
import { getHolders } from "./lib/helius.js";

const WSOL = "So11111111111111111111111111111111111111112";
const BURN_ADDRESS = new PublicKey("1nc1nerator11111111111111111111111111111111");

async function signAndSend(tx, conn) {
  if (tx instanceof VersionedTransaction) {
    tx.sign([cfg.treasury]);
    const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    await conn.confirmTransaction(sig, "confirmed");
    return sig;
  }
  tx.feePayer = cfg.treasury.publicKey;
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(cfg.treasury);
  return sendAndConfirmTransaction(conn, tx, [cfg.treasury], { commitment: "confirmed" });
}

// --- claim creator fees via PumpPortal ---
export async function claimCreatorFees() {
  const conn = connection();
  const txBuf = await buildCollectCreatorFeeTx(cfg.treasury.publicKey.toBase58());
  const vtx = VersionedTransaction.deserialize(txBuf);
  vtx.sign([cfg.treasury]);
  const sig = await conn.sendTransaction(vtx);
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

// --- buyback: swap SOL -> our mint, accumulate in treasury (no auto-burn) ---
// The agent decides separately when to `burn` from accumulated holdings.
// This separation gives the persona more leverage: a buyback signals demand
// without immediately destroying supply, so the agent can stockpile and then
// pick the moment for a `burn`, `distribute_tokens`, or `lottery_tokens` move.
export async function executeBuyback({ amountSol }) {
  if (!cfg.tokenMint) throw new Error("TOKEN_MINT not configured");
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
  const { sig, outAmount, provider } = await swap({
    inputMint: WSOL,
    outputMint: cfg.tokenMint.toBase58(),
    amountLamports: lamports,
    slippageBps: 150,
    treasury: cfg.treasury,
  });
  log.info(
    { sig, amountSol, outAmount, provider, accumulating: true },
    "buyback swap confirmed (tokens held in treasury, not burned)",
  );
  return { sig, swapSig: sig, provider, amountSol, accumulatedTokens: outAmount };
}

// --- burn tokens held in treasury ---
export async function executeBurn({ amountTokens }) {
  if (!cfg.tokenMint) throw new Error("TOKEN_MINT not configured");
  const conn = connection();
  const decimals = 6;
  const ata = await getAssociatedTokenAddress(cfg.tokenMint, cfg.treasury.publicKey);
  const rawAmt = BigInt(Math.floor(amountTokens * 10 ** decimals));
  const ix = createBurnCheckedInstruction(
    ata,
    cfg.tokenMint,
    cfg.treasury.publicKey,
    rawAmt,
    decimals,
  );
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    ix,
  );
  return signAndSend(tx, conn);
}

// --- invest: swap SOL -> whitelisted/curated mint ---
// Returns richer result so memory log can track entry price for later PnL.
export async function executeInvest({ amountSol, targetMint }) {
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
  const { sig, outAmount, provider } = await swap({
    inputMint: WSOL,
    outputMint: targetMint,
    amountLamports: lamports,
    slippageBps: 200,
    treasury: cfg.treasury,
  });
  return {
    sig,
    swapSig: sig,
    provider,
    entryAmountSol: amountSol,
    outAmount,
    entryRate: outAmount / lamports, // tokens_per_lamport, rough entry rate
  };
}

// --- sell: swap an invested mint back to SOL ---
// Uses current SPL balance * pct to determine the amount to sell.
export async function executeSell({ targetMint, pct = 100 }) {
  if (!targetMint) throw new Error("sell: targetMint required");
  const conn = connection();
  const treasuryPk = cfg.treasury.publicKey;
  const mintPk = new PublicKey(targetMint);

  // Read on-chain balance of this token held by the treasury.
  const ata = await getOrCreateAssociatedTokenAccount(
    conn,
    cfg.treasury,
    mintPk,
    treasuryPk,
  );
  const balance = ata.amount; // BigInt natively
  if (balance === 0n) {
    throw new Error("sell: treasury holds zero of target mint");
  }
  const slice = (balance * BigInt(Math.floor(pct * 100))) / 10_000n; // pct basis points
  if (slice === 0n) throw new Error("sell: slice rounded to zero");

  const { sig, outAmount, provider } = await swap({
    inputMint: targetMint,
    outputMint: WSOL,
    amountLamports: slice.toString(),
    slippageBps: 250,
    treasury: cfg.treasury,
  });
  log.info(
    {
      sig,
      mint: targetMint,
      pct,
      sold: slice.toString(),
      outSol: outAmount / LAMPORTS_PER_SOL,
      provider,
    },
    "sell executed",
  );
  return {
    sig,
    swapSig: sig,
    provider,
    pct,
    soldTokens: slice.toString(),
    receivedSol: outAmount / LAMPORTS_PER_SOL,
  };
}

// --- lottery: pick K random eligible holders, each gets equal share ---
// Eligibility: holds >= min balance. Randomness: blockhash-seeded (MVP; move to
// Switchboard VRF for v2 when size justifies gas cost).
const LOTTERY_MIN_UI = 1; // ignore dust holders (held < 1 UI)
export async function executeLottery({ amountSol, winners = 10, excludes = [] }) {
  if (!cfg.tokenMint) throw new Error("TOKEN_MINT not configured");
  const conn = connection();
  const excludeSet = new Set([
    cfg.treasury.publicKey.toBase58(),
    BURN_ADDRESS.toBase58(),
    ...excludes,
  ]);
  const holders = await getHolders(cfg.tokenMint.toBase58(), 1000);
  const eligible = holders.filter(
    (h) =>
      !excludeSet.has(h.owner) &&
      Number(h.amount) / 10 ** (h.decimals ?? 6) >= LOTTERY_MIN_UI,
  );
  if (eligible.length < winners) {
    throw new Error(
      `lottery: only ${eligible.length} eligible holders, need ${winners}`,
    );
  }

  // Seed randomness with the latest blockhash — attackable by validators in
  // principle, acceptable for MVP amounts. Upgrade to Switchboard VRF later.
  // NOTE: Solana blockhashes are base58, NOT base64 — using `Buffer.from(., "base64")`
  // here previously produced a partially-corrupt seed that biased the lottery.
  const { blockhash } = await conn.getLatestBlockhash();
  const seedBytes = bs58.decode(blockhash);
  const rand = (i) =>
    (seedBytes[(i * 7 + 3) % seedBytes.length] << 16) ^
    (seedBytes[(i * 13 + 11) % seedBytes.length] << 8) ^
    seedBytes[(i * 31 + 17) % seedBytes.length];

  // Fisher–Yates on a deterministic seed.
  const pool = [...eligible];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rand(i) % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picks = pool.slice(0, winners);
  const perWinnerLamports = Math.floor(
    (amountSol * LAMPORTS_PER_SOL) / winners,
  );

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  );
  for (const p of picks) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: cfg.treasury.publicKey,
        toPubkey: new PublicKey(p.owner),
        lamports: perWinnerLamports,
      }),
    );
  }
  const sig = await signAndSend(tx, conn);
  log.info(
    { sig, winners: picks.length, perWinnerLamports },
    "lottery executed",
  );
  return {
    sig,
    winners: picks.map((p) => p.owner),
    perWinnerSol: perWinnerLamports / LAMPORTS_PER_SOL,
    totalSol: amountSol,
  };
}

// --- boost: send SOL to dev's "step-bro" wallet for manual DS boost purchase ---
// DS has no public payment API, so we use a semi-manual flow:
//   - Agent picks a tier
//   - We send the SOL equivalent to BOOST_PAYMENT_WALLET (dev-controlled)
//   - Memo encodes tier + pair so dev knows which boost to buy
//   - Dev manually buys the boost on DS UI
//   - Agent tweets the intent transparently in-character
import * as dsBoost from "./lib/dexscreener-boost.js";

export async function executeBoost({ kind, pairAddress }) {
  if (!dsBoost.boostEnabled()) {
    throw new Error(
      "BOOST_PAYMENT_WALLET not configured — boost action blocked",
    );
  }
  if (!pairAddress) {
    throw new Error(
      "boost: pairAddress required (resolve from ctx.token.pairAddress)",
    );
  }
  const tier = dsBoost.tierFor(kind);
  if (!tier) throw new Error("boost: unknown tier " + kind);

  const conn = connection();
  const built = await dsBoost.buildBoostPaymentTx({
    kind,
    fromPubkey: cfg.treasury.publicKey,
    pairAddress,
  });
  const sig = await signAndSend(built.tx, conn);
  log.info(
    {
      sig,
      kind,
      usd: built.usdAmount,
      sol: built.solAmount,
      pair: pairAddress,
      tier: tier.label,
      memo: built.memo,
    },
    "boost payment sent to dev wallet (manual fulfillment pending)",
  );
  return {
    sig,
    kind,
    pairAddress,
    usdSpent: built.usdAmount,
    solSpent: built.solAmount,
    tierLabel: tier.label,
    boosts: tier.boosts,
    durationHours: tier.durationHours,
    fulfillmentMode: "manual_via_dev",
  };
}

// --- distribute_tokens: pro-rata token airdrop to top N holders ---
// Pays out from the treasury's OWN-token ATA (built up via buyback). Tokens
// shrink float for everyone else, which is why the persona may pick this over
// SOL distribute when own-token bag is large but SOL is tight.
export async function executeDistributeTokens({ amountTokens, recipients, excludes = [] }) {
  if (!cfg.tokenMint) throw new Error("TOKEN_MINT not configured");
  const conn = connection();
  const decimals = 6; // pump.fun default
  const treasuryPk = cfg.treasury.publicKey;

  // Read treasury balance of own token first — fail fast if we don't have enough.
  const sourceAta = await getOrCreateAssociatedTokenAccount(
    conn,
    cfg.treasury,
    cfg.tokenMint,
    treasuryPk,
  );
  const treasuryTokens = sourceAta.amount;
  const wantedRaw = BigInt(Math.floor(amountTokens * 10 ** decimals));
  if (wantedRaw > treasuryTokens) {
    throw new Error(
      `distribute_tokens: treasury holds ${treasuryTokens} raw, requested ${wantedRaw}`,
    );
  }

  const excludeSet = new Set([
    treasuryPk.toBase58(),
    BURN_ADDRESS.toBase58(),
    ...excludes,
  ]);
  const holders = await getHolders(cfg.tokenMint.toBase58(), 1000);
  const eligible = holders
    .filter((h) => !excludeSet.has(h.owner))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, recipients);
  if (!eligible.length) throw new Error("distribute_tokens: no eligible holders");

  const totalHeld = eligible.reduce((s, h) => s + BigInt(h.amount), 0n);

  const payouts = eligible
    .map((h) => ({
      owner: h.owner,
      raw: (BigInt(h.amount) * wantedRaw) / totalHeld,
    }))
    .filter((p) => p.raw > 0n);
  if (!payouts.length) throw new Error("distribute_tokens: all payouts rounded to dust");

  const sigs = [];
  // SPL transfers ~6.5k CU each, ~10 per tx is comfortable.
  const BATCH = 10;
  for (let i = 0; i < payouts.length; i += BATCH) {
    const slice = payouts.slice(i, i + BATCH);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    );
    for (const p of slice) {
      // Recipients are existing holders → ATAs already exist.
      const recipientAta = await getAssociatedTokenAddress(
        cfg.tokenMint,
        new PublicKey(p.owner),
      );
      tx.add(
        createTransferCheckedInstruction(
          sourceAta.address,
          cfg.tokenMint,
          recipientAta,
          treasuryPk,
          p.raw,
          decimals,
        ),
      );
    }
    try {
      const sig = await signAndSend(tx, conn);
      sigs.push(sig);
      log.info(
        { batch: i / BATCH, sig, count: slice.length },
        "distribute_tokens batch sent",
      );
    } catch (e) {
      log.warn(
        { err: e.message, batch: i / BATCH },
        "distribute_tokens batch failed — continuing",
      );
    }
  }
  return {
    sigs,
    sig: sigs[0] || null,
    payouts: payouts.length,
    totalTokens: amountTokens,
  };
}

// --- lottery_tokens: pick K random eligible holders, equal token share ---
export async function executeLotteryTokens({ amountTokens, winners = 10, excludes = [] }) {
  if (!cfg.tokenMint) throw new Error("TOKEN_MINT not configured");
  const conn = connection();
  const decimals = 6;
  const treasuryPk = cfg.treasury.publicKey;

  const sourceAta = await getOrCreateAssociatedTokenAccount(
    conn,
    cfg.treasury,
    cfg.tokenMint,
    treasuryPk,
  );
  const wantedRaw = BigInt(Math.floor(amountTokens * 10 ** decimals));
  if (wantedRaw > sourceAta.amount) {
    throw new Error(
      `lottery_tokens: treasury holds ${sourceAta.amount} raw, requested ${wantedRaw}`,
    );
  }

  const excludeSet = new Set([
    treasuryPk.toBase58(),
    BURN_ADDRESS.toBase58(),
    ...excludes,
  ]);
  const holders = await getHolders(cfg.tokenMint.toBase58(), 1000);
  const eligible = holders.filter(
    (h) =>
      !excludeSet.has(h.owner) &&
      Number(h.amount) / 10 ** decimals >= LOTTERY_MIN_UI,
  );
  if (eligible.length < winners) {
    throw new Error(
      `lottery_tokens: only ${eligible.length} eligible holders, need ${winners}`,
    );
  }

  // Same blockhash-seeded Fisher-Yates as SOL lottery.
  const { blockhash } = await conn.getLatestBlockhash();
  const seedBytes = bs58.decode(blockhash);
  const rand = (i) =>
    (seedBytes[(i * 7 + 3) % seedBytes.length] << 16) ^
    (seedBytes[(i * 13 + 11) % seedBytes.length] << 8) ^
    seedBytes[(i * 31 + 17) % seedBytes.length];

  const pool = [...eligible];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rand(i) % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picks = pool.slice(0, winners);
  const perWinnerRaw = wantedRaw / BigInt(winners);
  if (perWinnerRaw === 0n)
    throw new Error("lottery_tokens: per-winner share rounds to 0");

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  );
  for (const p of picks) {
    const recipientAta = await getAssociatedTokenAddress(
      cfg.tokenMint,
      new PublicKey(p.owner),
    );
    tx.add(
      createTransferCheckedInstruction(
        sourceAta.address,
        cfg.tokenMint,
        recipientAta,
        treasuryPk,
        perWinnerRaw,
        decimals,
      ),
    );
  }
  const sig = await signAndSend(tx, conn);
  log.info(
    { sig, winners: picks.length, perWinnerRaw: perWinnerRaw.toString() },
    "lottery_tokens executed",
  );
  return {
    sig,
    winners: picks.map((p) => p.owner),
    perWinnerTokens: Number(perWinnerRaw) / 10 ** decimals,
    totalTokens: amountTokens,
  };
}

// --- distribute: parallel SOL transfers to top N holders ---
// For MVP simplicity. For >200 holders, switch to merkle distributor.
const BATCH_SIZE = 15; // transfers per tx
export async function executeDistribute({ amountSol, recipients, excludes = [] }) {
  if (!cfg.tokenMint) throw new Error("TOKEN_MINT not configured");
  const conn = connection();
  const excludeSet = new Set([
    cfg.treasury.publicKey.toBase58(),
    BURN_ADDRESS.toBase58(),
    ...excludes,
  ]);

  const holders = await getHolders(cfg.tokenMint.toBase58(), 1000);
  const eligible = holders
    .filter((h) => !excludeSet.has(h.owner))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, recipients);
  if (!eligible.length) throw new Error("no eligible holders");

  // Use BigInt for proportional math: with 10^15+ raw token amounts (1B-supply,
  // 6-decimal memecoins) summing as Numbers can blow past 2^53 and produce
  // wrong shares.
  const totalTokens = eligible.reduce((s, h) => s + BigInt(h.amount), 0n);
  const totalLamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

  const payouts = eligible
    .map((h) => ({
      owner: h.owner,
      lamports: Number((BigInt(h.amount) * totalLamports) / totalTokens),
    }))
    .filter((p) => p.lamports > 0); // skip dust holders rounded to 0 lamports

  const sigs = [];
  for (let i = 0; i < payouts.length; i += BATCH_SIZE) {
    const slice = payouts.slice(i, i + BATCH_SIZE);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    );
    for (const p of slice) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: cfg.treasury.publicKey,
          toPubkey: new PublicKey(p.owner),
          lamports: p.lamports,
        }),
      );
    }
    try {
      const sig = await signAndSend(tx, conn);
      sigs.push(sig);
      log.info({ batch: i / BATCH_SIZE, sig, count: slice.length }, "distribute batch sent");
    } catch (e) {
      log.warn({ err: e.message, batch: i / BATCH_SIZE }, "batch failed — continuing");
    }
  }
  return { sigs, payouts: payouts.length, totalSol: amountSol };
}

// --- dispatcher ---
export async function executeDecision(d, ctx) {
  if (cfg.dryRun) {
    log.info({ action: d.action, dryRun: true }, "DRY RUN — no on-chain action");
    return { dryRun: true };
  }
  switch (d.action) {
    case "buyback":
      return executeBuyback({ amountSol: d.amount_sol });
    case "burn":
      return executeBurn({ amountTokens: d.amount_tokens });
    case "distribute":
      return executeDistribute({
        amountSol: d.amount_sol,
        recipients: d.distribute_recipients,
        excludes: ctx.allowed?.distributionExcludes || [],
      });
    case "distribute_tokens":
      return executeDistributeTokens({
        amountTokens: d.amount_tokens,
        recipients: d.distribute_recipients,
        excludes: ctx.allowed?.distributionExcludes || [],
      });
    case "invest":
      return executeInvest({ amountSol: d.amount_sol, targetMint: d.target_mint });
    case "sell":
      return executeSell({ targetMint: d.target_mint, pct: d.sell_pct ?? 100 });
    case "lottery":
      return executeLottery({
        amountSol: d.amount_sol,
        winners: d.lottery_winners ?? 10,
        excludes: ctx.allowed?.distributionExcludes || [],
      });
    case "lottery_tokens":
      return executeLotteryTokens({
        amountTokens: d.amount_tokens,
        winners: d.lottery_winners ?? 10,
        excludes: ctx.allowed?.distributionExcludes || [],
      });
    case "boost":
      return executeBoost({
        kind: d.boost_kind,
        pairAddress: ctx.token?.pairAddress,
      });
    case "hold":
      return { held: true };
    default:
      throw new Error("unknown action: " + d.action);
  }
}
