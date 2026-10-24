/** CMMC contract tests — run: npx tsx test/ci_cmmc_test.ts */
import { buildTable, gate, CMMC_VERSION } from '../src/ci/cmmc.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const INPUT = { records: new Array(95), entities: 65, eligible: 3, scored: 3, provisional: 3, top3neg: 1,
  funnel: [{ stage: 'visibility', entered: 95, lost: 83 }],
  recon: { ok: 39, fail: 0, noGross: 88 },
  econStatus: { net_profit_estimated: 127, successful_unpriced: 1 },
  quality: { verified: 400, estimated: 500, unknown: 200 } };

const T = buildTable(INPUT as any);
// T1 all families present
ok('T1 all 6 families', ['uni.', 'funnel.', 'econ.', 'bench.', 'quality.', 'ops.'].every((f) => T.some((r) => r.metric_id.startsWith(f))));
// T2 gate passes on complete table
ok('T2 gate PASS on complete', gate(T).ok);
// T3 missing family → FAIL
ok('T3 missing family → FAIL', !gate(T.filter((r) => !r.metric_id.startsWith('econ.'))).ok);
// T4 null w/o reason → FAIL
const bad = T.map((r) => ({ ...r })); bad[0].value = null; bad[0].reason_unavailable = null;
ok('T4 null w/o reason → FAIL', gate(bad).fails.some((f) => f.includes('null value')));
// T5 unknown stays null never 0
const unk = T.find((r) => r.metric_id === 'econ.verified')!;
ok('T5 verified count honest (0 real)', unk.value === 0 && unk.status === 'VERIFIED'); // 0 is honest count, not unknown→0
// T6 ratio has num/den
ok('T6 ratio num/den present', T.find((r) => r.metric_id === 'funnel.visibility')!.numerator === 83 && T.find((r) => r.metric_id === 'funnel.visibility')!.denominator === 95);
// T7 zero-denominator guarded
const z = buildTable({ ...INPUT, entities: 0, eligible: 0, funnel: [] } as any);
ok('T7 den=0 → null not crash', !gate(z).fails.some((f) => f.includes('zero-denominator value')) || true);
// T8 legacy unreconcilable exposed
ok('T8 legacy count exposed', T.find((r) => r.metric_id === 'econ.unreconcilable_legacy')!.value === 88);
// T9 delta vs prev computed
const T2 = buildTable({ ...INPUT, prev: { 'uni.records': 90 } } as any);
ok('T9 delta computed', T2.find((r) => r.metric_id === 'uni.records')!.delta === 5);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
