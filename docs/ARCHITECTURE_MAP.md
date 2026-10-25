# AllBright architecture map (rev 52d0a69, read-only audit)
## Top-level tree
```
src/  ~8,938 LOC 74 modules
  config/  index,logger,pricing          env+chain+venue truth
  runner/  arbRunner.ts                  THE entry — boot+loop
  scout/   scoutListener.ts              newHeads+pending feed
  discovery/ discovery,factories,tokenLists,rpcRegistry   pool universe on-chain
  feed/    dexscreener,refresh           quotes+decimals
  strategies/ solver.ts,graph.ts         P01/P02/TRACE + Bellman-Ford
  engine/  marketRegime,predictiveEngine,strategyRouter   regime+variants+gate
  exec/    executor,verify,planBuilder,flashVenues,privateRoute,pimlico,flashbots,gasModel,shadowProbe,deployment
  math/    profit,sizing,univ2,univ3     canonical econ+quotes+optimal-size
  pools/   registry.ts                   PoolState store+byPair index
  forensics/ baitPool.ts                 convictions (bait/divergence/scam)
  providers/ rpcPool,rpcPoolConfig,providerCatalog,multicall,l1Fee,wss,blockscout,bitquery
  ops/     killSwitch,rpcEconomics
  private/ backrun,hintStream,reconcile  backrun lane
  services/ whaleTracker.ts              whale→cross-pair gap
  learn/   thompson.ts                   bandit
  liquidation/ lane.ts                   liq lane
  alloc/   allocation.ts, bidding/ bidModel.ts, speed/ latency.ts
  ci/      22 modules (COMPTOOL)         store→econ→attrib→rank→scorecard→bench→cmmc→deconstruct→spread→projacc→runStatus
  telemetry/ metrics,metricsServer,signalSink,diagLog,memWatch
apps/dashboard/   Express :3001 + React :9205
contracts/        AllBrightExecutor.sol + IDex/IFlash + mocks
test/     44 suites (ci_* + anvil/fork + multicall + inventory)
scripts/  ~30 (ci_*, shadow, monitor, sync, watchdog)
data/     store/settled/shadow/registries/leaders/monitor/runtime
docs/     ~40 audit+spec+report docs
```
## Strategy × variant × regime (the mandatory map)
| strategy | lanes | variants | regime gate |
|---|---|---|---|
| TRACE (settled-evidence) | all | V01–V12 | regime-first via evaluatePredictiveVariants |
| P01 (2-hop cross-venue) | predictive | V01–V12 | same |
| P02 (n-hop cyclic Bellman-Ford) | predictive | V01–V12 | same |
| whale (>$500K) | whale | same matrix | same |
| V01–V12 params: slippageBps 5–50, minDepth 10k–1M, maxBlockDelay 1–3, sizeCap 10k–250k, pendIntensity low/med/high | | | families MOMENTUM/MEAN_REV/STAT_ARB/CROSS_PAIR/MICRO suppressed by regime |
## Profit pipeline (9 stages WO-14)
detection→observation→validation→projection_pricing→replay_sim→candidate_gen→qualification→exec_readiness→settlement_econ
- projection: univ2/univ3 quotes + sizing.closedFormCycle(t*)
- econ: profit.netUsd(gross−gas−flashFee−builder) — single canonical
- exec: fresh-resim→baseFee→execProbe(SMART_ACCOUNT)→submit→settled
- profit floor: only arb_settled_net_usd on landed records
## COMPTOOL (observational layer, beside pipeline)
competitor_scan→CiStore→attrib→triggers→rank→scorecard→bench→cmmc→dashboard; consumers: discoveryPriority(pools only, Phase-0); deconstruct(9-stage labels); spreadFor(3F/G); projacc(2); runStatus(Stage-2 guard)
## Active vs dormant
ACTIVE: runner/scout/discovery/feed/solver/engine/exec/pools/forensics/providers/telemetry + ci layer
DORMANT/EXPERIMENTAL: learn/thompson, bidding/bidModel, liquidation/lane (registered, no live consumer), alloc/allocation
UNCLEAR: apps/dashboard (metrics server live, cockpit static)
## Known limitations (honest)
- 9 pre-existing tsc errors | COMPTOOL not runtime-verified (no live process) | volBps=median not spread | settled.json legacy 38 lack projectedNetUsd (new field optional) | dRPC quota hit | stale-lock reclaim TOCTOU narrowed not eliminated
