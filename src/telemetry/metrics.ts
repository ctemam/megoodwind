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

export type Lane = 'predictive' | 'whale';

export interface VariantLedgerRow {
  variant: string;
  hits: number;              // emitted candidates (passed all gates)
  misses: number;            // rejected at profit floor
  minProfitFloorUsd: number; // the floor that gated it
  maxProfitUsd: number;      // peak simulated yield this variant produced
  netUsd: number;            // accrued simulated net
  lane: Lane;
}

interface LedgerDisk {
  variants: Record<string, Omit<VariantLedgerRow, 'variant'>>;
  laneProfitUsd: Record<Lane, number>;
  peakProfitUsd: number;
}

/** Live dynamic-slippage state per chain — the bound the solver is
 *  enforcing right now plus the last measured path impact. */
export interface SlippageState {
  regime: string;
  whale: boolean;
  boundBps: number;
  volBps: number;
  lastImpactBps: number;
  peakImpactBps: number;  // worst impact observed this session
  minOutUsd: number;      // last emitted candidate's on-chain minOut barrier, USD
  floorUsd: number;       // the profit floor folded into minProfit
  at: number;
}

class Metrics {
  /** Counter-key cardinality ceiling — beyond this, new label combos fold into `other`. */
  private static readonly MAX_COUNTER_KEYS = 10_000;
  private counters = new Map<string, number>();
  private settled: SettledRecord[] = [];
  private file = join(process.cwd(), 'data', 'settled.json');
  private countersFile = join(process.cwd(), 'data', 'metrics_counters.json');
  private ledgerFile = join(process.cwd(), 'data', 'variant_ledger.json');
  private countersDirty = false;
  private ledgerDirty = false;
  private variants = new Map<string, Omit<VariantLedgerRow, 'variant'>>();
  private laneProfitUsd: Record<Lane, number> = { predictive: 0, whale: 0 };
  private peakProfitUsd = 0;
  private slippage = new Map<string, SlippageState>();

  constructor() {
    this.load();
    // counters flush on an interval — inc() can fire hundreds of times
    // per solver cycle; per-inc writes would be pure write amplification
    setInterval(() => { this.persistCounters(); this.persistLedger(); }, 5_000).unref();
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
    if (existsSync(this.ledgerFile)) {
      try {
        const d = JSON.parse(readFileSync(this.ledgerFile, 'utf8')) as LedgerDisk;
        for (const [k, v] of Object.entries(d.variants ?? {})) this.variants.set(k, v);
        this.laneProfitUsd = {
          predictive: Number(d.laneProfitUsd?.predictive) || 0,
          whale: Number(d.laneProfitUsd?.whale) || 0,
        };
        this.peakProfitUsd = Number(d.peakProfitUsd) || 0;
      } catch { /* fresh */ }
    }
  }

  private persistLedger() {
    if (!this.ledgerDirty) return;
    this.ledgerDirty = false;
    mkdirSync(dirname(this.ledgerFile), { recursive: true });
    const disk: LedgerDisk = {
      variants: Object.fromEntries(this.variants),
      laneProfitUsd: this.laneProfitUsd,
      peakProfitUsd: this.peakProfitUsd,
    };
    writeFileSync(this.ledgerFile, JSON.stringify(disk, null, 2));
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
    // Cardinality guard — a label that interpolates a measured value
    // (e.g. peer_divergence_2514.9x) mints a new key per observation and
    // the map grows without bound; persisted + served on /api/metrics,
    // it is a memory + payload leak. Fold overflow keys into `other`.
    if (!this.counters.has(k) && this.counters.size >= Metrics.MAX_COUNTER_KEYS) {
      const fold = `${name}|{"reason":"other"}`;
      this.counters.set(fold, (this.counters.get(fold) ?? 0) + 1);
    } else {
      this.counters.set(k, (this.counters.get(k) ?? 0) + 1);
    }
    this.countersDirty = true;
  }

  counterCount(): number { return this.counters.size; }

  /** Aggregate of a counter across all its label variants. */
  counterSum(name: string): number {
    let s = 0;
    for (const [k, v] of this.counters) if (k.startsWith(`${name}|`)) s += v;
    return s;
  }

  /**
   * Variant performance ledger — one row per (variantId+lane).
   * hit = emitted past the profit floor; miss = floor rejection.
   * Tracks peak simulated yield (maximum_profit) and accrued net.
   */
  recordVariantOutcome(variantId: string, lane: Lane, opts: {
    hit: boolean; netUsd: number; floorUsd: number;
  }) {
    const key = `${variantId}@${lane}`;
    const row = this.variants.get(key) ?? {
      hits: 0, misses: 0, minProfitFloorUsd: opts.floorUsd,
      maxProfitUsd: 0, netUsd: 0, lane,
    };
    if (opts.hit) {
      row.hits++;
      row.netUsd += opts.netUsd;
      this.laneProfitUsd[lane] += opts.netUsd;
      if (opts.netUsd > row.maxProfitUsd) row.maxProfitUsd = opts.netUsd;
      if (opts.netUsd > this.peakProfitUsd) this.peakProfitUsd = opts.netUsd;
    } else {
      row.misses++;
      row.minProfitFloorUsd = Math.min(row.minProfitFloorUsd, opts.floorUsd);
    }
    this.variants.set(key, row);
    this.ledgerDirty = true;
  }

  /** Record the dynamic bound the solver enforced this cycle. */
  setSlippage(chain: string, s: Omit<SlippageState, 'at'>) {
    this.slippage.set(chain, { ...s, at: Date.now() });
  }

  /** Last measured path impact — written per evaluated candidate.
   *  Peak tracks the worst observed clip for the session. */
  notePathImpact(chain: string, impactBps: number) {
    const s = this.slippage.get(chain);
    if (s) {
      s.lastImpactBps = impactBps;
      if (impactBps > s.peakImpactBps) s.peakImpactBps = impactBps;
    }
  }

  /** Active minOut barrier — the last candidate's on-chain output floor
   *  in USD (repay + premium [+ whale lane floor]), streamed so the
   *  cockpit renders the real barrier, not a static % assumption. */
  noteMinOut(chain: string, minOutUsd: number, floorUsd: number) {
    const s = this.slippage.get(chain);
    if (s) { s.minOutUsd = minOutUsd; s.floorUsd = floorUsd; }
  }

  get analytics() {
    const total = this.laneProfitUsd.predictive + this.laneProfitUsd.whale;
    return {
      profit_ratio_predictive: total > 0 ? (this.laneProfitUsd.predictive / total) * 100 : 0,
      profit_ratio_whale: total > 0 ? (this.laneProfitUsd.whale / total) * 100 : 0,
      lane_profit_usd: { ...this.laneProfitUsd },
      peak_profit_usd: this.peakProfitUsd,
      variant_performance_ledger: [...this.variants.entries()].map(([variant, r]) => ({ variant, ...r })),
    };
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
      analytics: this.analytics,
      slippage: Object.fromEntries(this.slippage),
      ts: Date.now(),
    };
  }
}

export const metrics = new Metrics();
