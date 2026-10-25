/** Run-status contract tests — run: npx tsx test/ci_runstatus_test.ts */
import { acquireGuard, releaseGuard, newRun, recordAttempt, recordSuccess, lastRun, recordDuplicate } from '../src/ci/runStatus.js';
import { rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const LOCK = 'data/ci/comptool.lock', STATUS = 'data/ci/last_run.json';
[LOCK, STATUS].forEach((f) => rmSync(f, { force: true }));

// T1 acquire + release
ok('T1 acquire→release', acquireGuard().ok === true && (releaseGuard(), true));
// T2 concurrent acquire blocked
acquireGuard(); const g2 = acquireGuard();
ok('T2 second acquire blocked', g2.ok === false && g2.why!.includes('active'));
// T3 stale lock reclaimed (maxAgeMs=0 forces stale)
writeFileSync(LOCK, String(Date.now() - 1));
ok('T3 stale lock reclaimed', acquireGuard(0).ok === true);
releaseGuard();

// T4 runId unique per attempt (same rev, different attempts)
const r1 = newRun('eth'), r2 = newRun('eth');
ok('T4 runIds unique', r1.runId !== r2.runId && r1.rev === r2.rev);

// T5 attempt doesn't erase success
const succ = { ...newRun('eth'), status: 'succeeded' as const, endedAt: Date.now() };
recordSuccess(succ);
const att = { ...newRun('eth'), status: 'failed' as const, reason: 'test fail', endedAt: Date.now() };
recordAttempt(att);
const st = lastRun();
ok('T5 success preserved through later failure', st.lastSuccess?.status === 'succeeded' && st.lastAttempt?.status === 'failed');

// T6 duplicate recorded as attempt not success
recordDuplicate('eth', 'concurrent');
ok('T6 dup recorded as skipped', lastRun().lastAttempt?.status === 'skipped_duplicate' && lastRun().lastSuccess?.status === 'succeeded');

// T7 atomic status write (tmp→rename, valid JSON)
ok('T7 status file valid', (() => { try { JSON.parse(readFileSync(STATUS, 'utf8')); return true; } catch { return false; } })());

rmSync(LOCK, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
