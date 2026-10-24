/** Phase 1B checkpoint-protection tests — run: npx tsx test/ci_checkpoint_test.ts */
import { saveCheckpoint, loadCheckpoint } from '../src/ci/checkpoint.js';
import { writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const F = 'data/ci/test_ckpt.json';
[F, F + '.prev', F + '.tmp'].forEach((f) => rmSync(f, { force: true }));

// T1 save+load roundtrip
saveCheckpoint(F, 'bf-v1', 12_000_000, { '0xA': { block: 100 }, '0xB': { block: 200 } });
const l1 = loadCheckpoint(F);
ok('T1 roundtrip', l1.ok && l1.nextBlock === 12_000_000 && l1.source === 'current' && Object.keys(l1.records).length === 2);

// T2 interrupted write leaves .tmp but valid .json survives
saveCheckpoint(F, 'bf-v1', 13_000_000, { '0xC': { block: 300 } });
writeFileSync(F + '.tmp', '{"broken":'); // simulate crash mid-write
const l2 = loadCheckpoint(F);
ok('T2 interrupted .tmp harmless', l2.ok && l2.nextBlock === 13_000_000);

// T3 .prev preserved after second save
ok('T3 prev exists', existsSync(F + '.prev'));
const prev = JSON.parse(readFileSync(F + '.prev', 'utf8'));
ok('T3b prev has old data', prev.meta.nextBlock === 12_000_000 && prev.records['0xA']);

// T4 corrupt current → falls back to prev
writeFileSync(F, 'CORRUPTED_NOT_JSON');
const l4 = loadCheckpoint(F);
ok('T4 corrupt → prev fallback', l4.ok && l4.source === 'prev' && l4.nextBlock === 12_000_000 && l4.reason?.includes('corrupt'));

// T5 corrupt BOTH → safe fail, nothing destroyed
writeFileSync(F + '.prev', 'ALSO_CORRUPT');
const l5 = loadCheckpoint(F);
ok('T5 both corrupt → safe fail', !l5.ok && l5.source === 'none');

// T6 hash tamper detected
saveCheckpoint(F, 'bf-v1', 14_000_000, { '0xD': { block: 400 } });
const j = JSON.parse(readFileSync(F, 'utf8'));
j.records['0xEVIL'] = { block: 999 }; // inject record without fixing hash
writeFileSync(F, JSON.stringify(j));
const l6 = loadCheckpoint(F);
ok('T6 tampered hash rejected', !l6.ok || l6.source !== 'current');

// T7 count tamper detected
saveCheckpoint(F, 'bf-v1', 15_000_000, { '0xE': { block: 500 } });
const j2 = JSON.parse(readFileSync(F, 'utf8'));
j2.meta.count = 999;
writeFileSync(F, JSON.stringify(j2));
const l7 = loadCheckpoint(F);
ok('T7 count mismatch → prev or none', l7.source !== 'current');

[F, F + '.prev', F + '.tmp'].forEach((f) => rmSync(f, { force: true }));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
