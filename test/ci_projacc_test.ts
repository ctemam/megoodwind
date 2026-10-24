import { accuracy } from '../src/ci/projAccuracy.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const recs = [
  { variant: 'V1', netUsd: 1, probe: 'pass' },
  { variant: 'V1', netUsd: 2, probe: 'deterministic_revert' },
  { variant: 'V1', netUsd: -1, probe: 'pass' },
];
const r = accuracy(recs as any);
const v = r.rows.find((x) => x.variant === 'V1')!;
ok('T1 counts', v.n === 3 && v.projectedPositive === 2 && v.probePassed === 2 && v.falsePositives === 1);
ok('T2 accRate pos-only', Math.abs(v.accRate! - 0.5) < 1e-9);
ok('T3 dataGaps always present', r.dataGaps.length === 3);
ok('T4 empty input', accuracy([]).rows.length === 0);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
