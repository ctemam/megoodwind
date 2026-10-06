# 2026-10-06 — DexScreener pipeline deep-dive: coverage hole + group poisoning

Scope: DS `token-pairs/v1` ingest → normalize → filter → pair-group → on-chain
spread gate → sim → exec (`crates/arb-runner/src/feed_lane.rs`). All numbers
are live measurements on BSC (rpc.48.club + publicnode), ETH and Polygon
unless tagged otherwise.

## Findings

### F1 — DS ships NO `labels[]` for ~41% of rows; every uniswap-dexId pool was dropped at ingest [verified]

- Live pull, BSC DS ingest for the 14 configured tokens: 417 rows →
  235 normalized → 87 post-filter → only 14 pair-groups ≥ 2.
- Every pool with `dexId:"uniswap"` carries NO version labels on DS. Before
  this fix, `DsPair::normalize` dropped unlabelled unknown dexes outright.
- On-chain `slot0()` verification: **23/23** filter-passing unlabeled
  "uniswap" pools on BSC are V3 — ~$37.7M TVL invisible to the lane,
  including the deepest BTCB/WBNB, ETH/WBNB, CAKE/USDT pools. Same hole on
  ETH (~$182M uniswap-labeled; 208/357 rows unlabeled incl. curve ~$400M,
  balancer ~$9.9M) and Polygon (~$33M).
- DS `dexId` does NOT encode AMM version; `labels[]` does — but DS omits
  labels on a large share of rows. [verified, measured]

### F2 — One poisoned pool killed an entire pair group [verified]

- Gate grouped by exact `(base, quote)` and took lo/hi of the group. Live
  USDT/USDC on BSC: seven honest pools ~0.9998 vs ONE pool
  `0x1e40450F8E21BB68490D7D91Ab422888Fb3D60f1` at 0.637 → group "spread"
  5693bps (>max_spread_bps) → whole group rejected `spread_suspect`.
  A single divergent pool therefore both produced phantom spreads AND
  suppressed the honest candidates.

### F3 — Residual blocker after both fixes: spread scarcity on majors, not coverage [verified]

- With all label-less pools rescued (re-run of the funnel incl. the 23
  recovered V3 pools): on-chain spreads across ALL 17 BSC groups ≤ ~26bps
  (below the 30bps `min_spread_bps` floor) EXCEPT DOGE/WBNB at ~97bps —
  the only candidate produced.
- Live run of the fixed lane (dry_run=false, strict_4337): 2 cycles →
  `feed_rejects{price_outlier}` fired on exactly pool `0x1e40450F8E…`
  (price 0.665 vs median 0.9998), `feed_candidates_total` = 1 →
  `feed_verified{sim_fail}` — the DOGE/WBNB edge did not survive sim
  economics at $2000 notional.
- Interpretation: majors on BSC are compressed to single-digit bps; the
  executable-edge gap vs sim cost (V3 depth, loan fee, gas) is now the
  live frontier, not feed blindness.

### F4 — Orientation-split hypothesis rejected [verified]

- No pair group split across flipped base/quote orientations (0 splits in
  the full live pull). Grouping by exact `(base, quote)` is correct.

### F5 — Free-RPC transport failures are the dominant noise [verified]

- Multicall3 `aggregate3` timeouts blacklist public endpoints in rotation
  (defibit, binance dataseeds, nodereal key). Chunked V2/V3 refreshes time
  out at 2200ms on chunks of ~30-96 calls. Budget overruns: 2359-3265ms vs
  800ms block budget. These throttle refresh throughput but do not produce
  false rejects; they DO cost block-coverage.

## Industry-tool research (import, don't invent)

- **Interface detection:** ERC-165 `supportsInterface` is NOT implemented by
  Uniswap V3 pools — not viable. Factory-address→interface maps (what
  1inch/Paraswap-style adapter registries do) are fragile: new factories
  deploy constantly and DS rows don't carry factory addresses. The standard
  approach in DEX-aggregators/defillama adaptors is a **canonical-selector
  probe**: `slot0()` (0x3850c7bd) → V3; `getReserves()` (0x0902f1ac) → V2.
  Imported as `sniff_protocol` — ONE batched `eth_call` per unknown pool
  (join_all), cached per cycle.
- **Outlier conviction:** trimmed-median / MAD-style endpoint exclusion is
  the standard oracle-manipulation defense (Chainlink-style medianizers
  ignore extreme observations). Imported as `trim_divergent` — while group
  lo-hi spread > max_spread_bps, drop the endpoint farthest from the
  median, stop at 2 members. Convicted pools merge into the persisted
  `_bait_pools.json` so all lanes stop seeing them.

## Decisions

1. `NormPool.proto` → `Option<Protocol>`; unlabelled/unknown dexes get a
   chain sniff instead of a silent drop or a guessed interface.
   `classify_dex` now returns `Proto | Unknown | Unsupported`; the
   unsupported deny-list (clmm/stable/curve/dodo/wombat/v4/integral/
   solidly/algebra/thena/ramses/velodrome) still drops outright.
2. Group poisoning fixed via `trim_divergent` + persistent bait conviction.
3. `min_spread_bps` untouched — lowering it is a strategy decision, not a
   blocker fix; the honest pool's job is to present every real edge to sim.

## Verification

- `cargo test --release -p arb-runner feed_lane`: 7/7 pass incl.
  `trim_divergent_convicts_only_the_poisoned_endpoint`,
  `persist_bait_pools_merges_without_duplicates`,
  `test_ds_normalize_unlabelled_unknown_goes_to_chain_sniff`.
- Live BSC run: `price_outlier` reject on the exact measured poisoned pool;
  1 candidate reached verify (DOGE/WBNB), `sim_fail` — pipeline delivers,
  economics gate rejects.
- Follow-ups: (a) measure UserOp inclusion latency vs ~97bps decay on
  free venues; (b) DOGE/WBNB sim post-mortem — V3 depth vs $2000 notional;
  (c) same sniff+trim on ETH/Polygon lanes (code shared, already covered).

## Impact

- Recovered ~$37.7M (BSC) / ~$182M (ETH) / ~$33M (Polygon) of previously
  invisible pool liquidity into the discovery funnel.
- Removed the class of phantom-spread group kills; convicted pools persist
  cross-lane.
- Remaining blocker hierarchy (evidence-ordered): edge scarcity on majors
  → sim economics (V3 depth vs notional, gas) → UserOp inclusion latency.
