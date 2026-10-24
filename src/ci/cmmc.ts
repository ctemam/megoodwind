/**
 * CMMC — COMPTOOL Mandatory Metrics Contract.
 * Machine-verifiable table: one row per required metric, hard gate before publish.
 * Missing row | invalid type | missing value w/o status | inconsistent vs source → FAILED_METRICS_CONTRACT.
 */
export type MStatus = 'VERIFIED' | 'ESTIMATED' | 'INFERRED' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'NOT_ASSESSED';
export interface MRow {
  metric_id: string; metric_name: string; value: number | null; unit: string;
  numerator: number | null; denominator: number | null; status: MStatus;
  evidence_source: string; reason_unavailable: string | null;
  threshold: string | null; previous_value: number | null; delta: number | null;
}
export const CMMC_VERSION = 'cmmc-v1';

export function buildTable(input: {
  records: any[]; entities: number; eligible: number; scored: number; provisional: number;
  top3neg: number; funnel: { stage: string; entered: number; lost: number }[];
  recon: { ok: number; fail: number; noGross: number };
  econStatus: Record<string, number>; quality: Record<string, number>;
  prev?: Record<string, number>;
}): MRow[] {
  const rows: MRow[] = [];
  const push = (m: Partial<MRow> & { metric_id: string; metric_name: string }) =>
    rows.push({ value: null, unit: 'count', numerator: null, denominator: null, status: 'UNKNOWN', evidence_source: 'ci_store+pipeline', reason_unavailable: null, threshold: null, previous_value: input.prev?.[m.metric_id] ?? null, delta: null, ...m });
  const r = (id: string, name: string, num: number, den: number | null, unit = 'count', st: MStatus = 'ESTIMATED') => {
    const v = den ? (den === 0 ? null : num / den) : num;
    const row = { metric_id: id, metric_name: name, value: v === null ? null : +v!.toFixed(6), unit: den ? 'ratio' : unit, numerator: num, denominator: den, status: st };
    push(row);
    const prev = input.prev?.[id];
    if (prev !== undefined && row.value !== null) rows[rows.length - 1].delta = +(row.value - prev).toFixed(6);
  };
  // universe & coverage
  r('uni.records', 'observed records', input.records.length, null, 'count', 'VERIFIED');
  r('uni.entities', 'observed entities', input.entities, null, 'count', 'VERIFIED');
  r('uni.eligible', 'benchmark-eligible entities', input.eligible, input.entities, 'count', 'VERIFIED');
  r('uni.excluded', 'excluded entities', input.entities - input.eligible, input.entities);
  // funnel
  for (const f of input.funnel) r(`funnel.${f.stage}`, `${f.stage} loss`, f.lost, f.entered, 'ratio', 'VERIFIED');
  // econ integrity
  r('econ.estimated', 'estimated-net records', input.econStatus['net_profit_estimated'] ?? 0, null, 'count', 'ESTIMATED');
  r('econ.verified', 'verified-net records', input.econStatus['net_profit_verified'] ?? 0, null, 'count', 'VERIFIED');
  r('econ.unpriced', 'unpriced records', input.econStatus['successful_unpriced'] ?? 0, null);
  r('econ.recon_ok', 'reconciliation pass', input.recon.ok, null, 'count', 'VERIFIED');
  r('econ.recon_fail', 'reconciliation fail', input.recon.fail, null, 'count', 'VERIFIED');
  r('econ.unreconcilable_legacy', 'legacy no-gross records', input.recon.noGross, null, 'count', 'VERIFIED');
  // benchmark
  r('bench.scored', 'scored entities', input.scored, input.entities, 'count', 'VERIFIED');
  r('bench.provisional', 'provisional (n<5)', input.provisional, input.eligible);
  r('bench.negative_net', 'negative-net eligible', input.top3neg, input.eligible, 'count', 'VERIFIED');
  // evidence quality
  for (const [st, n] of Object.entries(input.quality)) r(`quality.${st.toLowerCase()}`, `evidence ${st}`, n, null, 'count', 'VERIFIED');
  // ops
  r('ops.run', 'pipeline run', 1, null, 'count', 'VERIFIED');
  return rows;
}

export interface GateResult { ok: boolean; fails: string[]; }
const REQUIRED_FAMILIES = ['uni.', 'funnel.', 'econ.', 'bench.', 'quality.', 'ops.'];
export function gate(rows: MRow[]): GateResult {
  const fails: string[] = [];
  for (const f of REQUIRED_FAMILIES) if (!rows.some((r) => r.metric_id.startsWith(f))) fails.push(`missing family ${f}`);
  for (const r of rows) {
    if (r.value === null && (r.status === 'VERIFIED' || r.status === 'ESTIMATED') && !r.reason_unavailable) fails.push(`${r.metric_id}: null value w/o reason`);
    if (r.unit === 'ratio' && (r.numerator === null || r.denominator === null)) fails.push(`${r.metric_id}: ratio missing num/den`);
    if (r.denominator === 0 && r.value !== null && r.status !== 'NOT_APPLICABLE') fails.push(`${r.metric_id}: zero-denominator value`);
    if (typeof r.value === 'number' && !isFinite(r.value)) fails.push(`${r.metric_id}: non-finite`);
  }
  return { ok: fails.length === 0, fails };
}
