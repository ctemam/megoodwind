# Strategy analysis — classic arb vs wallet intelligence

Date: 2026-10-04. Trigger: Commander order — analyze the full directory,
reflect on how the two strategies are built, strengths/weaknesses, propose
profit-generation improvements. Labels: [repo] = verified in code this
session; [measured] = numbers from live runs (this or prior session);
[industry] = industry practice; [inference].

## 1. How the strategies are built

### Strategy A — "classic" (state-sync cyclic arb + mempool backrun)

Pipeline, boot to submission:

1. **Discovery** (`arb-discovery`): factory indexer enumerates pools
   (getPair/getPool/poolByPair), feeds/CMC give token lists, provenance
   probe (factory() + totalSupply()) rejects sham pools; results are
   materialized into `config/*.toml` pool entries.
2. **Enumeration** (`arb-paths`): every allowed token path through the
   pool set becomes a `PathTemplate` (flash token + ordered hops). BSC
   currently ~107 pools → ~7,116 paths [measured].
3. **State** (`arb-state`): per block, `StateRefresher` reads all pools —
   batched `IStateReader` calls when a deployed reader exists, Multicall3
   aggregate3 fallback otherwise — into a `PoolStore` (DashMap).
4. **Sim** (`arb-sim`): `evaluate_all` (rayon) quote-chains every path at
   default flash amount → candidates pass min_bps/circuit-breaker/staleness
   filters → `find_optimal_amount` ternary-searches flash size →
   `ProfitGate` enforces bps floor, safety + per-protocol margins, USD
   floor, implausible-bps cap (>10k% = corrupt state).
5. **Backrun channel** (`arb-mempool`): WSS `subscribe_full_pending_transactions`
   → `TxDecoder` (V2 exact-in/out/FOT, V3 tuple+flat+packed-path,
   UniversalRouter multi-command) → `project_pending_path` applies every
   victim hop onto a cloned store (USD-carry between hops, fee-tier
   matching) → paths touching moved pools screened by cheap probes →
   top-20 optimized on projected state → `route_score` ranking
   (leader-template overlap, freshness decay, revert risk).
6. **Submit** (`arb-submit`): `VenueRouter` fans the bundle out in
   health order (EMA RTT, 60s bench on 3 over-budget streaks, slot
   budget). Backruns only go to ordering-aware venues (`is_bundle_venue`
   — Puissant, BlockRazor, JetBldr, NodeReal on BSC); generic paths also
   Warp/Trader (HighEvOnly), Blink, Direct, Pimlico UserOps.
7. **Verification before spend**: exec probe — `eth_call` of the exact
   executor call as the identity that will send — reverts count against
   the path breaker without burning a sponsor call. Settlement tracking
   closes the loop with realized P&L.

### Strategy B — wallet intelligence (`arb-leaders`)

- **Live observation** (Phase 0/1): `LeaderObserver` sits on the same
  pending-swap stream. Every swap from a registered or auto-discovered
  wallet is classified (direct_pool_swap=5 / tracked_pool_trade=3 /
  multi_hop_router=2 / single_hop_router=1 / opaque=0) and queued to an
  async writer → `data/leaders/<chain>/<wallet>.jsonl`. `LeaderDiscoverer`
  scores every sender in the stream with exponentially decayed class
  weights; promotion at score ≥15, ≥3 observations, one counted obs per
  block window, cap 50 with eviction.
- **Offline outcome scan** (`leader_scan` bin): EigenPhi-style realized
  P&L from Transfer legs over mined blocks; level-2 decode handles
  executor-intermediary fleets (hub-and-spoke); probe-based route
  reconstruction (slot0/getReserves) never mislabels direct-called pools;
  shadow coverage = fraction of a wallet's route pools inside our
  registry; `--merge` writes provenance-passed pools/tokens into config.
- **Lifecycle** (`StrategyRegistry` → `data/leaders/<chain>/_strategies.jsonl`):
  Observe → Replay (net≥$50, ≥2 txs, win≥0.5) → Shadow (coverage ≥99.9%)
  → BoundedLive (ops cap OR auto via `mark_verified` when our own
  simulator reproduces positive profit) → Expired (TTL). A BoundedLive
  strategy with ≥3 settles and negative cumulative realized P&L is
  demoted to Shadow and must re-verify.
- **Opportunity bridge** (runner.rs): `_opportunities.jsonl` records with
  Ready/actionable status load at boot as `ready_templates`; a pending
  victim touching a template's pools gets template-overlapping paths
  ranked first and confidence 1.0 in `route_score`. Only route *geometry*
  crosses — never leader calldata/recipients/nonces (copy-poisoning rule).

## 2. Strengths

[repo] Both strategies share the parts where this codebase is genuinely
strong:

- **Phantom-profit defense is deep and earned**: token-order boot
  normalization, sham-pool provenance gate, outlier-pool quarantine
  (≥3 same-pair pools, median ratio), implausible-bps cap, victim-bound
  backrun check, stale-state filter, exec probe before spend. Most of the
  burned effort of prior sessions hardened this — it is the
  differentiator vs naive forks.
- **Failover everywhere**: endpoint pool w/ EWMA pick + blacklist,
  reader→multicall3→chunk fallback, venue benching + emergency reset,
  retry/throttle layers.
