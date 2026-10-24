# COMPTOOL V1.2 audit — 5-run reproducibility (pinned snapshot b192cfad3413, rev 1ef27ba)

## Executive verdict: PASS WITH LIMITATIONS
All 5 runs byte-identical (outHash 9a1ada8e3087). Deterministic pipeline confirmed.

## Dimension table (R1–R5 identical)
| dimension | result | evidence |
|---|---|---|
| spec alignment | PASS | 9 registry defs + source maps consistent |
| source mappings | PASS | every dashboardField mapped + observability |
| metric calcs | PASS | netUsdSum independently recalculated (sample agg, exact match) |
| scorecard gen | PASS | 65 cards = 65 entities |
| ranking | PASS | top3 deterministic; insufficient-evidence unranked |
| completeness gate | PASS | 0 COMPLETE — gate refuses on estimated-not-verified econ |
| dashboard reconcile | PASS | stored dashboard top3 ids == run top3 |
| provenance | PASS | 95 records, canonical ids, dedupe |
| regression | PASS | 112+ prior suite tests green (re-run this session) |
| governance | PASS | baseline 656079b7 frozen, nothing armed, L4 open |

## Runs
R1..R5: records=95 scorecards=65 scored=3 eligible=3 complete=0 — identical.

## Defects found
| ID | sev | finding |
|---|---|---|
| AUD-D1 | MED | `0x0000009c` ranked #2 on performance (score 0.196) — near-zero address likely a decode-artifact entity, yet eligible because verified-class + priced events. Identity-quality filter needed before performance ranking (recommend: exclude unclassifiable_decode_artifact from perf eligibility). |
| AUD-D2 | LOW | top3 is "top-3 within THIS 95-record corpus" — not market-wide claim; dashboards should label scope (already discloses eligible=3/65). |
| AUD-D3 | INFO | 14 legacy net_profit_verified records predate traceVerified gate (previously disclosed). |

## Governance confirmation
baseline frozen · no live exec/signing · paid RPC deferred · full backfill unauthorized · L4 OPEN.

## Remediation priority
1. AUD-D1 — add entityClass filter to performance eligibility (Class-B review).
2. AUD-D3 — re-grade legacy records per correction-trail.
Verified (not claimed): deterministic reproducibility, honest completeness gate, top-3-in-corpus. NOT verified: market-wide top-3, profitability, production readiness.
