# Metric inventory — actual, source-verified (rev 7b9c177)
## Counts
- metricRegistry defs: 9 | CMMC rows: 14 static + dynamic funnel/quality ≈ 18 live
- scorecard metrics: 17 required fields | funnel stages: 9 | canonical report sections: 13
- Distinct logical metrics ≈ 45 (overlapping across layers — same datum surfaced at registry/scorecard/CMMC)
## Sources
- metrics: metricRegistry.ts ids | CMMC: cmmc.ts r() calls | scorecard: scorecard.ts fields | funnel: diagnostics.ts stages | canonical: canonicalReport.ts sections
## Key finding
The SAME underlying measures appear at 3 layers (registry def / scorecard field / CMMC row) — layered duplication is intentional (registry=definition, scorecard=per-entity value, CMMC=aggregate count), but it triples the apparent count. True unique measurements ≈ 15.
