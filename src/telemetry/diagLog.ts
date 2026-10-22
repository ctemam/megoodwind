import { appendFileSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg } from '../config/index.js';

/**
 * WO-2 diagnostic lane — bounded per-signal logging at every gate stage.
 *
 * Hard bounds (a diag lane that OOMs the runner is a leak, not a tool):
 *   RING_PER_STAGE  — in-memory ring of the most recent N rows per stage
 *   FILE_MAX_BYTES  — per-stage capped jsonl (data/diag_<stage>.jsonl);
 *                     on overflow rewritten with newest half — a hot
 *                     stage can never evict a rare stage's rows
 *   SAMPLE_EVERY    — after the first WARM rows per stage are kept in
 *                     full, 1-in-N subsequent rows is persisted, so a
 *                     hot rejection lane can't drown the sample budget.
 *
 * Active ONLY under DIAG_ONLY=1. Production path is untouched — every
 * callsite is a single `diagRecord(...)` guarded by cfg.DIAG_ONLY inside.
 */

const RING_PER_STAGE = 60;
const FILE_MAX_BYTES = 8 * 1024 * 1024; // 8MB cap
const WARM_ROWS = 20;                   // first N rows per stage always kept
const SAMPLE_EVERY = 25;                // thereafter 1-in-25 persists

const rings = new Map<string, Record<string, unknown>[]>();
const seen = new Map<string, number>();
const fileLines = new Map<string, number>();
let dropped = 0;

const fileFor = (stage: string) => join(process.cwd(), 'data', `diag_${stage}.jsonl`);

export function diagRecord(stage: string, row: Record<string, unknown>): void {
  if (!cfg.DIAG_ONLY) return;
  const r = { ts: new Date().toISOString(), stage, ...row };

  const ring = rings.get(stage) ?? [];
  ring.push(r);
  if (ring.length > RING_PER_STAGE) ring.shift();
  rings.set(stage, ring);

  const n = (seen.get(stage) ?? 0) + 1;
  seen.set(stage, n);
  if (n > WARM_ROWS && n % SAMPLE_EVERY !== 0) { dropped++; return; }

  const file = fileFor(stage);
  try {
    appendFileSync(file, JSON.stringify(r) + '\n');
    fileLines.set(stage, (fileLines.get(stage) ?? 0) + 1);
    // per-stage cap — a hot lane (depth floods) can NEVER evict rows
    // from a rare one (min_profit_floor) the way a shared file did.
    if (existsSync(file) && statSync(file).size > FILE_MAX_BYTES) compact(stage, file);
  } catch { /* diag never wedges the hot path */ }
}

/** Rewrite a stage file with the newest half of its rows. */
function compact(stage: string, file: string): void {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const keep = lines.slice(Math.floor(lines.length / 2));
    writeFileSync(file, keep.join('\n') + '\n');
    fileLines.set(stage, keep.length);
  } catch { /* best-effort */ }
}

/** Snapshot of in-memory rings + counters — for /api/metrics and reports. */
export function diagSnapshot(): {
  stages: Record<string, { rows: number; sampled: number; fileLines: number }>;
  dropped: number;
} {
  const stages: Record<string, { rows: number; sampled: number; fileLines: number }> = {};
  for (const [k, v] of rings) {
    stages[k] = { rows: v.length, sampled: seen.get(k) ?? 0, fileLines: fileLines.get(k) ?? 0 };
  }
  return { stages, dropped };
}

export function diagReset(): void { rings.clear(); seen.clear(); fileLines.clear(); dropped = 0; }
