# Ablation plan — extended acceptance (Commander-required checks)
A=full | B=CORE+GUARDRAIL | C=B−1 CORE. Pinned corpus (78 entities, hash b192cfad3413).
## Required evidence per Commander
| check | test |
|---|---|
| metric equivalence | canonical values/units/dens identical post-dedupe — same source fields, no recompute |
| decision equivalence | winner verdict + discoveryPriority set identical on pinned corpus |
| adverse cases | missing/stale/dup/unreconcilable/contradictory → defined safe result (fallback_empty, not silent-0) |
| economic integrity | estNet≠verifiedNet enforced; unknown cost blocks verified — regression T2 of scorecard suite |
| ranking correctness | ineligible can't win; ties deterministic (sort stable); insufficient→INSUFFICIENT_EVIDENCE |
| regression | all CI suites pass incl. 6/6 causal priority tests |
| resource impact | MEASURED render ms + store size — not inferred; dedupe expected to be display-layer only |
## Key distinction (Commander)
Goal = consolidate REPRESENTATIONS not evidence. Dedupe expected benefit = clarity/storage, measured — NOT hot-path latency claim.
