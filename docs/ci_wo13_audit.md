# WO-13 — Final audit report (audited rev: 3f63f93, self-audit — NOT independent)
Posture: read-only. Tests re-run clean: **112/112 pass** (10 suites). Typecheck 0 errors.

## Findings
| ID | Sev | State | Finding |
|---|---|---|---|
| A-01 | HIGH | verified | **ChangeControl is advisory, not enforced on live paths.** Only callers: tests + seed script + HypothesisRegister. `arbRunner`/`executor` never call `propose()`. Live safety rests on pre-existing `mayExecute`/`armedFor`/`KILL` file (executor.ts:130,138 — verified present, NOT weakened). The new gate protects the CI learning loop only. **L4 remains OPEN.** |
| A-02 | INFO | verified | 112/112 tests pass at audited rev; fixtures labeled synthetic; no fixture presented as live. |
| A-03 | — | verified | Funnel reconciles to raw store: 95 arb records = 95 receiptVerified eligible; 83 visibility + 12 indeterminate = 95. Denominators honest; never-entered = n/a. |
| A-04 | LOW | partially verified | 14 legacy `net_profit_verified` records predate the traceVerified gate; provenance preserves original class. Should be re-graded per correction-trail policy (open). |
| A-05 | MED | verified w/ limit | Replay = original calldata, impersonated sender, fork@block-1, explicit gas. "PASS" means THEIR tx executable at that state — NOT that AllBright would have found/priced/captured it. Labeled estimated; never feeds confirmed_missed directly. |
| A-06 | MED | verified | Kill switch: `data/KILL` file halts all exec; `mayExecute` at executor.ts:138; no ARMED env set; nothing armed. Commander gates preserved. |
| A-07 | — | verified | Provenance: canonical `chain:tx[:idx]` ids, content-hash dedupe across restart, atomic tmp+rename, corrections never erase, quarantine gated-release. |
| A-08 | MED | partially verified | Trigger gates tested (13/13); statistical stability across market regimes NOT tested — small-sample rates can still fluctuate. |
| A-09 | LOW | partially verified | `commanderTokens` is an in-memory Set — no persistent authorization ledger; tokens are code constants, not secrets. Adequate for shadow; insufficient for live governance. |
| A-10 | — | not tested | Private order flow completeness, builder-side economics, trace-level verification — invisible to public data by design; cannot be tested from this corpus. |

## Verdict: CONDITIONAL PASS with stated limitations
Foundations (integrity/economics/attribution/governance-in-scope) are verified at tested scope. The learning-control loop is enforced for its own paths. The gate does not constrain actors that bypass it — that requires repo/CI-level controls outside this codebase's reach.

## L4 status: OPEN — not closed, not self-attested.
## Claims the evidence does NOT justify
- live profitability or production readiness
- "top-tier" or any competitive ranking claim
- that 0 confirmed_missed means no missed opportunities (unproven ≠ absent)
- that stage 2-4 zero-losses means those stages work broadly (n=12 entered)
- that registry expansion will produce profitable candidates (H-001 still baselined)
- that ChangeControl protects anything that doesn't call it (A-01)
