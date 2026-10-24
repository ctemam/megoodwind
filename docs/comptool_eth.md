# COMPTOOL v1.2 — eth
generated 2026-10-24T22:04:06.929Z | hash=a44fa9961668

## Top-3 benchmark (eligible=3/65)
- #1 0x0ea2bb9720 score=0.446 n=2 net=0.5580 conf=0.80
- #2 0x0000009ca1 score=0.196 n=2 net=0.2450 conf=0.80
- #3 0xa98e43a4ec score=-0.137 n=2 net=-0.1716 conf=0.80

## Scorecards (65)
| entity | score | rank | net$ | winRate | spanDays | active | completeness |
|---|---|---|---|---|---|---|---|
| 0x6177ce27f1 | n/a | n/a | unpriced | unknown | obs | 1 | INCOMPLETE |
| 0xb713bb675e | n/a | n/a | unpriced | unknown | obs | 1 | INCOMPLETE |
| 0xa0d5d65b70 | n/a | n/a | 0.0082 | 1/1 | obs | 2 | COMPLETE |
| 0xe75ed6f453 | n/a | n/a | 0.0015 | 1/1 | obs | 2 | COMPLETE |
| 0x32a23e34c3 | n/a | n/a | unpriced | unknown | obs | 1 | INCOMPLETE |
| 0x00000000fd | n/a | n/a | -0.0433 | 0/1 | obs | 2 | COMPLETE |
| 0x678111a6ca | n/a | n/a | 0.0027 | 1/1 | obs | 2 | COMPLETE |
| 0x00000027f4 | n/a | n/a | -0.0554 | 0/4 | obs | 4 | COMPLETE |
| 0xa98e43a4ec | -0.137 | 3 | -0.1716 | 1/2 | obs | 2 | COMPLETE |
| 0x67676767d7 | n/a | n/a | 0.0314 | 1/1 | obs | 1 | COMPLETE |
| 0xa672152198 | n/a | n/a | 0.0070 | 1/1 | obs | 1 | COMPLETE |
| 0x4811d9cc00 | n/a | n/a | 0.0002 | 1/1 | obs | 1 | COMPLETE |
| 0x0c8c5891a4 | n/a | n/a | -0.2465 | 2/6 | obs | 6 | COMPLETE |
| 0xdf8adfe10d | n/a | n/a | 0.4735 | 2/2 | obs | 2 | COMPLETE |
| 0xe41348ad94 | n/a | n/a | 0.0516 | 1/1 | obs | 1 | COMPLETE |

## Canonical findings — top-3 (13-section detail, every field statused)

