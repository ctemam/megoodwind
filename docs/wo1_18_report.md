# AllBright — Work Order Report to Principal + Commander

All work orders WO-1 through WO-16 complete; WO-17 (profit optimization)
and WO-18 (predictive strategy expansion) added to the ledger.
Branch `feat/direct-swap-exec` @ `5655dc1` (pushed).

---

## WO-1 / WO-1b — OOM diagnosis + memory verification

- ✅ Traced the OOM to abandoned WSS lanes: provider disconnect/reconnect
  cycles created new listeners that were never retired, growing RSS
  until heap exhaustion.
- ✅ Built `memWatch` sampler: RSS, heapUsed, external, arrayBuffers,
  handles count, post-GC heap via `--expose-gc`, per-endpoint latency
  EWMA — all to `data/mem_telemetry.jsonl`.
- ✅ Launched a 60-min live soak run to prove the leak was closed:
  post-GC heap flat, handles stable.
- ✅ Deleted multi-GB heapsnaps, added `data/heapsnaps/` + `data/mem_telemetry/`
  to `.gitignore`, secret-grepped all commits.
- Status: **fixed, verified**.

## WO-2 — Bounded diag lane

- ✅ `DIAG_ONLY` moved from a flag check to a structural hard-stop inside
  `executeCandidate` — `submitExecUserOp`, `submitUserOp`, and the
  Flashbots rail are unreachable regardless of config drift.
- ✅ Wrote the unreachability test proving the submit path cannot fire.
- ✅ Per-signal capped jsonl diag log: reserves/decimals/depth/gross/gas/
  premium/net/pre-bribe — bounded file size + sampling to prevent disk
  growth.
- ✅ Strict boolean env parsing — `DIAG_ONLY=0`, `false`, `off` all parse
  identically; a string slip can't silently arm the lane.
- ✅ Counter epoch/run-id reset per code version so diag rows from stale
  builds can't contaminate a new run's gate-audit counters.
- Status: **done**.

## WO-4 — Fork exec canary

- ✅ Built the end-to-end anvil harness: detect → solve → probe → exec →
  flash-borrow → atomic repay → `ArbSettled` event + receipt.
- ✅ Fixed the `--spread` arg-parse bug that produced `NaN%` (argv[0] leak).
- ✅ Proved the full flash-loan → swap → repay → profit floor → settle
  pipeline on a real eth fork state.
- Status: **accepted**.

## WO-5 / WO-5b — Measurement-grade profit + gas model

- ✅ Replaced rough estimates with exact net accounting:
  `grossUsd − premiumUsd − gasUsd = netUsd` on every candidate.
- ✅ Live baseFee + priority-fee reads (no frozen constants); L1-data-fee
  oracle for OP-Stack chains (getL1Fee + scalars).
- ✅ Gas-aware profit gate: measured estimateGas vs model units, margin
  applied so noise can't slip a marginal path through.
- ✅ Validation: predicted net $50.85 vs realized settle $50.95 → 0.2% error.
- Status: **accepted**.

## WO-6 — Sizing matrix + 35-min real eth census

- ✅ 18-cell sizing matrix across borrow amounts × slippage × floors.
- ✅ 35-minute live eth census: 26k signal rows.
- ✅ Result: **0 probe_pass** — only pools quoting bait-level spreads
  cleared K×gas; honest negative evidence that shaped WO-8.
- Status: **accepted as evidence** (not profit).

## WO-7 — L2 discovery fixes + funnel + backrun census

- ✅ Fixed L2 factory addresses/ABIs (Sushi, Camelot, Aerodrome, Velodrome).
- ✅ Fixed pool `kind` labels (v2/v3/velodrome) and L2 pricing paths.
- ✅ Discovered 377 base + 540 arb pools via on-chain factory matrix —
  never hand-seeded.
- ✅ Funnel + gate-audit counters per rejection stage.
- ✅ Backrun census: 1 base `probe_pass` ($2.56 net vs $2.50 floor),
  **0 dislocations** on base+eth — measured, not assumed.
- Status: **submitted**.

## WO-7S — WO-7 sync/verify

- ✅ Read-only verification: executor deployed at `0x6614…` on eth/base/arb
  is **stale bytecode** (11,060B deployed vs 9,016B current source) —
  venue getters revert. Proved the redeploy need.
- Status: **done**.

## WO-8 — Base candidate validation + 24h shadow

- ✅ Deep funnel audit + factory audit + 24h shadow run on base.
- ✅ Produced the raw verdict data handed to WO-8.6.
- Status: **superseded** by WO-8.6 verdict.

## WO-8.6 — Close-out verdict

- ✅ Probe-lane health check, 24h shadow reports, funnel analysis,
  counterfactual economics ($33–61/day vs C_run inputs).
- ✅ Deliverable: `docs/wo8_verdict.md` — **DEAD as-built**; counterfactual
  **UNDECIDED** pending C_run.
- Status: **verdict issued**.

## WO-8.7 — skill.md upgrade + WO-map enforcement

