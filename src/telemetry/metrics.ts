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
  private countersFile = join(process.cwd(), 'data', 'metrics_counters.json');
  private countersDirty = false;

  constructor() {
    this.load();
    // counters flush on an interval — inc() can fire hundreds of times
    // per solver cycle; per-inc writes would be pure write amplification
    setInterval(() => this.persistCounters(), 5_000).unref();
  }

  private load() {
    if (existsSync(this.file)) {
      try { this.settled = JSON.parse(readFileSync(this.file, 'utf8')); } catch { /* fresh */ }
    }
    if (existsSync(this.countersFile)) {
      try {
        const c = JSON.parse(readFileSync(this.countersFile, 'utf8'));
        for (const [k, v] of Object.entries(c)) this.counters.set(k, Number(v) || 0);
      } catch { /* fresh */ }
    }
  }

  private persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.settled, null, 2));
  }

  private persistCounters() {
    if (!this.countersDirty) return;
    this.countersDirty = false;
    mkdirSync(dirname(this.countersFile), { recursive: true });
    writeFileSync(this.countersFile, JSON.stringify(Object.fromEntries(this.counters), null, 2));
  }

  inc(name: string, labels: Record<string, string> = {}) {
    const k = `${name}|${JSON.stringify(labels)}`;
    this.counters.set(k, (this.counters.get(k) ?? 0) + 1);
    this.countersDirty = true;
  }

  /** Aggregate of a counter across all its label variants. */
  counterSum(name: string): number {
    let s = 0;
    for (const [k, v] of this.counters) if (k.startsWith(`${name}|`)) s += v;
    return s;
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
      forensicGates: {
        total_detected_opportunities: this.counterSum('total_detected_opportunities'),
        rejected_by_forensic_bait: this.counterSum('rejected_by_forensic_bait'),
        rejected_by_profit_margin: this.counterSum('rejected_by_profit_margin'),
        passed_to_simulation_probe: this.counterSum('passed_to_simulation_probe'),
      },
      ts: Date.now(),
    };
  }
}

export const metrics = new Metrics();
