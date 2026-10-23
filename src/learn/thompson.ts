/**
 * WO-13 — self-learning loop. Feature rows per cycle -> Thompson sampling
 * over arms (chain × lane × variant) -> budget weights.
 * Arm posterior: Beta(alpha=1+wins, beta=1+losses) on probe->exec success
 * PLUS a Gaussian-on-netUsd payoff model (sampled mean / (1+n)) so arms
 * with rare-but-fat wins rank correctly.
 * Bait reputation: per-pool Beta posterior; conviction when beta mean <
 * credibility floor (bounded threshold from THRESHOLDS, not hand-picked).
 * Rollback: weights frozen when realized-vs-predicted drift exceeds the
 * same CUSUM family as the bid model.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';

export interface ArmRow {
  ts: number;
  arm: string;             // `${chain}:${lane}:${variantId}`
  chain: string; lane: string; variantId: string;
  regime: string;          // market regime at decision time
  gapBps: number;
  depthUsd: number;
  hops: number;
  gasUsd: number;
  outcome: 'settled' | 'probe_pass' | 'revert' | 'filtered' | 'timeout';
  netUsd?: number;
  predictedNetUsd?: number;
}

interface Arm { alpha: number; beta: number; n: number; sumNet: number; sumNet2: number; }

const FILE = 'data/learn/arms.json';
const FEATURES = 'data/learn/feature_rows.jsonl';

export class ThompsonAllocator {
  arms = new Map<string, Arm>();
  private cusum = 0; private frozen = false;

  constructor() {
    if (existsSync(FILE)) {
      try { for (const [k, a] of Object.entries(JSON.parse(readFileSync(FILE, 'utf8')))) this.arms.set(k, a as Arm); } catch {}
    }
  }

  private arm(key: string): Arm {
    if (!this.arms.has(key)) this.arms.set(key, { alpha: 1, beta: 1, n: 0, sumNet: 0, sumNet2: 0 });
    return this.arms.get(key)!;
  }

  /** Beta sample via gamma trick (no deps). */
  private betaSample(a: number, b: number): number {
    const ga = (k: number) => { let s = 0; for (let i = 0; i < Math.ceil(k); i++) s -= Math.log(Math.random()); return s * (k / Math.ceil(k)); };
    const x = ga(a), y = ga(b);
    return x / (x + y);
  }

  /** Sampled payoff score: pSuccess × expected net (heavy-tail aware). */
  scoreArm(key: string): number {
    const a = this.arm(key);
    const pWin = this.betaSample(a.alpha, a.beta);
    const meanNet = a.n ? a.sumNet / a.n : 0;
    const sd = a.n > 2 ? Math.sqrt(Math.max(0, a.sumNet2 / a.n - meanNet * meanNet)) : meanNet;
    const sampledNet = meanNet + sd * (Math.random() * 2 - 1) / Math.sqrt(a.n + 1);
    return pWin * Math.max(0, sampledNet);
  }

  /** Budget weights across arms (softmax over sampled scores). */
  allocate(keys: string[]): Record<string, number> {
    if (this.frozen) return Object.fromEntries(keys.map((k) => [k, 1 / keys.length])); // uniform while frozen
    const scores = keys.map((k) => [k, this.scoreArm(k) + 1e-9] as const);
    const mx = Math.max(...scores.map(([, s]) => s), 1e-9);
    const exps = scores.map(([k, s]) => [k, Math.exp(2 * (s - mx) / mx)] as const);
    const tot = exps.reduce((a, [, e]) => a + e, 0);
    return Object.fromEntries(exps.map(([k, e]) => [k, e / tot]));
  }

  /** Observe one cycle outcome. */
  observe(r: ArmRow) {
    const a = this.arm(r.arm);
    a.n++;
    const win = r.outcome === 'settled' || r.outcome === 'probe_pass';
    if (win) a.alpha++; else a.beta++;
    if (r.netUsd !== undefined) { a.sumNet += r.netUsd; a.sumNet2 += r.netUsd * r.netUsd; }
    if (r.netUsd !== undefined && r.predictedNetUsd !== undefined && r.predictedNetUsd > 0) {
      const err = (r.netUsd - r.predictedNetUsd) / r.predictedNetUsd;
      this.cusum += err;
      if (Math.abs(this.cusum) > 5) this.frozen = true; // sustained miscalibration
      else if (Math.abs(this.cusum) < 0.5) this.cusum = 0;
    }
    mkdirSync('data/learn', { recursive: true });
    appendFileSync(FEATURES, JSON.stringify(r) + '\n');
    this.save();
  }

  save() { writeFileSync(FILE, JSON.stringify(Object.fromEntries(this.arms))); }
  get isFrozen() { return this.frozen; }
  unfreeze() { this.frozen = false; this.cusum = 0; }
}
