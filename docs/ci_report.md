# CI report — eth (generated 2026-10-24T19:21:03.900Z)
evidence class: shadow/public-data | store records: 95 trusted, 0 quarantined

## Coverage (mc-v1 windows)
- window:26264337-26264397 blocks 26264337.. complete=true ordering=eth_builder_mev
- window:26264340-26264420 blocks 26264340.. complete=true ordering=eth_builder_mev
- window:26264403-26264483 blocks 26264403.. complete=true ordering=eth_builder_mev
- window:26264467-26264547 blocks 26264467.. complete=true ordering=eth_builder_mev

## Entity classes (n=95)
- provisional_eoa_signer: 59
- unclassifiable_decode_artifact: 2
- verified_active_eoa_signer: 11
- provisional_contract: 19
- verified_active_contract: 4

## Economic statuses
- economics_incomplete: 7
- net_profit_verified: 14
- net_profit_estimated: 74

## Performance ranking (verified+econ gated, top 5)
- #1 0x0ea2bb9720 n=2 net=0.5580 conf=0.80 []
- #2 0x0000009ca1 n=2 net=0.2450 conf=0.80 []
- #3 0xa98e43a4ec n=2 net=-0.1716 conf=0.80 []
- unranked 0x6177ce27f1 n=1 net=unpriced conf=0.00 [below_min_sample,all_unpriced,1/1 unpriced,provisional_evidence]
- unranked 0xb713bb675e n=1 net=unpriced conf=0.00 [below_min_sample,all_unpriced,1/1 unpriced,provisional_evidence]
## Threat/capability ranking (observable only, top 5)
- #1 0x0c8c5891a4 n=6 provisional
- #2 0x1722261741 n=6 provisional
- #3 0x00000027f4 n=4 provisional
- #4 0x17701ea471 n=3 provisional
- #5 0x9f107b7d2a n=3 provisional

## Trigger states (armed≠fired; suppressed≠no-problem)
- vis-fail-gt-50 → H-001 | disarmed | threshold gt0.5 persist=2 n≥20 cov≥0.95
- indet-gt-10 → H-002 | disarmed | threshold gt0.1 persist=1 n≥8 cov≥0.95
counters: fired=0 dup=0 cooldown=0 hyst=0 quality=0 minsample=0 killed=0
NOTE: suppressed_minsample/coverage means "insufficient qualifying evidence" — NOT "no problem exists".

## Hypotheses
- H-001 [baselined] Expand pool discovery beyond the 207-pool registry (additional factory matrices + creation | baseline visibility_failure_rate=0.765 | accept lt0.5 n≥20
- H-002 [baselined] Pinned-block counterfactual replay for the 8 indeterminate attributions | baseline indeterminate_rate=0.235 | accept lt0.1 n≥8

## Store quality counters
```json
{
 "received": 130,
 "unique": 99,
 "dupsSuppressed": 22,
 "incomplete": 4,
 "quarantined": 0,
 "released": 0,
 "unpricedProfit": 0,
 "unresolvedIdentity": 83,
 "reconciled": 3,
 "reprocessed": 0
}
```
_All figures shadow/public-data. net=estimated unless trace-verified. Nothing live, nothing armed._