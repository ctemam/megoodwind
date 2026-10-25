# Gap-2A diagnosis — the shared revert decoded
## Error: 0xa932492f = K() — UniV2 constant-product invariant
All 157 shadow probes revert with K(): amount0Out×amount1Out < reserve0×reserve1.
## Root cause
Projection oversizes vs actual pool reserves — the ~$3.70 uniform projection doesn't account for price impact/real invariant at execution size. NOT environmental; the probe path is working correctly and honestly reporting projection-state mismatch.
## Distinction preserved
- projections ≠ realized: acc=0 measures probe-pass correlation, not profit calibration
- systematic path shared (all variants same error+size) vs strategy-specific (none found)
## Persistence gap (same lesson as grossUsd)
settled.json lacks projected field — pairing projection→realized impossible. Persist projection per candidate with stable id going forward.
## Not fixed (per directive — diagnose only)
profit model untouched; no tuning; thresholds unchanged.

## Stage 3B correction (verified)
solver.ts:309 ALREADY calls closedFormCycle — sizing IS in the live path.
Real defect: 157-probe corpus shares ONE fixed borrowAmount (355519959056922752)
across all variants — generated at a single witness state, replayed at drifted
reserves → K() everywhere. Repair = re-sim at exec-block, not new sizing.
