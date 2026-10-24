# Backfill shadow run — eth, 400k blocks (25864765–26264765)
- 4 factories, 40 chunks × 10k, 160 RPC calls, 0 failed
- discovered 3,676 pools from creation logs; +3,586 tokens → registry 3,596 (was 483)
- RECOVERY vs H-005 candidates: 6/120 (5.0%) — candidate pools predate the window
- verdict: backfill works mechanically + massively expands token universe, but
  bounded-depth scans miss older pools. Full coverage needs deeper depth
  (cost scales linearly) OR per-candidate targeted lookback (cheap: one
  factory-binary-search per pool). Recommend targeted lookback for the 114
  remaining candidates — bounded cost, definitive recovery evidence.
