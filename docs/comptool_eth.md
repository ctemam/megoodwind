# COMPTOOL v1.2 — eth
generated 2026-10-24T22:22:29.664Z | hash=89066770c6b0

## CMMC mandatory metrics (18 rows, gate=PASS)
| metric_id | metric_name | value | unit | num | den | status | reason |
|---|---|---|---|---|---|---|---|
| uni.records | observed records | 135 | count | 135 | - | VERIFIED | - |
| uni.entities | observed entities | 78 | count | 78 | - | VERIFIED | - |
| uni.eligible | benchmark-eligible entities | 0.051282 | ratio | 4 | 78 | VERIFIED | - |
| uni.excluded | excluded entities | 0.948718 | ratio | 74 | 78 | ESTIMATED | - |
| funnel.visibility | visibility loss | 0 | ratio | 0 | 135 | VERIFIED | - |
| econ.estimated | estimated-net records | 127 | count | 127 | - | ESTIMATED | - |
| econ.verified | verified-net records | 0 | count | 0 | - | VERIFIED | - |
| econ.unpriced | unpriced records | 1 | count | 1 | - | ESTIMATED | - |
| econ.recon_ok | reconciliation pass | 39 | count | 39 | - | VERIFIED | - |
| econ.recon_fail | reconciliation fail | 0 | count | 0 | - | VERIFIED | - |
| econ.unreconcilable_legacy | legacy no-gross records | 88 | count | 88 | - | VERIFIED | - |
| bench.scored | scored entities | 0.051282 | ratio | 4 | 78 | VERIFIED | - |
| bench.provisional | provisional (n<5) | 0.75 | ratio | 3 | 4 | ESTIMATED | - |
| bench.negative_net | negative-net eligible | 0 | ratio | 0 | 4 | VERIFIED | - |
| quality.verified | evidence verified | 390 | count | 390 | - | VERIFIED | - |
| quality.unknown | evidence unknown | 322 | count | 322 | - | VERIFIED | - |
| quality.estimated | evidence estimated | 614 | count | 614 | - | VERIFIED | - |
| ops.run | pipeline run | 1 | count | 1 | - | VERIFIED | - |

## Top-3 benchmark (eligible=4/78)
- #1 0x0ea2bb9720 score=0.446 n=2 net=0.5580 conf=0.80
- #2 0x0000009ca1 score=0.196 n=2 net=0.2450 conf=0.80
- #3 0x0759116b96 score=0.092 n=2 net=0.1151 conf=0.80

## Scorecards (78)
| entity | score | rank | net$ | winRate | spanDays | active | completeness |
|---|---|---|---|---|---|---|---|
| 0x6177ce27f1 | n/a | n/a | unpriced | unknown | obs | 1 | INCOMPLETE |
| 0xb713bb675e | n/a | n/a | unpriced | unknown | obs | 1 | INCOMPLETE |
| 0xa0d5d65b70 | n/a | n/a | 0.0082 | 1/1 | obs | 2 | COMPLETE |
| 0xe75ed6f453 | n/a | n/a | 0.0076 | 2/2 | obs | 3 | COMPLETE |
| 0x32a23e34c3 | n/a | n/a | unpriced | unknown | obs | 1 | INCOMPLETE |
| 0x00000000fd | n/a | n/a | -0.0433 | 0/1 | obs | 2 | COMPLETE |
| 0x678111a6ca | n/a | n/a | 0.0027 | 1/1 | obs | 2 | COMPLETE |
| 0x00000027f4 | n/a | n/a | -0.1057 | 2/8 | obs | 8 | COMPLETE |
| 0xa98e43a4ec | -0.137 | 4 | -0.1716 | 1/2 | obs | 2 | COMPLETE |
| 0x67676767d7 | n/a | n/a | 0.0314 | 1/1 | obs | 1 | COMPLETE |
| 0xa672152198 | n/a | n/a | 0.0070 | 1/1 | obs | 1 | COMPLETE |
| 0x4811d9cc00 | n/a | n/a | 0.0002 | 1/1 | obs | 1 | COMPLETE |
| 0x0c8c5891a4 | n/a | n/a | -0.6292 | 5/15 | obs | 15 | COMPLETE |
| 0xdf8adfe10d | n/a | n/a | 0.4735 | 2/2 | obs | 2 | COMPLETE |
| 0xe41348ad94 | n/a | n/a | 0.0516 | 1/1 | obs | 1 | COMPLETE |