### #1 0x0ea2bb97206abd78404a157d00cdbeff53597500
- **identity_provenance**: address=0x0ea2bb97206abd78404a157d00cdbeff535975; entityClass=verified (entity classification); kind=signer (signer/executor pair + cluster heuristic); confidence=0.8 (mean record confidence); cluster=false
- **benchmark_eligibility**: eligible=true (verified+n≥2+priced+!artifact); universe={"eligible":3,"total":65} (corpus-bounded — NOT market-wide)
- **competitive_score**: score=0.44636196566849384 (score-v1: net×conf×pricedShare); formula=score-v1: netUsdSum×confidence×pricedSha
- **rank**: rank=1 (of 3 scored); universe={"eligible":3,"total":65} (corpus-bounded — NOT market-wide)
- **profitability**: verifiedNet=unknown (no trace-level evidence in public-data c); estimatedNet=0.5579524570856172 (2/2 priced); profitPerTx=0.2789762285428086 (net over observed events); gasCostUsd=0.40069830686376195 (gasUsed×effectiveGasPrice×WETH); unpricedShare=0 (priced-event share); formula=estimatedNet = grossFlow − gas − flashFe
- **win_rates**: profitableExecution={"num":2,"den":2} (priced events only — unpriced excluded); executionSuccess=unknown (denominator unobservable publicly); opportunityCapture=unknown (opportunity universe undefined); benchmarkWin=not_applicable (requires head-to-head contests)
- **longevity_activity**: first=26264414 (observed ≠ launch); last=26264459; spanDays=0.006; activeBlocks=2; scanDepthLimit=bounded by observation windows
- **strategy_coverage**: fingerprints=["2hop/2venue"] (route-shape signature); chains=["eth"] (per-record chain field); note=route-shape ≠ strategy proof
- **execution_reliability**: revertRate=unknown (reverted attempts filtered — not observa); gasStats=0.40069830686376195 (gasUsed×effectiveGasPrice×WETH); inclusionLatency=unknown (mempool timing unobservable)
- **data_infrastructure**: sourceCoverage=public getLogs+receipts; traceAvailability=none — public corpus (caps econ at estimated); freshness=per-scan
- **evidence_quality**: entityType=verified; attributionConfidence=estimated; verifiedNetUsd=unknown; estimatedNetUsd=estimated; profitPerTx=estimated; gasCostUsd=estimated; unpricedShare=verified; competitiveScore=estimated; rankUniverse=estimated; executionSuccessRate=unknown; profitableExecutionRate=estimated; firstObservedBlock=estimated; lastObservedBlock=estimated; activeWindows=verified; fingerprints=estimated; chains=verified; entityClass=verified
- **allbright_comparison**: visibilityGap=pools-outside-registry dominant loss sta (WO-14 funnel); replayable=unknown (counterfactual corpus pending)
- **conclusion**: completeness=COMPLETE; missing=[]; claim=corpus-bounded observation; no profitabi

### #2 0x0000009ca1001530ef66088fcd2d9e8efe8ad9ce
- **identity_provenance**: address=0x0000009ca1001530ef66088fcd2d9e8efe8ad9; entityClass=verified (entity classification); kind=signer (signer/executor pair + cluster heuristic); confidence=0.8 (mean record confidence); cluster=false
- **benchmark_eligibility**: eligible=true (verified+n≥2+priced+!artifact); universe={"eligible":3,"total":65} (corpus-bounded — NOT market-wide)
- **competitive_score**: score=0.19599402969053414 (score-v1: net×conf×pricedShare); formula=score-v1: netUsdSum×confidence×pricedSha
- **rank**: rank=2 (of 3 scored); universe={"eligible":3,"total":65} (corpus-bounded — NOT market-wide)
- **profitability**: verifiedNet=unknown (no trace-level evidence in public-data c); estimatedNet=0.24499253711316765 (2/2 priced); profitPerTx=0.12249626855658383 (net over observed events); gasCostUsd=0.3297882925098182 (gasUsed×effectiveGasPrice×WETH); unpricedShare=0 (priced-event share); formula=estimatedNet = grossFlow − gas − flashFe
- **win_rates**: profitableExecution={"num":2,"den":2} (priced events only — unpriced excluded); executionSuccess=unknown (denominator unobservable publicly); opportunityCapture=unknown (opportunity universe undefined); benchmarkWin=not_applicable (requires head-to-head contests)
- **longevity_activity**: first=26264457 (observed ≠ launch); last=26264463; spanDays=0.001; activeBlocks=2; scanDepthLimit=bounded by observation windows
- **strategy_coverage**: fingerprints=["3hop/3venue","2hop/2venue"] (route-shape signature); chains=["eth"] (per-record chain field); note=route-shape ≠ strategy proof
- **execution_reliability**: revertRate=unknown (reverted attempts filtered — not observa); gasStats=0.3297882925098182 (gasUsed×effectiveGasPrice×WETH); inclusionLatency=unknown (mempool timing unobservable)
- **data_infrastructure**: sourceCoverage=public getLogs+receipts; traceAvailability=none — public corpus (caps econ at estimated); freshness=per-scan
- **evidence_quality**: entityType=verified; attributionConfidence=estimated; verifiedNetUsd=unknown; estimatedNetUsd=estimated; profitPerTx=estimated; gasCostUsd=estimated; unpricedShare=verified; competitiveScore=estimated; rankUniverse=estimated; executionSuccessRate=unknown; profitableExecutionRate=estimated; firstObservedBlock=estimated; lastObservedBlock=estimated; activeWindows=verified; fingerprints=estimated; chains=verified; entityClass=verified
- **allbright_comparison**: visibilityGap=pools-outside-registry dominant loss sta (WO-14 funnel); replayable=unknown (counterfactual corpus pending)
- **conclusion**: completeness=COMPLETE; missing=[]; claim=corpus-bounded observation; no profitabi

