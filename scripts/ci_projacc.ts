import { readFileSync } from 'fs';
import { accuracy } from '../src/ci/projAccuracy.js';
import { writeFileSync } from 'fs';
const lines = readFileSync('data/shadow_candidates.jsonl', 'utf8').trim().split('\n').filter(Boolean);
const recs = lines.map((l) => JSON.parse(l));
const rep = accuracy(recs);
writeFileSync('docs/ci_projacc.json', JSON.stringify(rep, null, 1));
console.log(`projections: ${rep.rows.length} variants`);
for (const r of rep.rows.sort((a, b) => b.n - a.n).slice(0, 8))
  console.log(`  ${r.variant}: n=${r.n} pos=${r.projectedPositive} probePassed=${r.probePassed} falsePos=${r.falsePositives} acc=${r.accRate ?? 'n/a'} meanNet=${r.meanProjectedNet}`);
console.log('data gaps:', rep.dataGaps.length);
rep.dataGaps.forEach((g) => console.log('  - ' + g.slice(0, 90)));
