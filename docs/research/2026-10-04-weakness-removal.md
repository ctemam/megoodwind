# Weakness-removal implementation — both strategies

Date: 2026-10-04. Implements the implementable subset of
`2026-10-04-strategy-analysis.md` (Commander order: "Improve both strategies
by removing the weaknesses"). Infra items needing Commander decisions
(premium/co-located RPC, V4 pools, private orderflow) are out of scope.

## Decision

Ship six changes; every one addresses a documented weakness from the
analysis. All changes are measurement- or honesty-driven — none fabricate
edge.

## Changes and repo impact

1. **[leaders] discovery on BSC + ETH** — `config/bsc.toml`,
   `config/ethereum.toml`: `[leaders] discover = true` appended.
   Wallet-intel observation previously ran only on Polygon while execution
   runs on BSC/ETH. [verified] `LeadersConfig` fields all carry serde
   defaults; `discover = true` alone is sufficient.

2. **Net-of-gas floor** — `GateConfig.est_tx_gas` (default 350k);
   `runner.rs` feeds `gas_price × est_tx_gas × native_usd` into
   `ProfitGate::set_gas_cost_usd` each pricing block; `gate.rs` enforces
   `min_profit_usd` on **net** profit (new reject reason `below_gas_net`).
   Gross sim profit previously ignored the tx's own gas. [verified] bad
   gas reads are guarded (non-finite/non-positive rejected); a `0` default
   preserves old behavior until the first successful read.

3. **Targeted refresh on the backrun path** — new
   `StateRefresher::refresh_pools(store, addrs)`: partitions a pool subset
   by protocol and issues one aggregate3 batch per class, instead of the
   full-store sweep the scored queue used per victim. The runner now
   refreshes hit pools ∪ candidate path pools (≤64). Same REFRESH_PHASE
   metrics apply. [verified] identical partition/store-update mapping as
   `refresh()`. Expected: refresh cost ∝ moved-pool count, not ~100+ pool
   sweep (full-refresh wall measured earlier at ~1.3s under RPC churn).

4. **Archetype classification in wallet-intel** — `arb-leaders::classify`
   now buckets by profit structure before mechanics: `flash_loan_arb`
   (calldata selector match — Balancer/Aave flash-loan entrypoints) and
   `cyclic_arb` (same-token in/out) added at weights 4.5/4.0, below
   `direct_pool_swap` (5.0). The prior mechanics-only classes couldn't
   tell an MEV-structured wallet from retail flow. [verified] class
   ordering indices updated to 7-wide table; unknown class maps to the
   `opaque` slot.

5. **V3 same-tick projection over-liquidity guard** —
   `project_and_quote` returns `move_frac` (fractional price move of the
   projection) for every arm; `project_pending_path`/`project_direct`
   propagate `max_move_frac`. Backrun route_score multiplies confidence
   by 0.5 when `max_move > 0.25` — a same-tick estimate that pushed >25%
   walked across real ticks the approximation cannot see. [verified]
   moves >100% clamp at 1.0. This penalizes rather than rejects: the
   exec-probe `eth_call` remains the hard verification.

6. **`leader_scan --loop SECONDS`** — rescans forever; the persisted
   cursor (`StrategyRegistry::load_cursor`) makes each pass cover only
   new blocks, so `_strategies.jsonl` / `_opportunities.jsonl` /
   `_pools.toml` stay fresh without cron. `strat` reloads inside the loop
   so merges take effect live. Wired into `ecosystem.config.json` as
   `allbrightA-leaderscan-bsc` / `allbrightA-leaderscan-eth` with
   `--loop 900 --merge` (auto-import of route-discovered pools into
   config each pass). [assumption] pm2 autorestart covers transient RPC
   failures that would exit a single run.

## Verification

- [verified] `cargo build --workspace` clean.
- [verified] `cargo test -p arb-state -p arb-rpc -p arb-mempool
  -p arb-leaders -p arb-sim`: 44/44 pass.
- [verified] `validate-pools` unchanged behavior (state crate tests pass
  through the instrumented path).
- [repo evidence] config diffs are append-only; `dry_run` untouched.
- [unknown] live lift — no secrets on this box; fleet restart and
  measurement belong to the deploy box. Expected measurable signals:
  `LEADER_SCAN`/`STRATEGY` lines on BSC/ETH, `below_gas_net` rejects in
  gate metrics, `backrun targeted refresh` debug ms vs prior full-refresh
  ms, `matched_live` bridge hits from loop-freshened templates.

## Not done (needs Commander decision)

- Premium/co-located BSC RPC (top lever from the latency research — vantage
  dominates: ~59ms local vs 22–33ms measured industry benchmarks from
  closer vantages; <10ms requires a co-located node).
- V4 pool support (enables strategies the enumerator cannot express).
- Private mempool feeds (recovers the orderflow invisible to public
  pending streams).
