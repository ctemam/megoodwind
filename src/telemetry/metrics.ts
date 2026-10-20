import { ChainKey } from '../config/index.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Item #15 telemetry substrate — the honesty layer.
 * Only `arb_settled_net_usd` on LANDED records is profit. Sim-positive
 * counts, gate accepts, probe passes and 'ready' rows are NEVER revenue.
 */

export interface SettledRecord {
  ts: number;
  chain: ChainKey;
  strategy: string;
  netUsd: number;
  txHash: string;
  spreadPct: number;
}

class Metrics {
  private counters = new Map<string, number>();
  private settled: SettledRecord[] = [];
  private file = join(process.cwd(), 'data', 'settled.json');

  constructor() { this.load(); }

  private load() {
    if (!existsSync(this.file)) return;
    try { this.settled = JSON.parse(readFileSync(this.file, 'utf8')); } catch { /* fresh */ }
  }

  private persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.settled, null, 2));
  }

  inc(name: string, labels: Record<string, string> = {}) {
    const k = `${name}|${JSON.stringify(labels)}`;
    this.counters.set(k, (this.counters.get(k) ?? 0) + 1);
  }

  addSettled(chain: ChainKey, strategy: string, netUsd: number, txHash: string, spreadPct: number) {
    this.settled.push({ ts: Date.now(), chain, strategy, netUsd, txHash, spreadPct });
    this.persist();
  }

  /** THE profit metric — landed only. */
  get arb_settled_net_usd(): number {
    return this.settled.reduce((a, r) => a + r.netUsd, 0);
  }

  snapshot() {
    return {
      arb_settled_net_usd: this.arb_settled_net_usd,
      settled_count: this.settled.length,
      settled_records: this.settled.slice(-100),
      counters: Object.fromEntries(this.counters),
      ts: Date.now(),
    };
  }
}

export const metrics = new Metrics();
