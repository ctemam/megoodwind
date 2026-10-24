# Backfill shadow run — eth, 400k blocks (25864765–26264765)
- 4 factories, 40 chunks × 10k, 160 RPC calls, 0 failed
- discovered 3,676 pools from creation logs; +3,586 tokens → registry 3,596 (was 483)
- RECOVERY vs H-005 candidates: 6/120 (5.0%) — candidate pools predate the window
- verdict: backfill works mechanically + massively expands token universe, but
  bounded-depth scans miss older pools. Full coverage needs deeper depth
  (cost scales linearly) OR per-candidate targeted lookback (cheap: one
  factory-binary-search per pool). Recommend targeted lookback for the 114
  remaining candidates — bounded cost, definitive recovery evidence.

## Targeted lookback (ci_lookback.ts) — definitive resolution
- 40/40 candidates resolved via binary-search eth_getCode: 1,014 calls (~25/pool)
- OLDEST creation block: 10,434,820 (June 2020, UniV2-era) — explains 5% bounded recovery
- full-history depth needed: ~15.8M blocks = 1,583×10k chunks ≈ 6,300 calls (one-time)
- lookback is 6.2× cheaper per candidate — BUT requires known address (can't discover unknowns)

## Recommended two-mechanism architecture
1. One-time full-history backfill (~6.3k calls, Ankr budget OK) to enumerate all
   historical pools under registered factories → bulk discovery of unknowns.
2. Continuous PoolCreated/PairCreated watcher for new pools (already running).
3. On-demand lookback (~25 calls) to resolve any specific uncovered candidate —
   closes residual gaps cheaply without another full scan.
Token registry: broad (factory-event provenance, tiers A-D); readiness selective;
execution eligibility unchanged (L4 + change-control gates intact).
