# AllBright research inventory — variants, families, regimes, rotation

Framework request: map the proposed **8 families × 16 variants × 5 regimes**
matrix to what actually exists in the codebase, with provenance and gaps.
Documentation only — no code changes per the evidence-before-expansion order.

## A. What actually exists (measured from the code)

### Variants — 12 defined (`src/engine/predictiveEngine.ts:21-33`)

| ID | slippageBps | minDepthUsd | maxBlockDelay | sizeCapUsd | pendIntensity | Tagged family |
|---|---|---|---|---|---|---|
| V01 | 5 | 500k | 1 | 25k | low | MOMENTUM |
| V02 | 10 | 500k | 1 | 50k | low | MOMENTUM |
| V03 | 15 | 250k | 1 | 100k | med | MICROSTRUCTURE |
| V04 | 20 | 250k | 2 | 100k | med | MEAN_REVERSION |
| V05 | 15 | 100k | 1 | 50k | med | STAT_ARB |
| V06 | 25 | 100k | 2 | 75k | med | MEAN_REVERSION |
| V07 | 30 | 50k | 2 | 50k | high | CROSS_PAIR_VOL |
| V08 | 15 | 1M | 1 | 250k | low | STAT_ARB |
| V09 | 40 | 25k | 3 | 25k | high | CROSS_PAIR_VOL |
| V10 | 10 | 750k | 1 | 150k | low | MOMENTUM |
| V11 | 50 | 10k | 3 | 10k | high | CROSS_PAIR_VOL |
| V12 | 15 | 250k | 2 | 100k | med | MICROSTRUCTURE |

**Honesty check (the framework's own independence test):** the 12 variants
differ only in guard parameters — slippage bound, depth floor, delay,
size cap, mempool intensity. All consume the *same* pool state and the
same solver. Per the research definition, these are **configurations of
one hypothesis** (venue-gap capture under parameterized risk envelopes),
not 12 independent strategies. True independent information sources in
the codebase: mempool pending txs (whale lane), MEV-Share hints (WO-11),
liquidation HF events (WO-10) — those are genuinely distinct.

### Families — 5 tagged (`src/engine/strategyRouter.ts:26-37`)

MOMENTUM (V01,V02,V10) · MEAN_REVERSION (V04,V06) · STAT_ARB (V05,V08) ·
CROSS_PAIR_VOL (V07,V09,V11) · MICROSTRUCTURE (V03,V12) — vs 8 proposed.
Missing vs the proposal: liquidation-economics, private-order-flow, and
cross-chain classes are not "families" here — they are separate lanes
(WO-10/11), correctly so.

### Regimes — 4 implemented (`src/engine/marketRegime.ts:18-22`)

`HIGH_VOL_TRENDING · LOW_VOL_MEAN_REVERTING · ILLIQUID_CRASH · BALANCED`
vs the framework's 5 proposed (ordinary / elevated-vol / constrained-
liquidity / congestion / degraded-information). Map:

| Proposed | Implemented | Evidence |
|---|---|---|
| ordinary | `BALANCED` | default classification |
| elevated volatility | `HIGH_VOL_TRENDING` | volBps ≥ 25 + trend ≥0.35 |
| constrained liquidity | `ILLIQUID_CRASH` | illiquidFrac > 0.5 (stale-state share) |
| network congestion | — | **not a class** — baseFee/priorityFee gates do this implicitly |
| degraded information | — | **not a class** — dead-lane/timeout counts exist but don't gate regime |

Two proposed classes have no code analog — flagged, not hidden.

### Rotation — `VariantScheduler` (`predictiveEngine.ts:52-103`)

Rotates on: settled-evidence score (netUsd), reverts, latency anomalies,
emit counts. Regime gate pre-filters eligible families each cycle
(`strategyRouter.ts:43-47`). Evidence basis is real but thin — 0 settles
on any chain means the scheduler has almost no win/loss data yet.

## B. Proposed 8×16×5 vs actual 5×12×4 — gap analysis

| Dimension | Proposed | Actual | Gap |
|---|---|---|---|
| families | 8 | 5 (+2 lanes: liq, private) | semantic — the "missing" 3 exist as lanes not families |
| variants | 16 | 12 | 4 unused slots; more configurations ≠ more hypotheses |
| regimes | 5 | 4 (+2 unclassified: congestion, degraded-info) | 2 proposed classes unmapped |
| independence | distinct hypotheses | 1 hypothesis × 12 configs + 3 distinct sources | core audit finding |

## C. Provenance (sources cited by the framework)

| Source | Status in AllBright |
|---|---|
| Uniswap protocol docs (v2/v3/v4 differences) | v2 exact + v3 in-tick implemented; v4 unwired |
| Wiley 2025 price-discovery study | UNVERIFIED — cited, not read; informs regime conditioning direction only |
| Flashbots bundle docs | eth_callBundle gate + mev_sendBundle live |
| Aave flash-loan docs | `flashLoanSimple` + liquidationCall verified on fork |

## D. What the audit supports vs what it forbids

- **Supported:** the family/regime structure is real and correctly gated;
  the config-vs-strategy distinction is now explicit; rotation uses
  settled evidence only.
- **Forbidden by evidence:** calling this an "8×16×5 matrix" — it is
  5×12×4 with two regime classes unimplemented and variants that are
  configurations, not hypotheses. Do not scale the grid before the
  independent information sources (mempool, hints, liquidation) carry
  their own measured evidence.
