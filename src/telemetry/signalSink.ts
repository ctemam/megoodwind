import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChainConfig } from '../config/index.js';

/**
 * Shared signal sink — every structural/strategy event lands in the same
 * JSONL trace the monitor verifier reads (data/monitor/<chain>_signals.jsonl).
 * `is_simulation: true` is forced here — this sink is for shadow-mode
 * telemetry only; settled execution metrics live in the executor path.
 */

const SIGNAL_DIR = resolve(process.cwd(), 'data/monitor');

export function emitSignal(chain: ChainConfig | string, rec: Record<string, unknown>) {
  const key = typeof chain === 'string' ? chain : chain.key;
  mkdirSync(SIGNAL_DIR, { recursive: true });
  appendFileSync(
    resolve(SIGNAL_DIR, `${key}_signals.jsonl`),
    JSON.stringify({ ts: new Date().toISOString(), is_simulation: true, ...rec }) + '\n',
  );
}
