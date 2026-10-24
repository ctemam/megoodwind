# Consolidated remediation — spec→implementation traceability (rev post-51f230c)

## Verdict: COMPLIANT with 1 corrected flag (AUD-D1 investigated → false positive)

## AUD findings resolved
- AUD-D1: `0x0000009ca1` has REAL contract code → correctly `verified_active_contract`, NOT an artifact (low-address contracts are deployed, not precompiles). Audit flag was overcautious. Defense-in-depth added anyway: isArtifact() now excludes real decode artifacts (0x00000000fd3a-class) from performance eligibility in rank.ts + benchmark.ts ELIG.
- AUD-D3: legacy `net_profit_verified` records (no traceVerified) auto-regraded → `net_profit_estimated` on store load, correction trail preserved. Implemented store.ts.
- AUD-D2: top3-in-corpus scope label confirmed (eligible=3 disclosed).

## Spec→code traceability matrix
| skill.md req | module | call path | enforcement | test | status |
|---|---|---|---|---|---|
| canonical ids | store.ts eventId | ingest() | content-hash dedupe | T1-T3 | ENFORCED |
| idempotent ingest | store.ts ingest | scanner | hash match→dup | T1/T2 | ENFORCED |
| provenance/corrections | store.ts corrections[] | ingest/setClass | append-only | T9 | ENFORCED |
| quarantine | store.ts quarantine/release | scanner | trusted() filter | T7/T8 | ENFORCED |
| economics truth | economics.ts | scanner ingest | unpriced→unknowns, verified→trace | 12/12 | ENFORCED |
| measurement contract | measure.ts mc-v1 | scanner | den=0→undefined | 10/10 | ENFORCED |
| entity classes | scanner botClass | store | 6-class signer/executor | live | ENFORCED |
| rankings 2-tier | rank.ts | dashboard | verified-only perf eligibility | 9/9 | ENFORCED |
| artifact exclusion (NEW) | rank.ts isArtifact | perf eligibility | artifact→unverified | regression | ENFORCED |
| attribution | attribute.ts | scanner | replay-gated confirmed_missed | 12/12 | ENFORCED |
| triggers | triggers.ts | scanner | minSample/coverage/hysteresis/dedupe/cooldown/cap/kill | 13/13 | ENFORCED |
| hypotheses | hypotheses.ts | seed/scanner | lifecycle-locked transitions | 12/12 | ENFORCED |
| change control | changeControl.ts | hypotheses.integrate | A/B/C classes, DNA patterns | 12/12 | ENFORCED (scope: callers) |
| metric registry | metricRegistry.ts | scorecard defFor | every field mapped | 6/6+6/6 | ENFORCED |
| scorecard | scorecard.ts | dashboard | not_assessed→INCOMPLETE | 10/10 | ENFORCED |
| top-3 benchmark | benchmark.ts | dashboard | verified+n≥2+priced+!artifact | live | ENFORCED |
| checkpoint | checkpoint.ts | backfill | atomic+prev+hash/count | 8/8 | ENFORCED |
| funnel | diagnostics.ts | script | once-per-loss-stage | 8/8 | ENFORCED |
| report | report.ts | script | denominators+suppression reasons | live | ENFORCED |

## Verification: 5-run reproducible (hash 9a1ada8e3087, identical) + 145+ tests green post-fix
## Residual: L4 open; ChangeControl scope=callers only; threat board=activity not profit (labeled)
