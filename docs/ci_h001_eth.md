# H-001 experiment — eth (audited, circularity corrected)
baseline: 207 pools hash=656079b7 | candidates: 109 out-of-registry pools
CIRCULAR RUN (rejected as evidence): treatment=all 109 candidates → 0% vis-failure — selection bias, not discovery capability.
FACTORY AUDIT: 109 pools → 18 unique factories; 88 under factories we ALREADY query (UniV3 0x1f98431c×46, UniV2 0x5c69bee7×32, Curve 0xc0aee478×10); 21 under 15 fringe factories (true venue gap).
CORRECTED TREATMENT (baseline ∪ covered-factory candidates): vis-failure=18/95=18.9%, routes fully recovered=65.
H-001 verdict: ACCEPTED at corrected bound (<50%, n=95) — UPPER BOUND: "discoverable via queried factory" ≠ "discovery actually enumerates it". Root cause is coverage-ENUMERATION (token-pair matrix / creation-log gaps), not venue coverage.
Residual 18.9% = true venue gap (fringe DEXs) — separate, lower-priority hypothesis.