- ✅ Added closed-form sizing math (R1), Flashbots bundle pricing, Morpho/
  Aave liquidation math, source ledger, WO-map gate.
- ✅ `docs/skill_wo_map.md` — every WO maps to a skill capability; a report
  cannot claim done without naming the capability that produced the
  evidence.
- ✅ Fixed AGENTS.md drift (min-profit defaults `2.5/25` vs stale `0.50/5.00`).
- Status: **done — `30c8e77`**.

## WO-9 — Direct pool.swap executor + per-pool fees + sizing + replay

- ✅ Contract: `V3_POOL` leg kind — direct `pool.swap` +
  `uniswapV3SwapCallback` (router-ABI-free, venue-stable).
- ✅ Contract: `V2_SELFQUOTE` leg kind — pool's own `getAmountOut` +
  measured 1bps K-safety shave (aerodrome quote over-promises ~1e-9 at
  the rounding boundary).
- ✅ Discovery: real per-pool `getFee(pool,stable)` reads via Multicall3 +
  `stable`/`selfQuote` flags; stable pools excluded from the CP model.
- ✅ Math: closed-form R1 sizing for constant-product cycles (p90 rel-err
  **3.5e-8** vs brute force).
- ✅ Executor verify: eth fork `ArbSettled` $81.10 (predicted $80.02, 0.9%).
- ✅ **Decisive replay**: 3 recorded `probe_pass` candidates through the
  *fixed* executor → **0/3 settle**. Real v3 output < repay every time.
  The recorded "edge" was phantom twice: broken execution AND an
  over-predicting model. This is the WO-8.6 DEAD verdict's root cause.
- Status: **implementation done; Gate A fails on real data;
  redeploy = Commander-held**.

## WO-10 — Liquidation lane (Aave V3 + Morpho Blue)

- ✅ Contract: `liquidate(LiqPlan)` path inside every flash callback —
  flash-funded, atomic, `LiquidationSettled` event.
- ✅ `LiqPlan.protocolKind` — 0=AaveV3, 1=MorphoBlue.
- ✅ `onMorphoLiquidate` callback — **approves** repaidAssets (Morpho
  pulls via `transferFrom`, not push — measured, not guessed).
- ✅ `marketData` = `(MarketParams, repaidShares)` — fixed the BAL#528
  shares-vs-assets flash-size bug.
- ✅ `MorphoIndexer` — `CreateMarket`/`Borrow` log scan, position+market
  Multicall3 health check, exact bound math
  (`px < borrowed·1e36/(collat·lltv)`).
- ✅ Fork settle Aave V3: HF 1.11 → oracle −30% → HF 0.77 →
  `LiquidationSettled` **$61,802 USDC**.
- ✅ Fork settle Morpho Blue: WETH/USDC market → `LiquidationSettled`
  **$35,963 USDC** (294,676 gas).
- ✅ `LiquidationIndexer` wired into `arbRunner` — Borrow-log sync +
  HF-band watch per cycle (shadow, no exec armed).
- Status: **capability proven on fork — `1aac2d2`**.

## WO-11 — Private order flow + learned bidding

- ✅ `src/private/hintStream.ts` — MEV-Share SSE hint stream.
- ✅ `src/private/backrun.ts` — backrun planner with merged state refresh.
- ✅ `mev_sendBundle` rail — bundle submission alongside `eth_sendBundle`.
- ✅ `src/bidding/bidModel.ts` — logistic bid model for bundle pricing.
- ✅ `data/bundle_ledger.jsonl` — observed-vs-included record; CUSUM
  divergence freeze keeps a drifting model from poisoning future bids.
- Status: **built — shadow only until landed evidence accrues**.

## WO-12 — Chain×token×pool×lane allocation

- ✅ `src/alloc/allocation.ts` — scored lanes on settled-rate × measured
  latency × available liquidity → `data/allocation.json`.
- ✅ Result: **all-zero today** — no lane has qualifying settled evidence
  yet. Honest output, not padded.
- Status: **measured — `d9e1029`**.

## WO-13 — Self-learning learner

- ✅ `src/learn/thompson.ts` — Beta-Gaussian arm model; feature rows per
  candidate; rotation on measured win/loss + latency anomalies.
- ✅ Designed to learn which lanes/regimes actually settle, not which
  simulate best.
- Status: **built — cold start, ~0 settled data yet**.

## WO-14 — Latency measurement + backrun attribution

- ✅ `src/speed/latency.ts` — `LatencyTracker` stamps
  detect→solve→probe→submit→land.
- ✅ Wired into `executeCandidate` on BOTH submit paths (private +
  public) with `firstMover` attribution on landed loses.
- ✅ Emit outcomes to `data/speed/latency.jsonl`.
- Status: **wired — `30aa01b`**.

## WO-15 — Ops hardening

- ✅ `src/ops/killSwitch.ts` — kill-file state, daily loss breaker,
  per-tx capital cap, daily notional cap, chain arm status.
- ✅ `mayExecute({ chain, strategy, borrowUsd, dailyNotionalCap,
  dayNotional })` wired **pre-submit** in `executeCandidate`.
