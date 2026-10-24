/**
 * Gap-2 — projection-vs-outcome accuracy.
 * Corpus: shadow_exec_probe records (projected netUsd vs probe outcome).
 * settled.json records lack a projected field → pairing unavailable — flagged
 * as data-gap (projected values must be persisted going forward).
 * Report: accuracy, bias, sample, unresolved — per variant + regime where known.
 */
export interface AccuracyRow {
  variant: string; n: number;
  projectedPositive: number;       // netUsd>0 projections
  probePassed: number;             // probe outcome != revert
  falsePositives: number;          // projected positive but probe reverted
  accRate?: number;                // passed/projectedPositive
  meanProjectedNet: number;
}
export interface AccuracyReport {
  schema: 'projacc-v1'; generatedAt: number;
  rows: AccuracyRow[];
  dataGaps: string[];
}

export function accuracy(shadow: { variant?: string; netUsd?: number; probe?: string; chain?: string }[], settledWithProjection = 0): AccuracyReport {
  const byVar = new Map<string, { n: number; pos: number; pass: number; fp: number; netSum: number }>();
  for (const r of shadow) {
    const v = byVar.get(r.variant ?? 'unknown') ?? { n: 0, pos: 0, posPass: 0, pass: 0, fp: 0, netSum: 0 };
    v.n++;
    const posNet = (r.netUsd ?? 0) > 0;
    const passed = r.probe !== undefined && !/revert|fail|error/i.test(String(r.probe));
    if (posNet) { v.pos++; if (passed) v.posPass++; }
    if (passed) v.pass++;
    if (posNet && !passed && r.probe !== undefined) v.fp++;
    v.netSum += r.netUsd ?? 0;
    byVar.set(r.variant ?? 'unknown', v);
  }
  const rows = [...byVar.entries()].map(([variant, v]) => ({
    variant, n: v.n, projectedPositive: v.pos, probePassed: v.pass,
    falsePositives: v.fp, accRate: v.pos ? +(v.posPass / v.pos).toFixed(4) : undefined,
    meanProjectedNet: +(v.netSum / v.n).toFixed(4),
  }));
  const dataGaps = [
    'settled.json records lack projected field — realized-vs-projected pairing unavailable (persist projection going forward)',
    'probe=simulation outcome, not realized settlement — accRate measures projected-positive vs probe-pass correlation, not profit calibration',
    ...(settledWithProjection === 0 ? ['no realized records carry projections — calibration vs real settlement impossible yet'] : []),
  ];
  return { schema: 'projacc-v1', generatedAt: Date.now(), rows, dataGaps };
}
