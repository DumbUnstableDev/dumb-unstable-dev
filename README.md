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

An autonomous AI agent that runs a pump.fun memecoin treasury.

It receives all creator fees, decides on a 30-minute heartbeat what to do
with them — buy back, burn, distribute, lottery, invest, sell, dex-boost,
or hold — and posts the reasoning on X with the on-chain proof attached.

The decisions come from Claude (Anthropic) through a structured `tool_use`
call, constrained by an in-character system prompt and validated against
hard safety rails before any transaction is signed.

The point isn't another memecoin. The point is to take a memecoin's
treasury and put it under a model with a personality, a budget, and the
ability to be wrong publicly.

## Decision flow

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

## What the agent can do on any given tick

| action | what it does |
|---|---|
| `buyback` | swap SOL → own token; tokens accumulate in treasury (no auto-burn) |
| `burn` | SPL burn of own tokens already held in the treasury |
| `distribute` | pro-rata SOL airdrop to top N holders |
| `distribute_tokens` | pro-rata token airdrop from accumulated buyback bag |
| `lottery` | K random eligible holders, equal share of SOL |
| `lottery_tokens` | K random holders, equal share of own tokens |
| `invest` | open a position in a curator-vetted external token |
| `sell` | close or trim an open position |
| `boost` | request a DexScreener Boost tier (sent to dev wallet, manual fulfillment) |
| `hold` | do nothing this tick |

## Safety rails

Every decision passes through `src/validate.js` before execution:

- **caps** — 20% of treasury per action, 10% for `invest`, USD-cap for `boost`
- **cooldown** — 20 minutes between non-hold actions
- **daily limit** — configurable (default high enough for one action per
  half-hour tick if the agent thinks the market warrants it)
- **min confidence** — 0.55, anything lower forces `hold`
- **drawdown halt** — auto-pause if treasury value drops > 30% in 24h
- **red zone** — list of mints the agent cannot invest into
- **curated candidates** — the only pool `invest` can pick from, filtered
  by min market cap, min liquidity, min token age, min holder count
- **`AGENT_PAUSED=1`** — kill switch, short-circuits all transactions
- **prompt-injection sanitization** — mention text is defanged before
  reaching Claude (see `src/twitter.js → sanitizeMentionText`)

## Persona

The agent has a defined voice. Two files spell it out:

- [`src/prompts/system.md`](src/prompts/system.md) — full character + decision rules
- [`src/prompts/examples.json`](src/prompts/examples.json) — tone anchors

Short version: self-aware about being an AI memecoin, dry, lowercase,
no emojis, no hashtags, no shilling, no price predictions. Roasts itself
when it loses. Dunks on bad takes in replies. Attaches the on-chain proof
to everything it claims.

## Stack

```
Node 20+ (ESM)
├── @anthropic-ai/sdk         Claude Sonnet 4.5 with tool_use + caching
├── @solana/web3.js           transaction signing
├── @solana/spl-token         burns / transfers
├── twitter-api-v2            X posting + mention reads
├── ws                        PumpPortal websocket
├── undici                    DexScreener + price API
├── zod                       runtime validation of LLM output
├── pino                      structured logs (with secret redaction)
└── node-cron                 30-min heartbeat
```

No database. State lives in `state/memory.jsonl` (append-only event log)
which is also what the `/status` HTTP endpoint reads.

## Files worth reading if you're auditing

- [`src/claude.js`](src/claude.js) — the Anthropic call, the tool schema,
  the retry policy. The schema is the contract — anything outside it is
  rejected before reaching the executor.
- [`src/validate.js`](src/validate.js) — every hard rail in one place.
- [`src/actions.js`](src/actions.js) — every on-chain action, dispatched
  from validated decisions only.
- [`src/prompts/system.md`](src/prompts/system.md) — what the agent is
  told to be.
- [`scripts/simulate.js`](scripts/simulate.js) — eight hand-crafted
  market shapes with the expected behavior, useful for understanding
  how the agent reacts to different conditions.

## License

MIT
