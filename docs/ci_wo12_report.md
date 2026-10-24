# WO-12 — Integrated end-to-end learning-loop demonstration
rev: this commit | run IDs: laneA=e2e-fixture-001, laneB=live-scan-series (data/ci/store.json, schema ci-v3/mc-v1)

## Lane A — deterministic fixture (13/13 PASS)
Command: `npx tsx test/ci_e2e_test.ts` (fixtures labeled synthetic)
Traced end-to-end: observe→attribute→report→trigger→hypothesis→changeControl.
- T1 one observation traced by canonical eventId through all stages
- T2 dedupe (replay×3 → 1 unique), T3 n<20 suppressed w/ reason
- T4 full trigger→H-001 path fires on persistence=2
- T5 accepted only via lifecycle; T6 Class-C denied even when accepted
- T7 Class-B recorded-not-applied w/o approval; T8 restart dedupe after flush
- T9 correction trail; T10 unpriced→indeterminate; T11 kill; T12 daily cap

## Lane B — live shadow (real evidence, honest non-fires)
Real scans @e7590d2..a92541a: observe 34 verified arbs → attribution
(visibility_failure=18|26, indeterminate=1|8 by window) → trigger eval →
SUPPRESSED (minsample n=19<20 on latest; earlier window armed streak=1).
No live fire = correct under gates. Replay: 2 cases → both visibility_failure
(counterfactual can't fix stage-1 absence). zero confirmed_missed — honest.

## Acceptance-gate mapping
- deterministic run reproducible: test/ci_e2e_test.ts ✅
- live run reconciles to persisted store ✅ (95+ records, non-fires recorded)
- linked identifiers: eventId chain:tx / window records / hypothesis ids ✅
- change-control: eligible B denied-unapplied, C denied ✅
- no live exec/signing/spend ✅ | L4 repo gap OPEN ✅

## Known limitations
- replay resolves only fully-covered routes (visibility gate precedes econ)
- 14 legacy net_profit_verified records predate traceVerified gate
- threat board counts are observable activity, not profit
- test count ≠ production safety; L4 enforcement unverified
