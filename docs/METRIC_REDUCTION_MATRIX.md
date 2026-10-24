# Reduction matrix — disposition per metric family
## CORE (drive eligibility/ranking decisions) — 5
| metric | why core | consumer |
|---|---|---|
| econ.estimated_net | net outcome — qualification input | benchmark |
| econ.verified_net | profit truth floor | qualification gate |
| bench.eligible(sample+priced share) | evidence sufficiency | gate |
| attribution.outcome | loss mechanism classification | triggers+discovery priority |
| funnel per-stage loss rate | diagnostic bottleneck | WO-14/discovery |
## GUARDRAIL (integrity, mandatory) — 4
| quality.evidence_coverage | completeness gate |
| econ.unreconcilable_legacy | honest-exposure counter |
| dedupe/quarantine counters | data integrity |
| trigger suppression reasons | no silent no-fire |
## DIAGNOSTIC (explain, don't rank) — 4
| longevity.span/active | context not signal |
| fingerprints | route shape ≠ strategy |
| threat ranking | activity≠profit |
| join outcomes | measurement layer |
## REPORTING — 2
| ops.run, scan coverage | operational visibility |
## REDUNDANT — candidates
| scorecard.rankUniverse vs bench rank | duplicate — keep benchmark, drop scorecard copy |
| gasCostUsd at entity AND per-record | keep per-record (reconcile), entity = derived |
## Honest note
~45 surfaced → ~15 unique → ~5 genuinely CORE. But removals are display-layer only where derivable — don't delete evidence-collection fields that feed reconciliation.

## Count reconciliation (Finding 2)
Units differ: ~15 = distinct LOGICAL measurements; dispositions total 17 because they count SURFACES — e.g. econ.estimated_net exists as registry-def + scorecard-field + CMMC-row (1 logical metric, 3 surfaces, classified once at the decision surface). Disposition classes: CORE 5 | GUARDRAIL 4 | DIAGNOSTIC 4 | REPORTING 2 | REDUNDANT 2 = 17 surfaces over 15 logical metrics (2 metrics surface twice in different classes). No contradiction — counts differ by unit definition.
## Predictive-validity mapping (Finding 3)
predictive validity / sample sufficiency / uncertainty / robustness are NOT separate metrics — they're enforced INSIDE the qualification gate: minSample(n≥10)+pricedShare+econ-unknowns=0 (sample sufficiency), provisional flag (uncertainty), NO_QUALIFIED_WINNER (robustness), winner≠rank#1 separation. No new metrics needed — mapped to benchmark.ts qualify().
