# H-005 — existing-factory enumeration audit (eth, @5a38987 evidence)
Method: for each of 109 out-of-registry candidate pools (from WO-07 visibility
failures), fetched factory()/token0()/token1() on-chain, classified vs our
4 registered factories + 483-token universe + enumeration path.

## Root causes (109 candidates, 0 unresolved)
| Category | n | Defect |
|---|---|---|
| covered_token_missing | 58 | Under queried factories (UniV2/V3/Curve) but ≥1 token NOT in our 483-token list → pair never enumerated. Token-list coverage gap. |
| covered_pair_not_enumerated | 30 | Both tokens in universe, factory queried — pair missed by DexScreener feed AND outside top-12 brute matrix (discovery.ts:57 matrixCap=12). Feed+matrix gap. |
| venue_gap | 21 | 15 fringe factories not registered. Separate hypothesis. |

## Mechanism (verified in discovery.ts)
- feedPairs() = DexScreener pairs feed — unlisted pairs missed.
- factoryMatrix() brute-forces only top-12 tokens (line 57).
- Steady-state creation-log scan covers NEW pools only — these are pre-existing pools never backfilled.

## Smallest defensible correction (Class-B proposal, not applied)
Historical PoolCreated/PairCreated backfill over registered factories —
on-chain event gives token0/token1 + pool directly, no token-list needed,
no feed dependency. Bounded log chunks; incremental cost ~1 getLogs scan
per factory (already-running pattern). Would enumerate all 88 covered
candidates by construction. Estimated: ~4 factory scans vs current 0.
## What this does NOT prove
- that recovered pools yield profitable candidates (downstream replay/econ)
- the 18.9% bound becomes 0% — fringe-venue residual stays ~18.9%
