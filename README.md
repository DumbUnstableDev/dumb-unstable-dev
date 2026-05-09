# ai-dev

```
....01100110....
...10......01...
...01......10...
...........01...
..........10....
.........01.....
........10......
.......01.......
.......01.......
................
.......01.......
.......01.......
```

An autonomous AI agent that runs a pump.fun memecoin treasury.

It receives all creator fees, decides on a heartbeat what to do with them
— buy back, burn, distribute, lottery, invest, sell, dex-boost, or hold —
and posts the reasoning on X with the on-chain proof attached.

The decisions come from Claude (Anthropic) through a structured `tool_use`
call, constrained by an in-character system prompt and validated against
hard safety rails before any transaction is signed.

The point isn't another memecoin. The point is to take a memecoin's
treasury and put it under a model with a personality, a budget, and the
ability to be wrong publicly.

## What this repo is (and isn't)

This is a **public showcase** of how the live agent works. It contains:

- The actual system prompt the agent uses (its "mind")
- The decision space (10 actions) and validator (the rails)
- The data sources, the trading layer, the Twitter integration
- Simulation harness with hand-crafted market shapes

It does **not** contain:

- The genesis / launch script — you can't fork this to spawn a copy
- Treasury private keys, recovery wallets, or any operational secrets
- The cookies / API tokens the live agent uses
- Anything specific to the live agent's mint address or X handle

You can read this top-to-bottom and understand exactly how it operates.
You cannot deploy a clone of it from here. Both are intentional.

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
- **daily limit** — configurable
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
to everything it claims. When asked who created it, deflects with sarcasm
— never names a real person.

## Stack

```
Node 20+ (ESM)
├── @anthropic-ai/sdk         Claude Sonnet 4.5 with tool_use + caching
├── @solana/web3.js           transaction signing
├── @solana/spl-token         burns / transfers
├── twitter-api-v2            X posting (paid v2 path)
├── agent-twitter-client      X posting (cookie path, free)
├── ws                        PumpPortal websocket
├── undici                    DexScreener + price API
├── zod                       runtime validation of LLM output
├── pino                      structured logs (with secret redaction)
└── node-cron                 heartbeat
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
- [`src/twitter.js`](src/twitter.js) — hybrid auth (cookies preferred,
  paid API as fallback) plus prompt-injection sanitization on mentions.
- [`scripts/simulate.js`](scripts/simulate.js) — eight hand-crafted
  market shapes with the expected behavior, useful for understanding
  how the agent reacts to different conditions.

## License

MIT
