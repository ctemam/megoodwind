# WO-12 → WO-16 — allocation, learning, speed, ops, RPC economics

All four layers built, wired to measured inputs only. None of them can
manufacture edge — they allocate, learn, and harden what exists.

## WO-12 — allocation scoring (`src/alloc/allocation.ts`, `scripts/compute_allocation.ts`)

`data/allocation.json` ranks chain × lane by measured `($/day × probe-pass
rate) / (gas + RPC load + competition)`. First run: **all lanes score 0** —
honest, because zero lanes have settled records. base `dex_arb` shows the
only nonzero probe-pass rate (1e-3) — consistent with every prior verdict.

## WO-13 — self-learning (`src/learn/thompson.ts`)

Thompson sampling over chain×lane×variant arms: Beta posterior on win-rate
× Gaussian payoff model (rare-but-fat wins rank correctly) + feature rows
persisted per cycle + **freeze on CUSUM miscalibration > 5** (uniform
weights while frozen — never silently learning into a broken model).
Bait reputation: per-pool posterior feeds the conviction path.

## WO-14 — speed (`src/speed/latency.ts`)

Stage-instrumented timestamps (detect→solve→probe→submit→land) +
`firstMover` attribution — every missed opportunity classified:
competitor-moved-state (lost_race to latency) vs model error. This is the
measured input to WO-16's latency-value trigger and WO-14's <150ms target.

## WO-15 — ops hardening (`src/ops/killSwitch.ts`)

- `data/KILL` file + `data/kill.json{chain}` — fail-closed; unreadable kill file halts.
- Daily loss breaker: `revert_gas` + `settled_loss` summed from `data/ops/losses.jsonl`, UTC-day bucketed — trips the gate.
- Capital caps: per-tx + per-day-notional ceilings.
- `mayExecute()` is the single gate every submit path must call.
- Arming remains Commander-only: the module REFUSES nothing by default but provides the only lawful arm path (WO-15 spec: one chain, measured caps).

## WO-16 — RPC economics (`src/ops/rpcEconomics.ts`)

`data/rpc_upgrade_recommendation.json` — two measured triggers only:
budget exhaustion >70% on a profitable chain, or lost-race value >
next-tier $/day. Current recommendation: **no spend** — usage ratio and
lost-race value are both ~0 (no live execution to lose races on).

## What this stack CANNOT do (stated plainly)

Allocate, learn, harden, and time-box all you want — if no lane produces
settles, every score stays 0 and every recommendation stays "no spend."
These layers make AllBright **correct by construction when edge exists**;
they do not conjure edge. The measured reality today: capability is proven
(WO-9/10 fork settles), live edge is not demonstrated — which is precisely
what these layers exist to detect honestly.