## Canonical findings — top-3 (13-section detail, every field statused)

### #1 (provisional n<5) 0x0ea2bb97206abd78404a157d00cdbeff53597500
- **identity_provenance**: address=0x0ea2bb97206abd78404a157d00cdbeff535975; entityClass=verified (entity classification); kind=signer (signer/executor pair + cluster heuristic); confidence=0.8 (mean record confidence); cluster=false
- **benchmark_eligibility**: eligible=true (verified+n≥2+priced+!artifact); universe={"eligible":4,"total":78} (corpus-bounded — NOT market-wide)
- **competitive_score**: score=0.44636196566849384 (score-v1: net×conf×pricedShare); formula=score-v1: netUsdSum×confidence×pricedSha
- **rank**: rank=1 (of 4 scored); universe={"eligible":4,"total":78} (corpus-bounded — NOT market-wide)
- **profitability**: verifiedNet=unknown (no trace-level evidence in public-data c); estimatedNet=0.5579524570856172 (2/2 priced); profitPerTx=0.2789762285428086 (net over observed events); gasCostUsd=0.40069830686376195 (gasUsed×effectiveGasPrice×WETH); unpricedShare=0 (priced-event share); formula=estimatedNet = grossFlow − gas − flashFe
- **win_rates**: profitableExecution={"num":2,"den":2} (priced events only — unpriced excluded); executionSuccess=unknown (denominator unobservable publicly); opportunityCapture=unknown (opportunity universe undefined); benchmarkWin=not_applicable (requires head-to-head contests)
- **longevity_activity**: first=26264414 (observed ≠ launch); last=26264459; spanDays=0.006; activeBlocks=2; scanDepthLimit=bounded by observation windows
- **strategy_coverage**: fingerprints=["2hop/2venue"] (route-shape signature); chains=["eth"] (per-record chain field); note=route-shape ≠ strategy proof
- **execution_reliability**: revertRate=unknown (reverted attempts filtered — not observa); gasStats=0.40069830686376195 (gasUsed×effectiveGasPrice×WETH); inclusionLatency=unknown (mempool timing unobservable)
- **data_infrastructure**: sourceCoverage=public getLogs+receipts; traceAvailability=none — public corpus (caps econ at estimated); freshness=per-scan
- **evidence_quality**: entityType=verified; attributionConfidence=estimated; verifiedNetUsd=unknown; estimatedNetUsd=estimated; profitPerTx=estimated; gasCostUsd=estimated; unpricedShare=verified; competitiveScore=estimated; rankUniverse=estimated; executionSuccessRate=unknown; profitableExecutionRate=estimated; firstObservedBlock=estimated; lastObservedBlock=estimated; activeWindows=verified; fingerprints=estimated; chains=verified; entityClass=verified
- **allbright_comparison**: visibilityGap=pools-outside-registry dominant loss sta (WO-14 funnel); replayable=unknown (counterfactual corpus pending)
- **conclusion**: completeness=COMPLETE; missing=[]; claim=corpus-bounded observation; no profitabi