### #3 0xa98e43a4ec35d0a9612051df351dca70f8d4562b
- **identity_provenance**: address=0xa98e43a4ec35d0a9612051df351dca70f8d456; entityClass=verified (entity classification); kind=signer (signer/executor pair + cluster heuristic); confidence=0.8 (mean record confidence); cluster=false
- **benchmark_eligibility**: eligible=true (verified+n≥2+priced+!artifact); universe={"eligible":3,"total":65} (corpus-bounded — NOT market-wide)
- **competitive_score**: score=-0.13729179897605254 (score-v1: net×conf×pricedShare); formula=score-v1: netUsdSum×confidence×pricedSha
- **rank**: rank=3 (of 3 scored); universe={"eligible":3,"total":65} (corpus-bounded — NOT market-wide)
- **profitability**: verifiedNet=unknown (no trace-level evidence in public-data c); estimatedNet=-0.17161474872006566 (2/2 priced); profitPerTx=-0.08580737436003283 (net over observed events); gasCostUsd=0.3015539807079306 (gasUsed×effectiveGasPrice×WETH); unpricedShare=0 (priced-event share); formula=estimatedNet = grossFlow − gas − flashFe
- **win_rates**: profitableExecution={"num":1,"den":2} (priced events only — unpriced excluded); executionSuccess=unknown (denominator unobservable publicly); opportunityCapture=unknown (opportunity universe undefined); benchmarkWin=not_applicable (requires head-to-head contests)
- **longevity_activity**: first=26264280 (observed ≠ launch); last=26264315; spanDays=0.005; activeBlocks=2; scanDepthLimit=bounded by observation windows
- **strategy_coverage**: fingerprints=["2hop/2venue"] (route-shape signature); chains=["eth"] (per-record chain field); note=route-shape ≠ strategy proof
- **execution_reliability**: revertRate=unknown (reverted attempts filtered — not observa); gasStats=0.3015539807079306 (gasUsed×effectiveGasPrice×WETH); inclusionLatency=unknown (mempool timing unobservable)
- **data_infrastructure**: sourceCoverage=public getLogs+receipts; traceAvailability=none — public corpus (caps econ at estimated); freshness=per-scan
- **evidence_quality**: entityType=verified; attributionConfidence=estimated; verifiedNetUsd=unknown; estimatedNetUsd=estimated; profitPerTx=estimated; gasCostUsd=estimated; unpricedShare=verified; competitiveScore=estimated; rankUniverse=estimated; executionSuccessRate=unknown; profitableExecutionRate=estimated; firstObservedBlock=estimated; lastObservedBlock=estimated; activeWindows=verified; fingerprints=estimated; chains=verified; entityClass=verified
- **allbright_comparison**: visibilityGap=pools-outside-registry dominant loss sta (WO-14 funnel); replayable=unknown (counterfactual corpus pending)
- **conclusion**: completeness=COMPLETE; missing=[]; claim=corpus-bounded observation; no profitabi

## Outstanding evidence requirements
- verified net → debug_trace · true win rate → attempt denominator · capture rate → opportunity universe · inclusion latency → mempool timing · launch dates → earlier evidence

_Evidence class: shadow/public-data. estimated≠verified. Missing=unknown, never 0._