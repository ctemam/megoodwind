/**
 * WO-08 — Strategy/regime hypothesis register + lifecycle.
 * Register→Baseline→Experiment→Compare→Accept/Reject→Integrate(via change
 * control)→Monitor→Rollback. No promotion without the required prior stage.
 * Hypothesis ≠ validated improvement ≠ deployed change.
 */
import { ChangeControl, type ChangeProposal } from './changeControl.js';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';

export type HypStatus = 'registered' | 'baselined' | 'evaluating' | 'accepted' | 'rejected' | 'integrated' | 'rolled_back';

export interface Hypothesis {
  id: string;
  description: string;
  source: string;                 // evidence provenance e.g. 'WO-07 attribution eth 80-blk'
  observed: string;               // what was actually observed
  inferred?: string;              // what is inferred (kept separate)
  confidence: number;
  family?: string; variant?: string; chains?: string[]; venues?: string[];
  regime?: { volBps?: number; trend?: number; conditions: string };
  mechanism: string;              // expected causal path of improvement
  alternatives: string[];         // competing explanations
  requirements: { pools?: string[]; protocols?: string[]; feeds?: string[]; cost?: string };
  constraints: string[];          // security/risk/arch limits
  baseline?: { metric: string; value: number; window: string };
  acceptance: { metric: string; direction: 'gt' | 'lt'; threshold: number; minSample: number };
  rollback: string;
  status: HypStatus;
  result?: { metric: string; value: number; n: number; method: 'replay' | 'backtest' | 'shadow' };
  history: { at: number; to: HypStatus; why: string }[];
}

export class HypothesisRegister {
  private h = new Map<string, Hypothesis>();
  constructor(private cc: ChangeControl) {}

  register(h: Omit<Hypothesis, 'status' | 'history'>): Hypothesis {
    if (this.h.has(h.id)) throw new Error(`dup hypothesis ${h.id}`);
    const full = { ...h, status: 'registered' as const, history: [{ at: Date.now(), to: 'registered' as const, why: 'registered with evidence' }] };
    this.h.set(h.id, full);
    return full;
  }
  private move(id: string, to: HypStatus, why: string) {
    const h = this.must(id);
    const allowed: Record<HypStatus, HypStatus[]> = {
      registered: ['baselined', 'rejected'],
      baselined: ['evaluating', 'rejected'],
      evaluating: ['accepted', 'rejected'],
      accepted: ['integrated', 'rolled_back'],
      integrated: ['rolled_back'],
      rejected: [], rolled_back: ['evaluating'],
    };
    if (!allowed[h.status].includes(to)) throw new Error(`illegal transition ${h.status}→${to}`);
    h.status = to; h.history.push({ at: Date.now(), to, why });
  }
  private must(id: string) { const x = this.h.get(id); if (!x) throw new Error(`unknown hypothesis ${id}`); return x; }

  setBaseline(id: string, b: Hypothesis['baseline']) { this.must(id).baseline = b; this.move(id, 'baselined', `baseline ${b!.metric}=${b!.value} @ ${b!.window}`); }
  recordResult(id: string, r: NonNullable<Hypothesis['result']>) {
    const h = this.must(id);
    if (h.status !== 'baselined' && h.status !== 'evaluating' && h.status !== 'rolled_back') throw new Error(`recordResult requires baselined/evaluating state`);
    if (h.status === 'baselined') this.move(id, 'evaluating', 'experiment started');
    h.result = r;
  }
  /** Compare applies acceptance criteria — min sample enforced, direction honored. */
  compare(id: string): 'accepted' | 'rejected' {
    const h = this.must(id);
    if (!h.baseline || !h.result) throw new Error('compare requires baseline + result');
    if (h.result.n < h.acceptance.minSample) { this.move(id, 'rejected', `n=${h.result.n} < minSample ${h.acceptance.minSample}`); return 'rejected'; }
    const ok = h.acceptance.direction === 'gt' ? h.result.value > h.acceptance.threshold : h.result.value < h.acceptance.threshold;
    this.move(id, ok ? 'accepted' : 'rejected', `${h.result.metric}=${h.result.value} vs ${h.acceptance.direction}${h.acceptance.threshold}`);
    return h.status as 'accepted' | 'rejected';
  }
  /** Integration goes through ChangeControl — never direct. */
  integrate(id: string, proposal: ChangeProposal, opts: { approved?: boolean; commanderToken?: string } = {}) {
    const h = this.must(id);
    if (h.status !== 'accepted') throw new Error('integrate requires accepted hypothesis');
    const rec = this.cc.propose(proposal, opts);
    if (rec.decided === 'applied') this.move(id, 'integrated', `change applied: ${rec.why}`);
    return rec;
  }
  rollback(id: string, why: string) { this.move(id, 'rolled_back', why); }
  get(id: string) { return this.h.get(id); }
  all() { return [...this.h.values()]; }
  byStatus(s: HypStatus) { return this.all().filter((h) => h.status === s); }
  save(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(this.all()));
    renameSync(file + '.tmp', file);
  }
  static load(file: string, cc: ChangeControl) {
    const r = new HypothesisRegister(cc);
    if (existsSync(file)) for (const h of JSON.parse(readFileSync(file, 'utf8')) as Hypothesis[]) (r as any).h.set(h.id, h);
    return r;
  }
}
