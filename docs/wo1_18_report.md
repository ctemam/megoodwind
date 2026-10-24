# AllBright — Work Order Report to Principal

All work orders WO-1 through WO-16 complete; WO-17 (profit optimization)
and WO-18 (predictive strategy expansion) added to the ledger below.
Branch `feat/direct-swap-exec` @ `1aac2d2` (pushed).

## WO-1 → WO-16 status table

| WO | Scope | Result | Status |
|---|---|---|---|
| **WO-1** | OOM diagnosis | Abandoned-WSS lanes + reconnect leak found & fixed; `memWatch` telemetry (RSS/heap/handles/post-GC) | ✅ fixed — `04e07e2` |
| **WO-1b** | Memory verification | 60-min soak: post-GC heap flat; heapsnap cleanup + `.gitignore` data dirs; secret-grep clean | ✅ done |
| **WO-2** | Bounded diag lane | `DIAG_ONLY` structurally refuses at `executeCandidate`; capped per-stage jsonl; strict bool env parse; counter epoch per code version | ✅ done — `121b15d` |
| **WO-3** | *(not issued)* | — | — |
| **WO-4** | Fork exec canary | Anvil: detect→solve→probe→exec→flash→repay→`ArbSettled` + receipt | ✅ accepted — `0074991` |
| **WO-5/5b** | Profit/gas model | Measurement-grade net model; predicted $50.85 vs realized $50.95 (0.2%) | ✅ accepted — `c4b32ae` |
| **WO-6** | Sizing matrix + 35-min eth census | 18 cells, 26k rows → **0 probe_pass**; only bait pools clear K×gas | ✅ accepted as evidence — `7ac9b77` |
| **WO-7** | L2 discovery fixes + funnel + backrun census | base 377 + arb 540 pools; 1 base `probe_pass` ($2.56); **0 dislocations** | ✅ submitted — `9976f7a` |
| **WO-7S** | WO-7 sync/verify | Deployed executor on 3 chains is **stale bytecode**; venue getters revert | ✅ done — `9976f7a` |
| **WO-8** | Base candidate validation + 24h shadow | Funnel verdict data → handed to WO-8.6 | ✅ superseded |
| **WO-8.6** | Close-out verdict | `docs/wo8_verdict.md` — **DEAD as-built**; counterfactual UNDECIDED pending C_run | ✅ verdict issued |
| **WO-8.7** | `skill.md` upgrade | +126 lines: closed-form sizing, bundle pricing, liquidation math, source ledger, WO-map enforcement | ✅ done — `30c8e77` |
| **WO-9** | Direct `pool.swap` executor + per-pool fees + redeploy | `V3_POOL` + `V2_SELFQUOTE` legs; real `getFee` reads; closed-form sizing (p90 err 3.5e-8); eth fork `ArbSettled` $81.10; **WO-9 replay: 0/3 recorded candidates settle — phantom edge confirmed** | ✅ impl; ⛔ redeploy = Commander |
| **WO-10** | Liquidation lane | Aave V3 fork settle $61,802; **Morpho Blue fork settle $35,963 USDC** (`protocolKind=1`, `onMorphoLiquidate` approve-pull, bound-math sizing); `LiquidationIndexer` + `MorphoIndexer` + runner watch | ✅ capability proven — `1aac2d2` |
| **WO-11** | Private order flow + learned bidding | `mev_sendBundle`, MEV-Share hint stream, backrun planner, logistic bid model + CUSUM freeze — **shadow only** | ✅ built — `92d947b` |
| **WO-12** | Chain×token×pool×lane allocation | `src/alloc/allocation.ts` → `data/allocation.json` (27 lane-scores; all-zero — no settled evidence) | ✅ measured — `d9e1029` |
| **WO-13** | Self-learning | `src/learn/thompson.ts` — Beta-Gaussian arms, feature rows, freeze on divergence | ✅ built — `d9e1029` |
| **WO-14** | Latency + same-block backrun attribution | `LatencyTracker` stamped into executeCandidate (detect→solve→probe→submit→land); `firstMover` attribution | ✅ wired — `30aa01b` |
| **WO-15** | Ops hardening | kill file, daily loss breaker, capital caps, `mayExecute` **now enforced pre-submit**; `CONGESTED`+`DEGRADED_INFO` regimes (fail-closed) | ✅ enforced — `af4c238`/`d9810db` |
| **WO-16** | Paid-RPC economics | `src/ops/rpcEconomics.ts` → `data/rpc_upgrade_recommendation.json` = **no spend** under current evidence | ✅ measured — `d9e1029` |

## WO-17 — Profit optimization (new)

Objective: maximize **realized, risk-adjusted net profit over time** —
not detection count or simulator gross. Factor-by-factor status:

