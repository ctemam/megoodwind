# H-001 Integration Review — AUDIT ONLY (read-only, no changes authorized)
## Scope
H-001: selective registry expansion to reduce visibility failures.
Result: corrected bound 18.9% <50% accepted; circular 0% rejected (correction trail preserved).

## Findings
| # | Sev | Finding | Evidence |
|---|---|---|---|
| R1 | HIGH | **No integration target specified** — H-001 record has `target:undefined`, `classification:undefined`. The hypothesis was accepted on a metric, but *what code/config/data changes* was never bound to it. Integration is meaningless without a concrete proposal. | hypotheses.json H-001 fields |
| R2 | MED | **Integration mechanism exists but is unbound** — `integrate()` requires accepted→ChangeProposal→cc.propose(); the proposal must name a target path (registry data file? discovery config? backfill script enablement?) to classify A/B/C. | hypotheses.ts:76-80 |
| R3 | MED | **Two distinct integration interpretations** — (a) one-shot data merge of verified candidate pools into registry; (b) persistent mechanism change (enable backfill enumeration in discovery boot). Different blast radii, different classes. R1 blocks choosing. | review analysis |
| R4 | LOW | **Baseline compat confirmed** — frozen 656079b7 (207 pools) is a registry-content snapshot, not code; expansion to candidates doesn't invalidate the hash for rollback. | ci_h001_eth.md |
| R5 | LOW | **COMPTOOL compat confirmed** — scorecard/report contract is entity-level, pool-count-independent. | canonicalReport.ts |
| R6 | MED | **Safety gates unaffected by registry growth** — minOut/minProfit/kill/mayExecute live downstream of discovery; adding pools widens the graph but every execution still passes unchanged gates. Forensics bait-pool layer would run on new pools. | arbRunner/executor |

## Class-B requirements for integration
- Concrete proposal with named target path(s) + diffs
- Validation evidence (shadow run of treatment registry vs baseline on pinned window — H-001's 18.9% is this)
- Commander approval token per hypotheses.integrate()
- Rollback = frozen 656079b7 registry (preserved)

## L4 interaction
NONE — registry content is adaptive Class-B, not protected DNA. L4 governs execution-path authorization, orthogonal.

## Recommended decision: DEFER
Accept H-001's metric verdict but require a **concrete integration proposal** before Class-B review:
1. Specify target: recommend (b) — enable backfill in discovery boot as the mechanism, NOT a one-shot pool merge (a data merge rots; the mechanism keeps finding).
2. Estimate blast radius: pool-count growth → solver-eval CPU, forensics scan cost, RPC refresh cost per cycle.
3. Shadow-validate the treatment registry end-to-end (H-001's bound is per-record math, not a live integrated run).

## Governance confirmed
no live exec/signing | no paid RPC | no unauthorized backfill | baseline frozen | L4 open
