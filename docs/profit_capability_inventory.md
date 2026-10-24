# Profit capability inventory (rev d843a92, audit-only)
## Canonical modules — one per economic calculation
| capability | module | status | consumer |
|---|---|---|---|
| UniV2 quote+K | math/univ2.ts getAmountOut | VERIFIED (fee-bps formula, 0-guard) | solver/plans |
| UniV3 quote | math/univ3.ts | IMPLEMENTED_UNVERIFIED | solver |
| optimal size t* | math/sizing.ts (closed-form R1) | VERIFIED (WO-9 formula) | planBuilder |
| net = gross−gas−flash−bribe | math/profit.ts netUsd | VERIFIED | all econ |
| flash venue truth | exec/flashVenues.ts | VERIFIED (0% pref) | executor |
| exec probe | exec/verify.ts execProbe | VERIFIED | executor/pimlico |
| shadow probes | exec/shadowProbe.ts | VERIFIED (stateOverride 1ETH) | shadow loop |
| econ reconstruction | ci/economics.ts | VERIFIED 12/12 | ci store |
| discovery+priority | discovery/discovery.ts Phase-0 | VERIFIED 6/6 causal | boot |
| CI: store/rank/bench/scorecard/cmmc/deconstruct/projacc | src/ci/* | VERIFIED (per-suite) | dashboard |
| kill/arming | ops/killSwitch.ts+armedFor | VERIFIED | executor |
## K() failure — root cause mapped
| stage | file | finding |
|---|---|---|
| candidate gen | shadowProbe.ts uses cand.borrowAmount directly | sizes from candidate, NOT optimal-t* |
| reserves | feed/refresh.ts merged refresh | reserves at refresh time ≠ exec-block |
| sizing math EXISTS | math/sizing.ts t* closed-form | **NOT USED by shadow path** — the correction module exists |
| invariant | univ2 K enforced on-chain | correctly rejects oversized |
## THE gap: shadow candidate generation bypasses math/sizing.ts + uses stale reserves → K() at exec. Repair = route candidates through t*+fresh reserves, not a new module.
## Pairing lost: shadow_candidates.jsonl has projection fields; settled.json has none — projection never persisted to settled records. Same class of defect as grossUsd.
## Duplicates flagged: none for econ (single netUsd+getAmountOut); scorecard/bench rank fields intentionally layered.
