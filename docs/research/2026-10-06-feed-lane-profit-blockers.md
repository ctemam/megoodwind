# Feed-lane profit-blocker deep-dive — measured funnel audit

**Date:** 2026-10-06 · **Scope:** DexScreener/GeckoTerminal ingest → pair-group
formation → on-chain gate → sizing → sim → verify_and_submit, on BSC, ETH,
Polygon · **Tool:** `crates/arb-runner/src/bin/feed_probe.rs` (new measurement
harness; replays the live lane end-to-end through the real `StateRefresher`).

## Method

`feed_probe` replays the exact production funnel against live RPC + feed data
and counts drops per stage: GT pages 1–3 + DS `/token-pairs/v1` ingest →
normalize → liquidity/activity/flash-asset filters → pair grouping →
`refresher.refresh_pools` → on-chain spread gate → fixed vs
`find_optimal_amount` sizing sim. `--gap` mode probes every dropped pool through
the shipped `probe_interfaces` path, re-groups, re-gates, and sims the
recovered candidates.

## Findings (measured, 2026-10-06 ~12:00–12:20 UTC)

| Stage | BSC | ETH | Polygon |
|---|---|---|---|
| GT+DS rows → normalized kept | 477 → 278 | ~450 → ~200 | 450 → 164 |
| Pair groups (≥2 pools) | 19 | ~10 | 5 |
| Pools priced by refresh | 60/60 | all | 13 reg / **6→36 priced in gap** |
| Spread-gate candidates | 0 (max ~24bps vs 30 gate) | 0 (26.4 vs 50) | 0 (31 vs 30) |
| Gap candidates after probe-fix | 1 (62.4bps) | 0 | 1 (34.1bps) |
| Sim profit (fixed/optimal) | $0.00 / $0.00 | — | $0.00 / $0.00 |

### Blocker A — coverage gap: unlabeled dex ids were dropped at ingest (REMOVED)

`dexId` doesn't encode AMM version; DS `labels[]` is the only version signal,
and ~36–53 *liquid* pools per chain per cycle arrive unlabeled ("uniswap" on
BSC means real UniV3 deployments; "ramses" on Polygon answers `slot0`). These
sat outside every pair group — pure coverage loss.

**Fix:** `StateRefresher::probe_interfaces` — one batched `aggregate3`
(`globalState`/`slot0`/`getReserves`, allowFailure, most-specific-wins
classification Algebra > V3 > V2) admitted through the lane's probe path with
a hit-only cache (misses re-probe next cycle — transport failure can't
permanently drop a pool). Feed metric `FEED_INGESTED{source="probed"}` counts
them. Merged with the parallel `DexKind`/`classify_dex` tri-state
(`Proto`/`Unknown`/`Unsupported`) and `trim_divergent` pair-group poison
removal landed in `3c61429` — the probe replaced per-pool `sniff_protocol`
eth_calls with the single batched call and added Algebra detection, while the
deny-list was relaxed to only provably-unprobeable venues
(clmm/stable/curve/dodo/wombat/v4); algebra-family ids always probe (a guessed
V3 misreads the dynamic fee).

**Verification:** BSC gap 36 pools → 35 priced (11 V2 + 25 V3); Polygon gap
53 → 36 priced (6 V2 + 46 V3, remainder lost to transport, retried next cycle);
recovered candidates exist (62.4/34.1/34.9bps gross) but all sim ~$0 at this
snapshot — fees ≥ spread. Coverage is real; the market is honest about it.

### Blocker B — aggregate3 wholesale failure zeroed entire refreshes (REMOVED)

`multicall_aggregate3` returned `Vec::new()` when ANY concurrent chunk failed
its transport retries — one timed-out chunk nulled the whole refresh. Measured
live on Polygon: 6/52 gap pools priced while all 46 unpriced V3 pools
individually answered `fee()`/`liquidity()`/`token0()` (per-pool diag in the
harness).

**Fix:** `merge_aggregate3_parts` — failed chunks emit `success:false`
placeholders; output length always equals call count, order preserved; per-pool
decode filtering drops just the failed chunk's pools.

**Verification:** same Polygon gap run after fix: **6/52 → 36/52 priced**.
Unit lock: `test_merge_aggregate3_parts_failed_chunk_only_drops_itself`.

### Blocker C — fixed-notional sizing ignored the profit optimum (REMOVED)

Every feed candidate was evaluated at the config `flash_amount` (~$2000
notional): edges needing a smaller size were auto-rejected, edges earning more
with size were capped.

**Fix:** `verify_and_submit` now runs `find_optimal_amount(&path, &store,
floor, path_max_flash(...), 24)` before eval/instructions/calldata;
`flash_amount` survives only as ceiling/default.

**Verification:** probe's opt column ≥ fixed on every candidate (e.g.
WBNB/USDT uniswap/hexid: fixed $0.00 → opt $0.01). No pass-at-optimum case
today — upside is structural, not snapshot-measurable.

### Not a blocker (measured): spread reality

Deepest cross-dex spreads on every chain sit at 1–31bps raw vs gates of
30–50bps — *below* fee+gas cost even where coverage is complete. The funnel is
not dropping profitable edges; it is correctly rejecting unprofitable ones.
This matches the 2026-10-05 ground truth (1–24bps majors).

## Remaining structural items (evidence, not narrative)

1. **UserOp inclusion latency (5–15s) vs decay** — any passing edge still
   decays through bundler inclusion; structural to the Pimlico smart-account
   path. Mitigation needs the funded-EOA path (user-side lever, documented in
   HANDOFF).
2. **V3 tick-cross sizing honesty** — `quote_multi_tick_approx` is a haircut
   approximation, not real tick walking; the exec probe catches residual
   inflation. Measurable impact requires a spread-passing V3 pair, none exists
   in the snapshot.
3. **Free-RPC transport ceiling** — Polygon's 3 endpoints periodically
   time out 30-call batches wholesale; the fix contains the blast radius but
   can't conjure endpoints.

## Impact

Feed lane now sees ~40–90 additional liquid pools/chain/cycle (probe-admitted
+ chunk-rescued), sizes candidates at their optimum, and loses no healthy
pools to transport noise. Measured profit at this snapshot: still $0 — the
binding constraint is raw spread depth vs fees, not pipeline code.