- **Wallet-intel rollout discipline**: observation is structurally
  incapable of executing (bounded queue sheds telemetry first);
  `sim_verified` is a hard precondition for every path to BoundedLive;
  settlement demotion is automatic. The design cannot be socially
  pressured into executing — only measurement opens execution.
- **Outcome-first measurement**: leader ranking uses realized net P&L
  from mined Transfer legs, not tx-frequency heuristics.

## 3. Weaknesses

### Classic
- **[measured] Resting-state cyclic arb on public RPC is structurally
  dead**: 838 BSC paths, best probe −1bps; spreads that exist are
  in-block and captured by searchers with private orderflow/nodes. The
  classic loop refreshes after block close; by definition it sees only
  what everyone already saw.
- **[repo] No gas model in the gate**: `route_score` comment says
  "no gas model yet — gas_risk 0". `min_profit_usd`/`safety_margin` are
  proxies. Under sponsored UserOps gas is externalized but not free —
  sponsor budget is a real cost.
- **[repo] V3 backrun projection is same-tick approximation** —
  acceptable as a screen, but large victims crossing ticks get
  mis-estimated; residual revert risk lands on the exec probe.
- **[repo] Quarantine needs ≥3 same-pair pools** — 2-pool pairs have no
  sanity check.
- **[repo] Backrun victim latency is serialized with the refresh loop** —
  `mempool_rx.try_recv` drains inside the main loop; during a refresh
  stall, victims wait. `PENDING_TO_EVAL` measures but the queue structure
  means detection→eval time includes unrelated refresh time.

### Wallet intelligence
- **[repo] Discovery disabled on the chain that trades**: `[leaders]`
  exists only in `config/polygon.toml` (discover=true). BSC — the only
  chain with executors + bundle venues — runs no live observation. The
  intel pipeline on BSC is a manual `leader_scan` — nothing is
  scheduled, so `_strategies.jsonl` / `_opportunities.jsonl` go stale.
- **[measured] Bridge armed but empty**: `_opportunities.jsonl` held
  ETH 30 / Polygon 18 / BSC 20 records, all `execution_status=none` —
  zero READY templates. The runner wiring is live but has nothing to
  prefer.
- **[repo] Private-orderflow blindness**: both sides consume the public
  pending stream; the most profitable leaders increasingly use private
  channels — the observation set self-selects the visible (often less
  profitable) population.
- **[repo] Class taxonomy is behavioral, not strategic**: multi_hop
  vs direct_pool distinguishes mechanics, not strategy (cyclic arb vs
  sandwich vs JIT vs liquidation). Replay gives P&L but no archetype —
  limits what "copy the strategy" could mean later.
- **[repo] We can only express what we enumerate**: ready_templates
  boost paths in our existing 2–3 hop pool graph. Leader profit from
  V4 pools (excluded entirely), JIT liquidity, or >3 hops is
  unexpressible even when proven.
- **[repo] Data lives on the old VM**: `data/leaders/**` JSONL +
  `_cursor.json` are local files — this box starts cold.

## 4. Improvements, ranked by expected P&L impact

1. **Premium infra on BSC** [measured basis]: best public endpoint from
   this box is ~59ms; co-located/dedicated node reaches the <40ms and
   (for IPC) <10ms classes documented in
   `2026-10-04-rpc-latency-transports.md`. In-block races are won on
   latency; this is the #1 lever for BOTH strategies.
2. **Enable `[leaders]` + `discover` on bsc.toml** (one-line config,
   code is shipped and metered) + schedule `leader_scan` regularly so
   evidence/templates stay fresh — currently manual and stale.
3. **Close the coverage gap via `--merge` cadence**: leader routes only
   become READY when their pools are tracked; recurring merge → config →
   restart cycles widen the expressible strategy set.
4. **V4 pools**: excluded from every partition today. PCS Infinity /
   Uniswap V4 PM addresses are already in the deployed executors.
   Highest-value discovery expansion — leaders' routes through V4 are
   invisible now.
5. **Net-of-gas in the gate**: estimate executor gas per submission
   (~constant), subtract from effective_profit_usd; align the gate with
   the stated "net-after-gas" invariant.
6. **Targeted refresh for backruns**: refresh only `hit_pools` after a
   victim (StateReader subset read) instead of full-store refresh —
   saves ~100–200ms on the critical path [inference from measured
   refresh ~200ms].
7. **Bundle-simulation before spend**: where venues expose a sim API
   (Puissant), dry-run the [victim, ours] bundle rather than probing on
   post-refresh state — catches ordering-dependent reverts.
8. **Class→archetype upgrade in wallet-intel**: extend `classify` with
   profit-structure signals (flash-loan provider calls, same-token
   in/out = cyclic, victim sandwiching pattern) so BoundedLive knows
   what it is expressing.
9. **Cross-check private mempool feeds** (bloXroute private tx feed,
   builder subscribe endpoints) — restores visibility where the best
   leaders live.

## 5. Verification

- [repo] Every claim above cites code read this session: runner.rs
  (eval+backrun loops, bridge, venues), gate.rs, evaluate.rs,
  impact.rs, arb-leaders/src/lib.rs (observer/discoverer/registry),
  router.rs, watcher.rs, decoder.rs, leader_scan.rs, config/*.toml.
- [measured] Numbers carried from earlier verified runs: 838 BSC paths
  best −1bps; refresh 0.21s mean on this VM; 59–97ms endpoint p50s.
- [inference] Impact ordering for items 5–8 is engineering judgment;
  1–3 are supported by measured gaps.
