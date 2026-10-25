# Stage 3F — cross-venue spread trigger (audit/design only)
## Existing measure found
`peerDivergence(chain, pool)` (forensics/baitPool.ts:152) — same-pair median divergence across tracked peers. ALREADY computes the needed data.
## The design gap
peerDivergence is used to EXCLUDE bait pools (>3x conviction), not to TRIGGER search. Divergence is measured but the arb signal isn't extracted.
## Proposed trigger (reuse, minimal)
signal = max over pairs of |quote_venueA − quote_venueB| / min(quote) where both venues same pair+direction, same state-snapshot, decimals+fee-normalized, fresh (<30s per Stage-3B stale rule).
- volBps stays as REGIME descriptor (median vol) — not replaced.
- spread trigger is a separate DIAGNOSTIC signal for candidate-generation readiness.
## Distinction preserved
divergence ≠ profitability: signal only says "venue gap exists" — economics still flow through existing gates (impact, fees, gas, minProfit). A trigger does not relax qualification.
## Missing data behavior
no same-pair venue pair → signal unavailable, NOT zero. Stale quotes → rejected per stale rule.
## Next (your approval): implement spreadFor(pair,venues) reading existing pool state, wire as diagnostic emit alongside volBps, test on stored pool data — no new pipeline.