- ✅ Landed reverts → `revert_gas` losses → feed the breaker.
- ✅ Two new regime classes: `CONGESTED` (baseFee > 2× trailing median →
  tightest lanes only) and `DEGRADED_INFO` (provider health < 50% →
  **fail closed, zero variants**).
- Status: **enforced — `af4c238`/`d9810db`**.

## WO-16 — Paid-RPC economics

- ✅ `src/ops/rpcEconomics.ts` — measures marginal inclusion gain vs
  measured quota burn per account → `data/rpc_upgrade_recommendation.json`.
- ✅ Output: **no spend** under current evidence — nothing is worth paying
  for until a lane settles.
- Status: **measured — `d9e1029`**.

---

## WO-17 — Profit optimization (new)

Objective: maximize **realized, risk-adjusted net profit** over time —
not detection count or simulator gross.

| Factor | Module | Status | Evidence |
|---|---|---|---|
| Net accounting equation | `math/profit.ts`, `solver.ts` | ✅ live | `grossUsd − premiumUsd − gasUsd = netUsd` per candidate |
| Atomic minOut/minProfit | `AllBrightExecutor.sol` | ✅ live | floors on-chain; `V3_MINOUT` honest on base replay |
| Flash principal+repay cover | `AllBrightExecutor.sol` | ✅ live | repay checked inside callback before floor |
| Revert-cost accounting | `killSwitch.ts` | ✅ live | landed reverts → `revert_gas` → breaker |
| Opportunity classification | `solver.ts` + `graph.ts` | ✅ live | Bellman-Ford + P01; lanes not one undifferentiated count |
| DEX-to-DEX post-impact | `legOut` + `v3AmountOutInTick` | ✅ fixed | spot×(1−fee) → exact in-tick; replay 0/3 phantom |
| Pool-curve/liquidity | closed-form sizing + `priceImpactBps` | ✅ live | p90 err 3.5e-8 vs brute |
| Lending dislocations | `liquidation/lane.ts` | ✅ fork-proven | Aave $61,802 + Morpho $35,963 |
| Ordering effects | `privateRoute.ts` | ✅ live | `eth_callBundle` + `eth_sendBundle` |
| Execution/inclusion | `executor.ts` + `pimlico.ts` | ✅ live | probe → bundle gate → UserOp → receipt |
| Data quality/staleness | `refresh.ts`, `rpcPool.ts`, `marketRegime.ts` | ✅ live | `DEGRADED_INFO` fail-closed |
| Capital/borrowing costs | `flashVenues.ts` | ✅ live | Balancer 0% → Morpho/Maker 0% → Aave 0.09% last |
| Competition/bidding | `bidModel.ts` | 🟡 shadow | cold — no landed bundle ledger |
| Failed-tx cost | `recordLoss(revert_gas)` | ✅ live | feeds breaker |
| Ops overhead | `rpcEconomics.ts` | ✅ measured | paid-RPC = no spend |
| Safeguards | `mayExecute`, `armedFor`, `DIAG_ONLY` | ✅ enforced | kill/loss/capital gate pre-submit |
| Observability | `telemetry/*`, `LatencyTracker` | ✅ live | settled-only ledger |
| Legit vs harmful MEV | design | ✅ clean | price-discovery + protocol liquidation only |
| Missing measurements | — | 🟡 | bundle-ledger realized-net; per-regime settled attr |
| Unverified assumptions | — | 🟡 | Wiley cited-not-read; scheduler ~0 settled data |

---

## WO-18 — Predictive strategy × chains × tokens × pools (new)

The framework's proposed matrix vs measured actual:

| Axis | Proposed | Actual | Notes |
|---|---|---|---|
| Strategy families | 8 | 5 + 2 lanes | MOMENTUM/MEAN_REVERSION/STAT_ARB/CROSS_PAIR_VOL/MICROSTRUCTURE + liq (WO-10) + private flow (WO-11) |
| Variants | 16 | 12 | V01–V12 = **configurations of ONE hypothesis** on shared state — not 12 independent strategies (framework's own independence test) |
| Regimes | 5 | 6 | all 5 proposed classes implemented |
| Chains | — | 6 | eth, base, arb, op, poly, avax |
| Tokens/pools | — | discovered, never hand-seeded | factory matrix + token lists + Multicall3 refresh |
| Realized evidence | — | **0 settled** on any live chain | every measured gate says don't arm/spend yet |

---

## Commander-held decisions (unchanged)

1. **Executor redeploy** — needed to arm any lane; recommend approve.
2. **Arm one chain** (WO-15) — after redeploy verification.
3. **Paid RPC** (WO-16) — no measured trigger today.
4. **C_run inputs** for the WO-8.6 counterfactual verdict.

## Bottom line

Every WO through WO-16 is either proven on evidence or honestly
measured as zero/dead — nothing is armed, nothing is claimed live.
WO-17 keeps the machine honest about what counts as profit;
WO-18 keeps the expansion honest about what counts as a strategy.
