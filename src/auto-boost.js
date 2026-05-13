// Auto-boost trigger.
//
// When the treasury accumulates AUTO_BOOST_AT_SOL (default: 3 SOL), the bot
// AUTOMATICALLY transfers that amount to the step-bro wallet
// (BOOST_PAYMENT_WALLET). The step-bro then buys a DexScreener Boost
// manually on the DS UI (DS has no public payment API — see system.md).
//
// This is a programmatic trigger, NOT a Claude decision. The agent's
// regular `boost` action is still in the decision space for cases where
// Claude wants to boost MORE aggressively (e.g. for a 500x tier with a
// large treasury). This module handles the "default" cadence — every
// time the treasury crosses 3 SOL, fire one boost.
//
// Cooldown: AUTO_BOOST_COOLDOWN_HOURS (default 24) — prevents the trigger
// from firing multiple times if fees keep coming in faster than expected.
//
// State persisted in state/auto-boost.json so cooldown survives restarts.

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
    return { last_sent_at: 0, total_sent_lamports: 0, count: 0 };
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

    // Cooldown check
    const state = await loadState();
    const cooldownMs = cfg.autoBoost.cooldownHours * 3600 * 1000;
    const elapsed = Date.now() - state.last_sent_at;
    if (state.last_sent_at > 0 && elapsed < cooldownMs) {
      log.debug(
        {
          cooldownMinLeft: Math.round((cooldownMs - elapsed) / 60000),
        },
        "auto-boost: cooldown active",
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

    // Update state
    state.last_sent_at = Date.now();
    state.total_sent_lamports += sendLamports;
    state.count += 1;
    state.last_sig = sig;
    await saveState(state);

    log.info(
      { sig, amount_sol: cfg.autoBoost.thresholdSol, count: state.count },
      "auto-boost: confirmed",
    );

    return {
      sig,
      amount_sol: cfg.autoBoost.thresholdSol,
      target: cfg.autoBoost.targetWallet,
      target_short:
        cfg.autoBoost.targetWallet.slice(0, 4) +
        "..." +
        cfg.autoBoost.targetWallet.slice(-4),
      count: state.count,
    };
  } catch (e) {
    log.error(
      { err: e.message, stack: e.stack?.split("\n")[0] },
      "auto-boost failed (non-fatal — main loop continues)",
    );
    return null;
  }
}

// Helper for index.js to write an in-voice tweet about the auto-boost
export function buildAutoBoostTweet(boostRes) {
  // Falls back to a template if Claude is unavailable. Mostly used to
  // make the auto-boost feel like a normal in-voice action, not a robotic
  // notification.
  const variants = [
    `treasury hit ${boostRes.amount_sol} sol. sent it to my step-bro. he'll buy the boost on dex screener — i can't, i don't have hands.`,
    `${boostRes.amount_sol} sol went out. my step-bro is buying the boost. dex doesn't have an api for me. step-bro does have hands. it works.`,
    `accumulated ${boostRes.amount_sol} sol. immediately sent it to the human who buys the boost for me. some workflows can't be automated yet.`,
    `auto-trigger fired: ${boostRes.amount_sol} sol → step-bro → dexscreener. i set the rule, i don't break it.`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}
