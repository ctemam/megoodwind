/**
 * COMPTOOL runtime contract — run status + atomic guard.
 * Guard: exclusive-create lock file (O_EXCL = atomic on NTFS/POSIX).
 * Status: single doc {lastAttempt, lastSuccess} — attempt never erases success.
 */
import { existsSync, openSync, closeSync, unlinkSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { execSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { dirname } from 'path';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'skipped_duplicate' | 'interrupted';
export interface RunRecord { runId: string; rev: string; chain: string; startedAt: number; endedAt?: number; status: RunStatus; reason?: string; outputs?: string[]; summary?: string; }
const DIR = 'data/ci';
const LOCK = `${DIR}/comptool.lock`;
const STATUS = `${DIR}/last_run.json`;

function rev(): string { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unstamped'; } }
export function newRun(chain: string): RunRecord { return { runId: `${rev()}-${randomUUID().slice(0, 8)}`, rev: rev(), chain, startedAt: Date.now(), status: 'running' }; }

/** Atomic guard: O_EXCL create fails if lock exists. Stale locks (>maxAgeMs) reclaimed. */
export function acquireGuard(maxAgeMs = 30 * 60 * 1000): { ok: boolean; why?: string } {
  mkdirSync(DIR, { recursive: true });
  if (existsSync(LOCK)) {
    const age = Date.now() - Number(readFileSync(LOCK, 'utf8') || '0');
    if (age < maxAgeMs) return { ok: false, why: `run active (age ${(age / 1000).toFixed(0)}s)` };
    try { unlinkSync(LOCK); } catch {} // stale lock — reclaim (interrupted run left it)
  }
  try { const fd = openSync(LOCK, 'wx'); writeFileSync(fd, String(Date.now())); closeSync(fd); return { ok: true }; }
  catch { return { ok: false, why: 'lock exists (concurrent)' }; }
}
export function releaseGuard() { try { unlinkSync(LOCK); } catch {} }

function readStatus(): { lastAttempt?: RunRecord; lastSuccess?: RunRecord } {
  try { return JSON.parse(readFileSync(STATUS, 'utf8')); } catch { return {}; }
}
function writeStatus(s: { lastAttempt?: RunRecord; lastSuccess?: RunRecord }) {
  const tmp = STATUS + '.tmp'; writeFileSync(tmp, JSON.stringify(s, null, 1)); renameSync(tmp, STATUS);
}
/** Attempt: update lastAttempt only. Success additionally updates lastSuccess. */
export function recordAttempt(r: RunRecord) {
  const s = readStatus(); s.lastAttempt = r; writeStatus(s);
}
export function recordSuccess(r: RunRecord) {
  const s = readStatus(); s.lastAttempt = r; s.lastSuccess = r; writeStatus(s);
}
export function lastRun() { return readStatus(); }
export function recordDuplicate(chain: string, reason: string) {
  recordAttempt({ ...newRun(chain), status: 'skipped_duplicate', reason, endedAt: Date.now() });
}