| Factor | Module | Status | Evidence |
|---|---|---|---|
| **Net accounting equation** | `math/profit.ts`, `solver.ts` | ✅ live | `grossUsd − premiumUsd − gasUsd = netUsd` on every candidate |
| Atomic minOut/minProfit | `contracts/AllBrightExecutor.sol` | ✅ live | on-chain floors; `V3_MINOUT` proved honest on base replay |
| Flash principal+repay cover | `contracts/AllBrightExecutor.sol` | ✅ live | repay checked inside callback before profit floor |
| Revert-cost accounting | `src/ops/killSwitch.ts` | ✅ live | landed reverts → `revert_gas` → daily loss breaker |
| **Market structure / opportunity quality** | `strategies/solver.ts` + `graph.ts` | ✅ live | Bellman-Ford cycles + cross-venue P01; distinct lanes not one count |
| DEX-to-DEX difference post-impact | `legOut` v2 CP + `v3AmountOutInTick` | ✅ fixed | was spot×(1−fee) → exact in-tick; replay 0/3 phantom |
| Pool-curve/liquidity differences | closed-form sizing + `priceImpactBps` | ✅ live | interior p90 err 3.5e-8 vs brute |
| Lending-market dislocations | `src/liquidation/lane.ts` | ✅ fork-proven | Aave $61,802 + Morpho $35,963 settles |
| Transaction-ordering effects | `src/exec/privateRoute.ts` | ✅ live | `eth_callBundle` gate + `eth_sendBundle` private rail |
| **Execution/inclusion uncertainty** | `src/exec/executor.ts` + `pimlico.ts` | ✅ live | exec-probe → bundle gate → sponsored UserOp → receipt |
| **Data quality/staleness** | `refresh.ts`, `rpcPool.ts`, `marketRegime.ts` | ✅ live | staleness counts, peer-divergence convictions, `DEGRADED_INFO` fail-closed |
| **Capital/borrowing costs** | `exec/flashVenues.ts` | ✅ live | Balancer 0% → Morpho/Maker 0% → Aave 0.09% last resort |
| **Competition/bidding** | `src/bidding/bidModel.ts` | 🟡 shadow | logistic model cold — no landed bundle ledger yet |
| Failed-tx competition loss | `recordLoss(revert_gas)` | ✅ live | failed inclusion feeds the breaker |
| **Operational overhead** | `src/ops/rpcEconomics.ts` | ✅ measured | paid-RPC trigger = **no spend** today |
| **Security/ops safeguards** | `mayExecute`, `armedFor`, `DIAG_ONLY` | ✅ enforced | kill/loss/capital gate pre-submit; DIAG hard-stop |
| **Observability/stage accounting** | `telemetry/*`, `LatencyTracker` | ✅ live | stage counts, rejection reasons, settled-only ledger |
| **Legit vs harmful MEV** | strategy design | ✅ clean | DEX price-discovery + protocol liquidation; no sandwich path exists |
| **Missing measurements** | — | 🟡 | bundle-ledger realized-net reconciliation; per-regime settled attribution |
| **Unverified assumptions** | — | 🟡 | Wiley 2025 study cited-not-read; VariantScheduler has ~0 settled data |

## WO-18 — Predictive strategy × chains × tokens × pools (new)

The framework's proposed matrix vs actual:

| Axis | Proposed | Actual | Notes |
|---|---|---|---|
| Strategy families | 8 | 5 + 2 lanes | MOMENTUM/MEAN_REVERSION/STAT_ARB/CROSS_PAIR_VOL/MICROSTRUCTURE + liq (WO-10) + private flow (WO-11) |
| Variants | 16 | 12 | V01–V12 = **configurations of ONE hypothesis** on shared state, not 12 independent strategies — per the framework's own independence test |
| Regimes | 5 | 6 | all 5 proposed classes implemented (incl. `CONGESTED`, `DEGRADED_INFO`) |
| Chains | — | 6 | eth, base, arb, op, poly, avax |
| Tokens/pools | — | discovered, not hand-seeded | factory matrix + token lists + Multicall3 refresh (AGENTS.md rule) |
| Realized evidence | — | **0 settled** on any live chain | all measured gates say don't arm/spend yet |

## Principal's decision surface (unchanged, Commander-held)

1. **Executor redeploy** — needed to arm any lane (current deployed bytecode is stale); recommend approve as capability infrastructure.
2. **Arm one chain** (WO-15) — after redeploy verification.
3. **Paid RPC** (WO-16) — no measured trigger today.
4. **C_run inputs** for the WO-8.6 counterfactual verdict.

## Bottom line

Every work order through WO-16 is either proven on evidence or honestly
measured as zero/dead — nothing is armed, nothing is claimed live.
WO-17 keeps the machine honest about what counts as profit; WO-18 keeps
the expansion honest about what counts as a strategy.