### #2 (provisional n<5) 0x0000009ca1001530ef66088fcd2d9e8efe8ad9ce
- **identity_provenance**: address=0x0000009ca1001530ef66088fcd2d9e8efe8ad9; entityClass=verified (entity classification); kind=signer (signer/executor pair + cluster heuristic); confidence=0.8 (mean record confidence); cluster=false
- **benchmark_eligibility**: eligible=true (verified+n≥2+priced+!artifact); universe={"eligible":4,"total":78} (corpus-bounded — NOT market-wide)
- **competitive_score**: score=0.19599402969053414 (score-v1: net×conf×pricedShare); formula=score-v1: netUsdSum×confidence×pricedSha
- **rank**: rank=2 (of 4 scored); universe={"eligible":4,"total":78} (corpus-bounded — NOT market-wide)
- **profitability**: verifiedNet=unknown (no trace-level evidence in public-data c); estimatedNet=0.24499253711316765 (2/2 priced); profitPerTx=0.12249626855658383 (net over observed events); gasCostUsd=0.3297882925098182 (gasUsed×effectiveGasPrice×WETH); unpricedShare=0 (priced-event share); formula=estimatedNet = grossFlow − gas − flashFe
- **win_rates**: profitableExecution={"num":2,"den":2} (priced events only — unpriced excluded); executionSuccess=unknown (denominator unobservable publicly); opportunityCapture=unknown (opportunity universe undefined); benchmarkWin=not_applicable (requires head-to-head contests)
- **longevity_activity**: first=26264457 (observed ≠ launch); last=26264463; spanDays=0.001; activeBlocks=2; scanDepthLimit=bounded by observation windows
- **strategy_coverage**: fingerprints=["3hop/3venue","2hop/2venue"] (route-shape signature); chains=["eth"] (per-record chain field); note=route-shape ≠ strategy proof
- **execution_reliability**: revertRate=unknown (reverted attempts filtered — not observa); gasStats=0.3297882925098182 (gasUsed×effectiveGasPrice×WETH); inclusionLatency=unknown (mempool timing unobservable)
- **data_infrastructure**: sourceCoverage=public getLogs+receipts; traceAvailability=none — public corpus (caps econ at estimated); freshness=per-scan
- **evidence_quality**: entityType=verified; attributionConfidence=estimated; verifiedNetUsd=unknown; estimatedNetUsd=estimated; profitPerTx=estimated; gasCostUsd=estimated; unpricedShare=verified; competitiveScore=estimated; rankUniverse=estimated; executionSuccessRate=unknown; profitableExecutionRate=estimated; firstObservedBlock=estimated; lastObservedBlock=estimated; activeWindows=verified; fingerprints=estimated; chains=verified; entityClass=verified
- **allbright_comparison**: visibilityGap=pools-outside-registry dominant loss sta (WO-14 funnel); replayable=unknown (counterfactual corpus pending)
- **conclusion**: completeness=COMPLETE; missing=[]; claim=corpus-bounded observation; no profitabi

### #3 (provisional n<5) 0x0759116b9658f27dfddf00a313aadc49431f5463
- **identity_provenance**: address=0x0759116b9658f27dfddf00a313aadc49431f54; entityClass=verified (entity classification); kind=signer (signer/executor pair + cluster heuristic); confidence=0.8 (mean record confidence); cluster=false
- **benchmark_eligibility**: eligible=true (verified+n≥2+priced+!artifact); universe={"eligible":4,"total":78} (corpus-bounded — NOT market-wide)
- **competitive_score**: score=0.0921092120534633 (score-v1: net×conf×pricedShare); formula=score-v1: netUsdSum×confidence×pricedSha
- **rank**: rank=3 (of 4 scored); universe={"eligible":4,"total":78} (corpus-bounded — NOT market-wide)
- **profitability**: verifiedNet=unknown (no trace-level evidence in public-data c); estimatedNet=0.11513651506682912 (2/2 priced); profitPerTx=0.05756825753341456 (net over observed events); gasCostUsd=0.057268298071607944 (gasUsed×effectiveGasPrice×WETH); unpricedShare=0 (priced-event share); formula=estimatedNet = grossFlow − gas − flashFe
- **win_rates**: profitableExecution={"num":2,"den":2} (priced events only — unpriced excluded); executionSuccess=unknown (denominator unobservable publicly); opportunityCapture=unknown (opportunity universe undefined); benchmarkWin=not_applicable (requires head-to-head contests)
- **longevity_activity**: first=26265001 (observed ≠ launch); last=26265057; spanDays=0.008; activeBlocks=2; scanDepthLimit=bounded by observation windows
- **strategy_coverage**: fingerprints=["3hop/3venue"] (route-shape signature); chains=["eth"] (per-record chain field); note=route-shape ≠ strategy proof
- **execution_reliability**: revertRate=unknown (reverted attempts filtered — not observa); gasStats=0.057268298071607944 (gasUsed×effectiveGasPrice×WETH); inclusionLatency=unknown (mempool timing unobservable)
- **data_infrastructure**: sourceCoverage=public getLogs+receipts; traceAvailability=none — public corpus (caps econ at estimated); freshness=per-scan
- **evidence_quality**: entityType=verified; attributionConfidence=estimated; verifiedNetUsd=unknown; estimatedNetUsd=estimated; profitPerTx=estimated; gasCostUsd=estimated; unpricedShare=verified; competitiveScore=estimated; rankUniverse=estimated; executionSuccessRate=unknown; profitableExecutionRate=estimated; firstObservedBlock=estimated; lastObservedBlock=estimated; activeWindows=verified; fingerprints=estimated; chains=verified; entityClass=verified
- **allbright_comparison**: visibilityGap=pools-outside-registry dominant loss sta (WO-14 funnel); replayable=unknown (counterfactual corpus pending)
- **conclusion**: completeness=COMPLETE; missing=[]; claim=corpus-bounded observation; no profitabi

