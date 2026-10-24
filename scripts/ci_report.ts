import { buildReport } from '../src/ci/report.js';
import { writeFileSync } from 'fs';
const r = buildReport(process.argv[2] ?? 'eth');
writeFileSync('docs/ci_report.md', r);
console.log(r.split('\n').slice(0, 40).join('\n'));
console.log(`\n... full report → docs/ci_report.md (${r.split('\n').length} lines)`);
