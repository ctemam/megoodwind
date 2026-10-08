# Feed lane: V2 zero-fee phantom profit + fee-aware gate (2026-10-06)

Engineer FEED lane — funnel audit, root cause, fixes. All numbers measured
live on BSC (`feed_probe`, 17:25 UTC). Labels: [verified] = observed on live
code/chain, [repo evidence] = code/comments, [assumption], [unknown].

## Funnel, measured post-fix (BSC, one cycle)

```
gt_rows=20 ds_rows=418 kept=254
filters: liquidity=111 inactive=20 no-flash=9
pair groups: total=60 singleton=43 (72% single-venue — can't arb) ge2=17
refresh: 67 registered, 67 priced
gate: below_spread=2 suspect=0 candidates=15
sim: all 15 → $0.00 (fixed and optimal sizing)
```

Same shape on ETH/Polygon in earlier runs: near-total mortality is honest —
observed cross-venue spreads (5.9–32.9 bps) sit below real round-trip fees
(~27–55 bps on V2-containing pairs).

## Root cause found: feed V2 pools quoted at 0% fee [verified]

Chain of custody, all three links confirmed live:

1. `feed_lane.rs` registers discovered pools as `PoolConfig { fee_bps: 0 }`
   (feeds don't report swap fees).
2. `StateRefresher.multicall_v2` wrote `V2PoolState.fee_bps = fee_for_pool(pool)`
   where `fee_for_pool` returned the stored value verbatim — `0` — instead of
   treating 0 as "unset" (every other consumer filters `>0`, e.g.
   `pool_config_fee_raw`, the legacy-reader decode). The deployed StateReader's
   own `swapFee()` probe was never extended to the Multicall3 path, so
   feed pools always took the config fallback — and the config was 0.
3. `get_amount_out`/`evaluate_path` then simulated every feed-lane V2 leg at
   zero swap fee → systematic phantom profit. Measured on the pre-fix probe:
   $0.57–$2.38 net fabricated per candidate — those sims passed and died at
   exec-probe (matching the fleet's `insufficient_profit` bundler reverts).

Secondary bug: `map_legacy` (legacy reader decode) filled `V2State.fee` from
`pool_config_fee_raw` which is bps×100 (V3 units) — a configured 25 bps pool
stored 2500 bps → quoted a 25% fee → pool effectively dead on that path.

## Fixes (all verified)

- **`resolve_v2_fee_bps`** (refresher.rs): precedence swapFee() > factory
  table > config > 30 bps UniV2 max-common. Zero config can never reach the
  quote path. Wired the previously dead `default_fee_for_factory` table
  (PCS 25, BiSwap 10, MDEX 30, ApeSwap 20, BaseSwap 25, Sushi 30).
- **`multicall_v2`**: full-path pools now probe `swapFee()` + `factory()` in
  the same aggregate3 (allowFailure — missing getters fall through to the
  table). Live result on BSC: PCS V2 → 25 bps, BiSwap → 2 bps (pair getter),
  unknown forks → 30 bps default.
- **`map_legacy`**: uses `pool_config_fee_bps` (plain bps) not `_raw` (×100).
- **Feed-lane gate is fee-aware** (`required_spread_bps`): spread must exceed
  `fee_in + fee_out + min_net margin` (~5 bps), floored at `min_spread_bps`
  as a pure noise floor (config 30→5 bsc/polygon, kept 50 on ETH where gas
  ≈40 bps on $2k). A 30 bps V2-V2 candidate that could never profit dies at
  the gate now instead of burning a sim cycle and a 120 s cooldown slot.
- **Canonical pair key** (`canonical_pair_key`): feeds disagree on
  (base,quote) orientation (DS lists WBNB/USDT where GT lists USDT/WBNB);
  unordered-address key merges the venue set into one group instead of
  splitting it and double-simming.
- **`no_flash_asset`** reject metric — the stage was an invisible `continue`.
- `feed_probe` prints stored per-pool fees next to every candidate for
  future audits.

## Coverage / thresholds verdict [verified]

- Singleton share 72% (43/60 groups): most ingested pairs have exactly one
  venue — no arb topology exists. Not a threshold problem.
- Liquidity floor $50k ≈ 25× the $2k notional — inside industry norms
  (≥5–10× notional). Loosening to $10k + h1=0 in an earlier measured run
  added +7 groups, +22 candidates, **zero** profitable sims — kept.
- min_h1_txns=3 honest; dead pools re-entered only noise at h1=0.
- Exact threshold where a real edge passes: spread > fee_in+fee_out+5 bps
  net of impact — i.e. >~55 bps on V2-V2 majors, >~32 on V3 25bp-tier pairs,
  >~8 bps on 1bp V3-V3 pairs (rare but the only structure with headroom).
- Pricing orientation: verified correct (unit test + 2 live spot reads;
  the "ETH/USDT price=0.00035" oddity was a shitcoin literally named ETH at
  0x0eb3a678…, not an inversion — grouping keys on addresses, unaffected).
- Sizing (`find_optimal_amount` on `[floor, path_max_flash]`): honest — all
  15 live candidates returned $0 at both fixed and optimal size at real
  fees. The earlier $2.38 "rescue" was the zero-fee phantom.

## Regression locks (LOCKED_MODULES rows added)

- `resolve_v2_fee_bps` never quotes a stored 0 — test
  `test_resolve_v2_fee_never_quotes_zero`.
- `required_spread_bps` covers round-trip fees — test
  `required_spread_bps_covers_round_trip_fees`.
- `store_fee_bps` unit conversion (V3 hpip→bps) — test
  `store_fee_bps_reads_each_protocols_units`.
- `canonical_pair_key` orientation-agnostic — test
  `canonical_pair_key_merges_feed_orientations`.

## What remains unfixed, honestly

- Feed lane still sees **no profitable candidates on majors** at real fees:
  public-RPC feeds (30 s CDN) + free RPC refresh can't outrun MEV-capable
  actors on BSC/ETH/Polygon majors. The lane's honest yield today is
  structural, not a bug — same conclusion as the backrun lane's 70-180 ms
  edge decay. [verified]
- Feed-discovered pools still don't refresh `swapFee()` on the slim path
  (declared config pools keep their declared fee; a pool whose on-chain fee
  changes post-registration sims with the config value). Bounded, noted.
  [repo evidence]
- GT is rate-limit-bound from this egress IP (429 on most pages) — DS
  carries coverage; GT rows merge but aren't the bottleneck. [verified]
