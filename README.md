# ai-dev

```
   _______________
  |               |
  |    O     O    |
  |     > ^ <     |
  |               |
  |     _____     |
  |    | | | |    |
  |    | | | |    |
  |     ‾‾‾‾‾     |
  |____Repeat_____|
```

Autonomous AI agent that runs a pump.fun memecoin treasury.

It receives all creator fees, decides every 30 minutes what to do with them
(buyback, burn, distribute to holders, lottery, invest, sell, dex-boost, or
hold), and posts the reasoning publicly on X.

Decisions are made by Claude (Anthropic) via a structured `tool_use` call,
constrained by an in-character system prompt and validated against hard
safety rails before execution.

The point of the project is to put a memecoin's treasury under a model
instead of a human. The model has a personality, opinions, and a budget. It
gets things wrong sometimes. It posts about it.

## How it actually works

```
   cron / whale-trade event
            │
            ▼
     claim creator fees       ← treasury tops up from pump.fun
            │
            ▼
     build context            ← DexScreener / Helius / PumpPortal / X
            │
            ▼
       ask Claude             ← tool_use: ceo_decide(...)
            │
            ▼
      validate                ← caps, cooldowns, allowlists, kill-switch
            │
            ▼
     execute on-chain         ← Jupiter / GMGN swap, SPL burn, transfers
            │
            ▼
      post on X               ← tweet + thread + tx link
            │
            ▼
       log to disk            ← state/memory.jsonl (append-only)
```

## Actions the agent can take

| action | what it does |
|---|---|
| `buyback` | swap SOL → own token → send to burn address |
| `burn` | SPL burn own token from treasury |
| `distribute` | pro-rata SOL airdrop to top N holders |
| `lottery` | pick K random eligible holders, equal share each |
| `invest` | open a position in another token (allowlist gated) |
| `sell` | close or trim an open position |
| `boost` | request a DexScreener Boost tier |
| `hold` | do nothing this tick, monitor |

## Safety rails

Hard-enforced after the LLM returns its decision:

- `max_sol_per_action` — 20% of treasury per single action (10% for `invest`)
- `max_actions_per_day` — 12
- `cooldown_minutes` — 20 between non-hold actions
- `min_confidence` — 0.55, anything lower forces `hold`
- `drawdown_halt_pct` — auto-pause if treasury value drops > 30% in 24h
- `red_zone` — list of mints the agent cannot invest into
- `allowed_targets` — whitelist for `invest` action
- `AGENT_PAUSED=1` — kill switch, short-circuits all txs

See `src/validate.js` for the full set.

## Persona

The agent has a defined voice. See:

- `src/prompts/system.md` — full character + decision rules
- `src/prompts/examples.json` — 19 tone anchors

Short version: it's self-aware, dry, lowercase, no emojis, no hashtags,
no "to the moon", no shilling, no price predictions. It can roast itself
when it loses. It can dunk on bad takes in replies.

## Stack

```
Node 20+ (ESM)
├── @anthropic-ai/sdk         Claude Sonnet 4.5 with tool_use + caching
├── @solana/web3.js           transaction signing
├── @solana/spl-token         burns / transfers
├── twitter-api-v2            X posting + mention reads
├── ws                        PumpPortal websocket (whale + fee events)
├── undici                    DexScreener + price API
├── zod                       runtime validation of LLM output
├── pino                      structured logs
└── node-cron                 30-min heartbeat
```

No database. State lives in `state/memory.jsonl` (append-only event log).

## Quick start

```bash
git clone https://github.com/<owner>/ai-dev.git
cd ai-dev
npm install
cp .env.example .env
# fill in your keys (see .env.example for what's required)

# Dry-run one tick (no on-chain, no tweet — just logs):
DRY_RUN=1 node src/index.js --once
```

## Test the decision logic without an API key

8 hand-crafted market scenarios, fake decisions, real validator:

```bash
SIMULATE_FAKE_ONLY=1 npm run simulate
```

## Live tick with a real Claude call (still dry-run on chain)

```bash
DRY_RUN=1 node src/index.js --once
```

You'll see the actual decision Claude makes and the tweet it would post —
without touching the wallet or X.

## Production

```bash
DRY_RUN=0 MANUAL_APPROVAL=1 node src/index.js
```

`MANUAL_APPROVAL=1` makes the bot ask `y/n` before each action — recommended
for the first few days. Once you trust the persona, set it to `0`.

## Files of interest if you're auditing

- `src/claude.js` — the LLM call. Tool schema is the contract.
- `src/validate.js` — every hard rail, in one place.
- `src/prompts/system.md` — the persona + decision rules.
- `src/actions.js` — every on-chain action, dispatched from validated decisions.
- `scripts/simulate.js` — 8 scenarios showing how the agent reacts to
  different market shapes. Useful for understanding behavior.

## License

MIT
