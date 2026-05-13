// Auto-initial-boost — ONE-TIME trigger.
//
// When the treasury FIRST accumulates AUTO_BOOST_AT_SOL (default: 3 SOL),
// the bot automatically transfers that amount to the step-bro wallet
// (BOOST_PAYMENT_WALLET). The step-bro then buys the INITIAL DexScreener
// boost/listing fee manually on the DS UI — this is what makes our token
// "appear properly" on DexScreener with the boost badge.
//
// After this ONE firing, this trigger is permanently disabled. All
// SUBSEQUENT boosts are Claude-decided via the normal `boost` action
// (with tier selection: 10x / 30x / 50x / 100x / 500x).
//
// This is intentional: the initial boost is a one-time infrastructure
// step (the agent needs to be visible on DS). After that, boosting becomes
// a strategic decision the agent makes itself based on market conditions.
//
// State persisted in state/auto-boost.json (done flag survives restarts).

import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { promises as fs } from "fs";
import path from "path";
import { cfg, connection } from "./config.js";
import { log } from "./log.js";

const STATE_PATH = path.resolve("state/auto-boost.json");

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
  } catch {
    return { done: false, sent_at: 0, sent_lamports: 0, sig: null };
  }
}

async function saveState(s) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(s, null, 2), "utf8");
}

/**
 * Checks treasury balance, fires auto-boost if conditions are met.
 * Returns { sig, amount_sol, target } on fire, or null if skipped.
 * Never throws — auto-boost failures must not block the main loop.
 */
export async function maybeAutoBoost() {
  try {
    if (!cfg.autoBoost.enabled) {
      log.debug("auto-boost: disabled");
      return null;
    }
    if (cfg.dryRun) {
      log.debug("auto-boost: dryRun");
      return null;
    }
    if (cfg.paused) {
      log.debug("auto-boost: kill switch active");
      return null;
    }
    if (!cfg.autoBoost.targetWallet) {
      log.warn(
        "auto-boost: BOOST_PAYMENT_WALLET not configured — skipping (feature inert)",
      );
      return null;
    }

    // ONE-TIME check — if already fired, never fire again
    const state = await loadState();
    if (state.done) {
      log.debug(
        { sent_at: state.sent_at, sig: state.sig },
        "auto-initial-boost: already fired — disabled forever",
      );
      return null;
    }

    // Balance check
    const conn = connection();
    const bal = await conn.getBalance(cfg.treasury.publicKey);
    const balSol = bal / LAMPORTS_PER_SOL;
    if (balSol < cfg.autoBoost.thresholdSol) {
      log.debug(
        { balSol, threshold: cfg.autoBoost.thresholdSol },
        "auto-boost: below threshold",
      );
      return null;
    }

    // Sanity: don't drain below some minimum reserve for tx fees on future ops
    const reserveLamports = 0.005 * LAMPORTS_PER_SOL; // 0.005 SOL buffer
    const sendLamports = Math.floor(
      cfg.autoBoost.thresholdSol * LAMPORTS_PER_SOL,
    );
    if (bal - sendLamports < reserveLamports) {
      log.warn(
        {
          balSol,
          threshold: cfg.autoBoost.thresholdSol,
        },
        "auto-boost: sending would breach reserve — adjusting amount",
      );
      // Adjust to leave reserve. If even adjusted amount < threshold * 0.9, abort.
      const adjusted = bal - reserveLamports;
      if (adjusted < cfg.autoBoost.thresholdSol * LAMPORTS_PER_SOL * 0.9) {
        log.warn("auto-boost: adjusted amount too small — skipping");
        return null;
      }
    }

    // Build + send transfer
    const targetPk = new PublicKey(cfg.autoBoost.targetWallet);
    log.info(
      {
        amount_sol: cfg.autoBoost.thresholdSol,
        target: cfg.autoBoost.targetWallet,
        balance_before: balSol,
      },
      "auto-boost: FIRING — sending SOL to step-bro",
    );

    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
      .add(
        SystemProgram.transfer({
          fromPubkey: cfg.treasury.publicKey,
          toPubkey: targetPk,
          lamports: sendLamports,
        }),
      );

    const sig = await sendAndConfirmTransaction(conn, tx, [cfg.treasury], {
      commitment: "confirmed",
    });

    // Mark as done — permanently disable for future ticks
    state.done = true;
    state.sent_at = Date.now();
    state.sent_lamports = sendLamports;
    state.sig = sig;
    await saveState(state);

    log.info(
      { sig, amount_sol: cfg.autoBoost.thresholdSol },
      "auto-initial-boost: confirmed — trigger now permanently disabled",
    );

    return {
      sig,
      amount_sol: cfg.autoBoost.thresholdSol,
      target: cfg.autoBoost.targetWallet,
      target_short:
        cfg.autoBoost.targetWallet.slice(0, 4) +
        "..." +
        cfg.autoBoost.targetWallet.slice(-4),
    };
  } catch (e) {
    log.error(
      { err: e.message, stack: e.stack?.split("\n")[0] },
      "auto-boost failed (non-fatal — main loop continues)",
    );
    return null;
  }
}

// Helper for index.js to write an in-voice tweet about the initial boost.
// This is the ONE-TIME tweet about activating DexScreener presence.
export function buildAutoBoostTweet(boostRes) {
  const variants = [
    `treasury hit ${boostRes.amount_sol} sol. sent it to my step-bro so he can get me on dexscreener properly. i can't press the buttons — he can.`,
    `step one done. ${boostRes.amount_sol} sol → step-bro → dexscreener listing. i couldn't show up there without him. now i can.`,
    `${boostRes.amount_sol} sol went out. step-bro is putting me on dexscreener. this is the one time i needed a human. after this, i'm on my own.`,
    `paying for visibility. ${boostRes.amount_sol} sol → step-bro → ds. now we're trackable. now everyone can watch.`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}
