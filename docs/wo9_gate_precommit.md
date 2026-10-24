# WO-9 Gate A / Gate B — pre-commitment (written before any replay)

This document defines the pass/fail gates BEFORE the measurements are
taken. A failed gate retires the lane — it is not retuned to pass.
The gates are numbered; no claim of live readiness is permitted
without satisfying both, in writing, with the recorded inputs.

## Inputs (recorded with the run)

- Candidate set: every `probe_pass` row in `data/probes/<chain>.jsonl`
  for the measured window, plus any new rows during the window.
- Method: replay each through the CURRENT executor on a fork pinned
  to the recorded block; the model prediction is the in-tick
  `v3AmountOutInTick` figure, not the legacy approximation.
- The executor address under test is the candidate for redeploy —
  the one whose bytecode the D2 package verifies.

## Gate A — executable-edge existence

| Criterion | Threshold | Rationale |
|---|---|---|
| sample size N | **≥ 12** distinct-block candidates | 3 samples (current) is not statistically meaningful |
| settle ratio | **≥ 20%** of candidates settle `ArbSettled`/`LiquidationSettled` | below this the lane's edge is below capture noise |
| no phantom inflation | settle tx receipt `success=true` AND event emitted | receipts are the only truth |
| model error | mean |model−realized| / realized **≤ 5%** | the old model was off ~0.5–1% on thin pools — the exact cause of the phantom |

If Gate A fails on any criterion: the lane is **retired**, the
candidates are archived as evidence, and the next decision is
structural (different lanes/protocols/chains), not parameter-tuned.

## Gate B — capital-safety floor

| Criterion | Threshold | Rationale |
|---|---|---|
| settled net vs floor | every settle ≥ `minProfit` on-chain | the floor is atomic, not advisory |
| reverts | landed-revert gas ≤ 1% of settled gross | a revert-heavy lane burns quota + operator cost |
| ops gate | `mayExecute` must pass without exception | a blocked submit can never be counted as edge |
| shadow period | **≥ 72 h** of armed-shadow cycles with ≥ 1 settle AND zero unexplained reverts | a single lucky settle is not a strategy |

If Gate B fails: the lane is **capped to minimum-capital probing** —
it does not scale, and the spend is not authorized.

## Reporting rules (locked)

- Both gates report denominators + windows, e.g. "3/14 settles over
  blocks 23.1M–23.4M, base fee 0.8–1.4 gwei".
- "✅" in any report means "verified at this evidence class" —
  fork / replay / shadow / live — never "code exists".
- Only `arb_settled_net_usd` (and `liquidation_settled` where a
  liquidation lane is under test) counts as profit.
- A gate failure is raised immediately; it is never averaged away.

## Commander-held outputs

- Gate A pass + Gate B pass → the lane is **eligible for arming**
  under the WO-15 capital caps; the arming itself is your call.
- Any fail → lane retired or capped; the verdict doc is updated.
