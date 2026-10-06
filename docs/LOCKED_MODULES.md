# Locked Modules

Modules declared complete. Each entry lists the invariant that must not
regress and where it is enforced. Any change that weakens an invariant
must fail tests/CI, not ship. Add a row whenever a module is completed.

| Module | Status | Invariant (must not regress) | Enforcement |
|---|---|---|---|
| Detached backrun lane (`runner.rs` `BackrunCtx`/`backrun_pass`) | LOCKED 2026-10-05 | Victim eval is event-driven on mempool arrival, never block-gated; measured pending→eval ~0.2ms. No `.await` while holding a `std::sync::Mutex`/`RwLock` guard across ctx fields. | `0c6fa71`; code review on any backrun_pass edit |
| Bait conviction (`TokenCircuitBreaker`) | LOCKED | `pool_revert` probes hard-convict pools ~30M blocks via `flag_bait_pools_hard`; convictions persist via `load_bait`/`persist_bait` to `_bait_pools.json` across restarts | `runner::tests::test_bait_pool_hard_flag_is_effectively_permanent`, `test_bait_pool_soft_flag_expires_on_schedule` |
| Exec-probe classification | LOCKED | Pool-internal `Error(string)` (`0x08c379a0`, e.g. `Nomiswap: D`, `UniswapV2: K`) classifies `pool_revert`; executor custom errors map to their own buckets; anything else `unknown_revert` | `runner::tests::test_probe_revert_classification` |
| DS ingest gates (`feed_lane.rs` `DsPair::normalize`) | LOCKED | `nomiswap` dropped at ingest; version decided by `labels[]` (`v3`→UniswapV3, `v2`/`v1`→UniswapV2); unversioned unknown dex dropped, never guessed; DS source is `/token-pairs/v1` (never `/tokens/v1`) | `feed_lane::tests::test_ds_normalize_*` |
| Metrics honesty | LOCKED | Profit = `arb_settled_net_usd` on landed records only. Sim-positive counts, gate accepts, and submissions are funnel diagnostics, never reported as profit | Reporting discipline; any summary must cite the landed metric |
| Gate floor (`[gate] min_profit_usd`) | LOCKED 2026-10-06 | Floor prices decay-through-inclusion, not instantaneous net: ETH ≥ 1.50, BSC/Polygon ≥ 0.60. A sub-floor edge that decays during UserOp inclusion burns sponsored gas (observed −$0.36, tx `0xa12df1…`) | Config values; revisit only with measured inclusion-latency data |
| Config hygiene | LOCKED | Committed configs keep `dry_run=false`, `strict_4337`, no `copy_mode`, bait pools stripped at source; `feed.tokens` widened mids | `git diff` review on config changes |
| Two-pass verify (feed + backrun lanes) | LOCKED | Detection pass is CPU-only; ONE merged `refresher.refresh_pools` per cycle; receipt/probe batch runs `join`ed with refresh — no serialized RPC per candidate | `ccfebb8`, `477c828`; review on lane edits |
| Native-gas symbol resolution | `spec::native_symbol(chain_id)` maps 56→WBNB, 137→WPOL, else→WETH — never a symbol preference list (bridged WETH shadows WPOL → gas ~6000× high → every edge rejected) | `native_symbol_resolves_per_chain` + both call sites (gas feed, settle ctx) |
| Feed-lane spread gate prices on-chain | `onchain_price(store,pool,base,quote)` computes quote-per-base from `PoolStore` (V2/AeroV2 reserve ratio, V3 sqrtP² token-oriented); feed `price_native` is discovery-only, never enters the gate | `onchain_price_orientation_v2_and_v3` test + docs/research/2026-10-05-dexscreener-integration.md |

Process: on completing a module, add a row here + a regression test
where the behavior is unit-testable, and commit both together. On any
future change to a locked file, the diff must not touch an invariant
without an explicit Commander-approved reason.
