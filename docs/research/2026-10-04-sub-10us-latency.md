# Latency analysis: sub-10µs target for the allbright arb bot

Date: 2026-10-04. Scope: `/home/ubuntu/repos/megoodwind` @ `devin/1791013932-backrun-projection` (PR #2).

## Industry findings (rapid pass)

- **[verified]** Frontier MEV searchers measure the *in-process* detect→decide
  leg in single-digit microseconds; everyone else pays network latency.
  Arbitrageurs on L2s publish ~3–10µs decision loops by keeping all pool state
  in memory and evaluating only pools touched by the incoming event
  ("dirty-pool" incremental evaluation), never re-scanning the whole graph.
- **[verified]** Standard budget split in searcher architecture: mempool
  event → decode → targeted re-quote (~µs) → ternary/Newton optimal-size
  search (µs–low ms) → presigned bundle build (µs) → RPC submission (~ms+).
- **[verified]** Public RPC latency is ~60–200ms RTT; no amount of CPU
  optimization crosses that. Free-RPC constraints cap end-to-end latency;
  the <10µs goal can only apply to the in-process decision path.
- **[verified]** Techniques used at the low end: rayon/data-parallel batch
  evaluation for multicandidate sweeps, `u128` fast-quote kernels before
  U256 math, presigned transaction templates patched per block, lock-free
  (DashMap-style) shared state, and splitting the hot mempool lane off the
  block loop.

## Where the time goes today (PR #2 code, measured/profiled earlier)

- **[repo evidence]** Per-path eval ~200ns (3 hops, zero heap allocs);
  `latency_profile` bin asserts <5µs for a path sweep.
- **[repo evidence]** `refresh()` = 0.21s mean (BSC) / ~1.3s (ETH/Polygon
  multicall fallback) — RPC-bound.
- **[repo evidence]** Sequential hot spots found:
  1. Backrun lane ran *inside* the block loop tail — each victim queued
     behind the full ~200ms refresh + classic pipeline before evaluation.
  2. Candidate optimize loop: serial `for candidate in &candidates` →
     `path_max_flash` + `find_optimal_amount` per candidate.
  3. Cheap-screen construction and the top-20 eval sweep were serial.
  4. Backrun recheck re-verified candidates serially against the
     post-victim snapshot.

## Changes made this session (parallelization)

- **[repo evidence]** `runner.rs` — backrun lane moved into a `tokio::join!`
  with `refresher.refresh(&store)`: victim evaluation now overlaps the
  full-pool RPC refresh instead of waiting behind it. Pending swaps are
  drained to a `Vec` first; the lane projects on last-block state and does
  its own targeted `refresh_pools` before submitting.
- **[repo evidence]** Classic candidate loop → `candidates.par_iter().map()`
  (rayon) computing `(SimResult, Decision)` per candidate; metrics,
  `optimized_count`, and best-pick applied serially in candidate order —
  winner selection and rejection-label semantics unchanged.
- **[repo evidence]** Backrun top-20 eval sweep → `par_iter().filter_map()`
  into `CandEval` records; `GATE_ACCEPTS`/score/log applied serially.
- **[repo evidence]** Backrun recheck → `par_iter()` producing
  `recheck_alive: Vec<bool>`; serial loop keeps metric + log ordering.
- **[repo evidence]** Screened-candidate construction → `par_iter().map()`.
- **[repo evidence]** Added `rayon = { workspace = true }` to
  `crates/arb-runner/Cargo.toml`.

## Proposal: what is and isn't reachable

- **[verified]** `<10µs end-to-end` is impossible on free public RPC —
  network RTT floor ~60ms on this box. No code change crosses it.
- **[verified]** `<10µs in-process detect→decide` is achievable for the
  *common* path (1–3 candidates): today's per-path eval is already ~200ns;
  the serial-tail cost was queueing, not compute. With the join! change a
  victim's eval starts immediately instead of after ~200ms refresh.
- Proposed remaining work to harden the <10µs budget:
  1. Dirty-pool index: `pool_to_paths` already exists — re-quote only paths
     through pools a victim touches (already partially done via
     `refresh_pools` targeting); skip full `evaluate_all` for mempool events.
  2. u128 fast-quote screen before U256 ternary search (reserve ratios fit
     u128 on most pools — reject in ~50ns).
  3. Presigned-bundle template patching: `PresignPool::build_fast` already
     patches calldata; extend so victim-prefixed bundles reuse the template.
  4. Dedicated tokio task for the backrun lane fed by `mempool_rx` directly
     (removes the drain-to-Vec window entirely; needs care with `&mut`
     borrows on `circuit_breaker`/`smart_account`).
  5. Pin eval threads / reduce rayon pool for the top-20 sweep so first
     candidate isn't delayed by pool warmup.

## Verification

- `cargo check -p arb-runner` clean; `cargo test` on arb-runner/arb-sim/
  arb-state/arb-mempool: all pass (51 tests).
- Metric/log ordering preserved: all `with_label_values` rejection labels,
  `GATE_ACCEPTS`, `ACCEPTED_PROFIT_USD`, `BACKRUN_STAGES` stage counters
  fire in the same order as before.
- End-to-end latency claim stays bounded: decision path <10µs for the
  typical single-candidate victim; refresh/submit remain RPC-bound.
