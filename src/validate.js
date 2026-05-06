import { z } from "zod";
import { cfg } from "./config.js";
import { countActionsInWindow, lastExecutedAt } from "./memory.js";

// Investment-specific rails (tighter than general actions).
const INVEST_PCT_CAP = 0.10; // max 10% of treasury per single position
const MAX_OPEN_POSITIONS = 3;
const MAX_NEW_POSITIONS_PER_DAY = 2;

const schema = z
  .object({
    action: z.enum([
      "buyback",
      "burn",
      "distribute",
      "lottery",
      "invest",
      "sell",
      "boost",
      "hold",
    ]),
    amount_sol: z.number().min(0).optional().default(0),
    amount_tokens: z.number().min(0).optional().default(0),
    target_mint: z.string().nullable().optional(),
    sell_pct: z.number().min(0).max(100).optional().default(100),
    lottery_winners: z.number().min(1).max(50).optional().default(10),
    boost_kind: z
      .enum([
        "dex_boost_10x",
        "dex_boost_30x",
        "dex_boost_50x",
        "dex_boost_100x",
        "dex_boost_500x",
      ])
      .optional(),
    distribute_recipients: z.number().min(0).max(500).optional().default(0),
    rationale_private: z.string().min(10).max(2000),
    tweet_text: z.string().min(5).max(275),
    thread_followups: z.array(z.string().max(275)).max(3).optional().default([]),
    replies: z
      .array(
        z.object({
          mention_id: z.string(),
          text: z.string().min(1).max(275),
        }),
      )
      .max(3)
      .optional()
      .default([]),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export async function validate(decision, ctx) {
  const parsed = schema.safeParse(decision);
  if (!parsed.success) {
    return {
      ok: false,
      err: "schema: " + parsed.error.issues.map((i) => i.message).join("; "),
    };
  }
  const d = parsed.data;

  // Kill switch.
  if (cfg.paused) return { ok: false, err: "agent_paused" };

  // Confidence.
  if (d.confidence < cfg.rails.minConfidence && d.action !== "hold") {
    return { ok: false, err: "low_confidence_non_hold" };
  }

  // Daily cap.
  const todayCount = await countActionsInWindow(24 * 60);
  if (d.action !== "hold" && todayCount >= cfg.rails.maxActionsPerDay) {
    return { ok: false, err: "daily_cap_reached" };
  }

  // Cooldown.
  const last = await lastExecutedAt();
  const cooldownMs = cfg.rails.cooldownMinutes * 60 * 1000;
  if (d.action !== "hold" && last > 0 && Date.now() - last < cooldownMs) {
    return { ok: false, err: "cooldown_active" };
  }

  const treasurySol = ctx.treasury?.balanceSol || 0;
  const redZone = new Set(ctx.allowed?.redZone || []);
  const allowedMints = new Set(ctx.allowed?.allowedTargets || []);
  const curated = new Set((ctx.curated_candidates || []).map((c) => c.mint));
  const openPositions = ctx.open_positions || [];
  const openSet = new Set(openPositions.map((p) => p.mint));

  // --- Per-action SOL cap ---
  // Defaults: 20%. Tighter for invest (10%).
  // For boost we DO NOT use d.amount_sol — that field is informational; the
  // real spend is `tier.usd / sol_usd` computed inside dexscreener-boost.
  // The boost-specific USD cap is enforced fail-closed in the boost branch
  // below.
  if (d.action !== "boost") {
    let capPct = cfg.rails.maxSolPctPerAction;
    if (d.action === "invest") capPct = INVEST_PCT_CAP;
    if (d.amount_sol > treasurySol * capPct) {
      return { ok: false, err: `exceeds_cap_${Math.round(capPct * 100)}pct` };
    }
  }

  // --- Action-specific rails ---

  if (d.action === "invest") {
    if (!d.target_mint) return { ok: false, err: "invest_missing_target" };
    if (redZone.has(d.target_mint)) return { ok: false, err: "target_in_red_zone" };
    // Target must be EITHER in static allowlist OR in curated candidates.
    if (!allowedMints.has(d.target_mint) && !curated.has(d.target_mint)) {
      return { ok: false, err: "target_not_in_allowlist_or_curated" };
    }
    if (d.amount_sol <= 0) return { ok: false, err: "invest_zero_amount" };
    if (openSet.has(d.target_mint)) {
      return { ok: false, err: "already_holding_this_position" };
    }
    if (openPositions.length >= MAX_OPEN_POSITIONS) {
      return { ok: false, err: "max_open_positions_reached" };
    }
    // Cap new positions per day.
    const recent = ctx.history?.last10 || [];
    const newPositionsToday = recent.filter(
      (r) =>
        r.action === "invest" &&
        r.status === "executed" &&
        Date.now() - r.ts < 24 * 3600 * 1000,
    ).length;
    if (newPositionsToday >= MAX_NEW_POSITIONS_PER_DAY) {
      return { ok: false, err: "max_new_positions_per_day" };
    }
  }

  if (d.action === "sell") {
    if (!d.target_mint) return { ok: false, err: "sell_missing_target" };
    if (!openSet.has(d.target_mint)) {
      return { ok: false, err: "sell_no_open_position" };
    }
    if (d.sell_pct <= 0) return { ok: false, err: "sell_zero_pct" };
  }

  if (d.action === "distribute") {
    if (d.amount_sol <= 0) return { ok: false, err: "distribute_zero_amount" };
    if (d.distribute_recipients <= 0)
      return { ok: false, err: "distribute_zero_recipients" };
  }

  if (d.action === "lottery") {
    if (d.amount_sol <= 0) return { ok: false, err: "lottery_zero_amount" };
    if (d.lottery_winners <= 0)
      return { ok: false, err: "lottery_zero_winners" };
  }

  if (d.action === "boost") {
    if (!process.env.BOOST_PAYMENT_WALLET && !process.env.DS_BOOST_RECIPIENT)
      return { ok: false, err: "boost_payment_wallet_not_configured" };
    if (!d.boost_kind) return { ok: false, err: "boost_missing_kind" };
    if (!ctx.token?.pairAddress) {
      return { ok: false, err: "boost_pair_unknown" };
    }
    // Derive expected SOL cost for this tier at current fx; compare to cap.
    // We override amount_sol in dispatcher (we pay exact tier price), but still
    // enforce cap here against the tier's USD at a rough SOL rate if we have it.
    // If agent wildly over-proposed amount_sol — also reject as red flag.
    const tierPrices = {
      dex_boost_10x: 99,
      dex_boost_30x: 249,
      dex_boost_50x: 399,
      dex_boost_100x: 899,
      dex_boost_500x: 3999,
    };
    const tierUsd = tierPrices[d.boost_kind];
    // Fail-closed: require known treasury USD before spending on boost.
    // Previously this skipped silently when treasuryUsd was 0/undefined,
    // letting the bot spend $99-$3999 with NO cap enforcement.
    const treasuryUsd = ctx.treasury?.balanceUsd || 0;
    if (treasuryUsd <= 0) {
      return { ok: false, err: "boost_treasury_usd_unknown" };
    }
    if (tierUsd > treasuryUsd * 0.15) {
      return { ok: false, err: "boost_exceeds_15pct_usd_cap" };
    }
    // Conservative SOL floor: assume SOL ≥ $200 — if treasury SOL can't even
    // cover tier_usd / 200, the boost will almost certainly bounce when
    // converted at real fx. Reject early.
    if (treasurySol > 0 && treasurySol < tierUsd / 200) {
      return { ok: false, err: "boost_treasury_sol_too_low" };
    }
    // Tier-specific minimum: 500x ($3999) is huge — only allow it if the
    // treasury can plausibly absorb it without crippling future operations.
    if (d.boost_kind === "dex_boost_500x" && treasuryUsd < 30_000) {
      return { ok: false, err: "boost_500x_requires_30k_treasury_min" };
    }
  }

  if (d.action === "buyback" && d.amount_sol <= 0) {
    return { ok: false, err: "buyback_zero_amount" };
  }

  if (d.action === "burn" && d.amount_tokens <= 0) {
    return { ok: false, err: "burn_zero_tokens" };
  }

  // Tweet/action coherence.
  const t = d.tweet_text.toLowerCase();
  if (d.action === "buyback" && !/(buy|back|bought|bid)/.test(t)) {
    return { ok: false, err: "tweet_action_mismatch_buyback" };
  }
  if (d.action === "burn" && !/(burn|burned|ash)/.test(t)) {
    return { ok: false, err: "tweet_action_mismatch_burn" };
  }
  if (d.action === "invest" && !/(bought|invest|picked|long|bet|position)/.test(t)) {
    return { ok: false, err: "tweet_action_mismatch_invest" };
  }
  if (d.action === "sell" && !/(sold|exit|closed|trim|out)/.test(t)) {
    return { ok: false, err: "tweet_action_mismatch_sell" };
  }
  if (d.action === "lottery" && !/(lottery|won|winner|rng|random|roll)/.test(t)) {
    return { ok: false, err: "tweet_action_mismatch_lottery" };
  }
  if (
    d.action === "boost" &&
    !/(boost|promo|paid|ad|bounty|trending|step|bro|dev|send|fund)/.test(t)
  ) {
    return { ok: false, err: "tweet_action_mismatch_boost" };
  }

  return { ok: true, decision: d };
}
