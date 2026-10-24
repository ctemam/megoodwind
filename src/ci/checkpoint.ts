/**
 * Phase 1B — checkpoint protection. Atomic write (tmp+rename), previous-version
 * preservation (.prev), schema+integrity validation on load, safe-fail resume.
 * Rule: NEVER destroy the last valid checkpoint before a replacement validates.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';

export interface CkptMeta { schema: string; nextBlock: number; count: number; hash: string; writtenAt: number; }
export interface Ckpt<T> { meta: CkptMeta; records: Record<string, T>; }

export function checkpointHash(records: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(Object.keys(records).sort())).digest('hex').slice(0, 16);
}

/** Atomic save: write .tmp → validate structure → backup current to .prev → rename. */
export function saveCheckpoint<T>(file: string, schema: string, nextBlock: number, records: Record<string, T>) {
  const meta: CkptMeta = { schema, nextBlock, count: Object.keys(records).length, hash: checkpointHash(records), writtenAt: Date.now() };
  const tmp = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, JSON.stringify({ meta, records }));
  // validate what we just wrote BEFORE touching the live file
  JSON.parse(readFileSync(tmp, 'utf8'));
  if (existsSync(file)) copyFileSync(file, `${file}.prev`);
  renameSync(tmp, file);
}

export interface LoadResult<T> { ok: boolean; records: Record<string, T>; nextBlock: number; source: 'current' | 'prev' | 'none'; reason?: string; meta?: CkptMeta; }

function parse<T>(file: string): Ckpt<T> | { err: string } {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Ckpt<T>;
    if (!j.meta?.schema || typeof j.meta.nextBlock !== 'number' || !j.records) return { err: 'schema invalid' };
    if (checkpointHash(j.records) !== j.meta.hash) return { err: `hash mismatch (count=${Object.keys(j.records).length})` };
    if (j.meta.count !== Object.keys(j.records).length) return { err: 'count mismatch' };
    return j;
  } catch (e) { return { err: `parse: ${String(e).slice(0, 60)}` }; }
}

/** Load with fallback: current → .prev → none. Corrupt current is preserved, not overwritten. */
export function loadCheckpoint<T>(file: string): LoadResult<T> {
  const cur = existsSync(file) ? parse<T>(file) : null;
  if (cur && !('err' in cur)) return { ok: true, records: cur.records, nextBlock: cur.meta.nextBlock, source: 'current', meta: cur.meta };
  const prevFile = `${file}.prev`;
  const prev = existsSync(prevFile) ? parse<T>(prevFile) : null;
  if (prev && !('err' in prev)) return { ok: true, records: prev.records, nextBlock: prev.meta.nextBlock, source: 'prev', reason: `current corrupt: ${(cur as any)?.err}`, meta: prev.meta };
  return { ok: false, records: {}, nextBlock: 0, source: 'none', reason: (cur as any)?.err ?? 'no checkpoint' };
}