## All entities — canonical summaries (78)
| entity | eligible | score | estNet | profitableExec | spanDays | activeBlks | fingerprints | completeness | missing |
|---|---|---|---|---|---|---|---|---|---|
| 0x6177ce27f1 | false | n/a | unpriced | unknown | 0 | 1 | ["3hop/3venue"] | INCOMPLETE | [] |
| 0xb713bb675e | false | n/a | unpriced | unknown | 0 | 1 | ["2hop/2venue"] | INCOMPLETE | [] |
| 0xa0d5d65b70 | false | n/a | 0.0082 | 1/1 | 0.004 | 2 | ["2hop/2venue","3hop/3venue"] | COMPLETE | [] |
| 0xe75ed6f453 | false | n/a | 0.0076 | 2/2 | 0.104 | 3 | ["3hop/3venue"] | COMPLETE | [] |
| 0x32a23e34c3 | false | n/a | unpriced | unknown | 0 | 1 | ["3hop/3venue"] | INCOMPLETE | [] |
| 0x00000000fd | false | n/a | -0.0433 | 0/1 | 0.009 | 2 | ["2hop/2venue","3hop/3venue"] | COMPLETE | [] |
| 0x678111a6ca | false | n/a | 0.0027 | 1/1 | 0.019 | 2 | ["3hop/3venue","2hop/2venue"] | COMPLETE | [] |
| 0x00000027f4 | false | n/a | -0.1057 | 2/8 | 0.118 | 8 | ["3hop/3venue","2hop/2venue"] | COMPLETE | [] |
| 0xa98e43a4ec | false | -0.137 | -0.1716 | 1/2 | 0.005 | 2 | ["2hop/2venue"] | COMPLETE | [] |
| 0x67676767d7 | false | n/a | 0.0314 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xa672152198 | false | n/a | 0.0070 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x4811d9cc00 | false | n/a | 0.0002 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x0c8c5891a4 | false | n/a | -0.6292 | 5/15 | 0.115 | 15 | ["3hop/3venue","2hop/2venue"] | COMPLETE | [] |
| 0xdf8adfe10d | false | n/a | 0.4735 | 2/2 | 0.006 | 2 | ["3hop/3venue"] | COMPLETE | [] |
| 0xe41348ad94 | false | n/a | 0.0516 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x3373b3b26b | false | n/a | 0.0204 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xb1056bf4c1 | false | n/a | -0.0933 | 0/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xaf6d057f77 | false | n/a | 3.1716 | 1/2 | 0.001 | 2 | ["2hop/2venue"] | COMPLETE | [] |
| 0x5ae028a647 | false | n/a | -0.0175 | 1/2 | 0.021 | 2 | ["3hop/3venue"] | COMPLETE | [] |
| 0x1722261741 | false | n/a | 0.2628 | 6/8 | 0.1 | 8 | ["3hop/3venue","2hop/2venue"] | COMPLETE | [] |
| 0x00030021ce | false | n/a | 0.4887 | 3/4 | 0.115 | 4 | ["3hop/3venue","2hop/2venue"] | COMPLETE | [] |
| 0x979159f671 | false | n/a | 0.0403 | 3/3 | 0.097 | 3 | ["3hop/3venue","2hop/2venue"] | COMPLETE | [] |
| 0x17701ea471 | false | n/a | 0.9657 | 3/3 | 0.016 | 3 | ["2hop/2venue","3hop/3venue"] | COMPLETE | [] |
| 0xdd9ca63877 | false | n/a | -0.0163 | 0/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x986e61850e | false | n/a | 0.0545 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x9f107b7d2a | false | n/a | 0.0177 | 3/3 | 0.023 | 3 | ["2hop/2venue","3hop/3venue"] | COMPLETE | [] |
| 0xb7c854ed55 | false | n/a | 0.0542 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x87067a1c39 | false | n/a | 0.2300 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x0000006c61 | false | n/a | -0.1147 | 0/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xace00000a7 | false | n/a | 0.3884 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x4f54f1e99a | false | n/a | -0.0965 | 0/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xae2fc48352 | false | n/a | -1.7373 | 2/3 | 0.102 | 3 | ["2hop/2venue","3hop/3venue"] | COMPLETE | [] |
| 0x8d7b8b84c1 | false | n/a | 0.0012 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0xf344beecd6 | false | n/a | 0.0273 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x86d549fb9a | false | n/a | 0.0140 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xae0cc0d6e7 | false | n/a | 0.0123 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xae7cc97da2 | false | n/a | 0.2008 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x0ea2bb9720 | true | 0.446 | 0.5580 | 2/2 | 0.006 | 2 | ["2hop/2venue"] | COMPLETE | [] |
| 0xc3e754457c | false | n/a | 0.2090 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xc54b77b28e | false | n/a | 1585.5399 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0xb6a3638f6d | false | n/a | 13.1578 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x196c00c1b0 | false | n/a | 0.0009 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x0cab9af0ec | false | n/a | -0.0342 | 0/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xabbd7bdbfa | false | n/a | 0.2347 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xb47ed46cd1 | false | n/a | 0.0098 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0xfadad4b17f | false | n/a | 2.0431 | 2/2 | 0.093 | 2 | ["3hop/3venue"] | COMPLETE | [] |
| 0x56ac8bd1d9 | false | n/a | 0.2818 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x32429725b8 | false | n/a | 0.0472 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xfa7b153477 | false | n/a | 0.0097 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x0000009ca1 | true | 0.196 | 0.2450 | 2/2 | 0.001 | 2 | ["3hop/3venue","2hop/2venue"] | COMPLETE | [] |
| 0x3397921fbe | false | n/a | 0.2618 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0xab5159f3f4 | false | n/a | 0.1508 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x51058e3818 | false | n/a | 2.0178 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x4aa351d68c | false | n/a | 0.8032 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0xfd3b318fcf | false | n/a | 0.3835 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xe4faaa80cc | false | n/a | 0.0001 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x588228351d | false | n/a | 0.0513 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x004b38217d | false | n/a | 0.0003 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x71d78e4552 | false | n/a | -0.1000 | 0/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x000000cb1e | false | n/a | 0.0022 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x4eacca2e85 | false | n/a | 0.0157 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xe850915015 | false | n/a | 6.2569 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x8b906c704f | false | n/a | 0.0567 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0xb19c265d24 | false | n/a | 1.4758 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xeedcbb56e5 | false | n/a | 0.0283 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x27c2a1733f | false | n/a | 0.0002 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xa0f1c3ad83 | false | n/a | 0.2688 | 3/3 | 0.018 | 3 | ["2hop/2venue"] | COMPLETE | [] |
| 0x9a313b57ae | false | n/a | 1.2403 | 3/3 | 0.013 | 3 | ["3hop/3venue"] | COMPLETE | [] |
| 0x0759116b96 | true | 0.092 | 0.1151 | 2/2 | 0.008 | 2 | ["3hop/3venue"] | COMPLETE | [] |
| 0x8bcb9e335c | false | n/a | 0.0003 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x7efd55ad1e | false | n/a | 0.0100 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x06bb0e57ae | false | n/a | unpriced | unknown | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0xc8d76705b4 | false | n/a | 0.1462 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0x0000007ac1 | false | n/a | 0.0012 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |
| 0xe80629c1f9 | false | n/a | 0.0497 | 2/2 | 0.005 | 2 | ["2hop/2venue","3hop/3venue"] | COMPLETE | [] |
| 0xfcc52994d4 | false | n/a | 0.0159 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x6f63d6bc23 | false | n/a | 0.0175 | 1/1 | 0 | 1 | ["2hop/2venue"] | COMPLETE | [] |
| 0x9c82b458fd | false | n/a | 0.0010 | 1/1 | 0 | 1 | ["3hop/3venue"] | COMPLETE | [] |

_Full 13-section detail for any entity: `data/ci/dashboard_eth.json` → canonicalReports[entityId]. Same run, same source of truth._

## Outstanding evidence requirements
- verified net → debug_trace · true win rate → attempt denominator · capture rate → opportunity universe · inclusion latency → mempool timing · launch dates → earlier evidence

_Evidence class: shadow/public-data. estimated≠verified. Missing=unknown, never 0._