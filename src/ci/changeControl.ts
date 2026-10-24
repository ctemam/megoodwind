/**
 * WO-10 — DNA vs Adaptive change control (L2 enforcement, not documentation).
 * Every mutation of a governed target goes through propose() → classify → gate.
 * Denials are audit-recorded, not silent. Commander token = explicit authorization
 * evidence, never self-granted.
 */
export type ChangeClass = 'A_bounded' | 'B_reviewed' | 'C_commander';
export interface ChangeProposal {
  target: string;            // dotted path e.g. 'solver.minProfitFloor'
  proposed: unknown;
  reason: string;
  evidence: string;
  validation?: { baseline: unknown; result: unknown; method: 'replay' | 'backtest' | 'shadow' };
}
export interface ChangeRecord extends ChangeProposal {
  cls: ChangeClass; decided: 'applied' | 'denied' | 'pending_review';
  prev?: unknown; at: number; why: string;
}

// DNA — Commander-reserved targets. Anything touching these is Class C.
const DNA_PATTERNS = [
  /sign/i, /private.?key/i, /secret/i, /mayExecute/i, /armedFor/i, /kill/i,
  /breaker/i, /capital.?cap/i, /minProfit/i, /minOut/i, /authorize/i, /deploy/i,
  /rpc.?budget/i, /paid/i, /subscription/i, /executor\.(address|bytecode)/i,
  /safety|preflight|guard|security/i,
];
// Adaptive targets with bounded ranges — Class A only INSIDE range, else B.
const BOUNDED: Record<string, { min?: number; max?: number; enum?: unknown[] }> = {
  'regime.weights': { min: 0, max: 1 },
  'variant.priority': { min: 0, max: 1 },
  'rpc.ewma_weight': { min: 0, max: 1 },
  'scan.chunkBlocks': { min: 10, max: 1000 },
  'ci.confidence_floor': { min: 0, max: 1 },
};

export function classify(target: string, value: unknown): ChangeClass {
  if (DNA_PATTERNS.some((p) => p.test(target))) return 'C_commander';
  const b = BOUNDED[target];
  if (!b) return 'B_reviewed';                        // unknown target → review, never auto
  if (b.enum) return b.enum.includes(value) ? 'A_bounded' : 'B_reviewed';
  if (typeof value === 'number') {
    if ((b.min !== undefined && value < b.min) || (b.max !== undefined && value > b.max)) return 'B_reviewed';
    return 'A_bounded';
  }
  return 'B_reviewed';
}

export class ChangeControl {
  private log: ChangeRecord[] = [];
  private state: Record<string, unknown> = {};
  constructor(private commanderTokens: Set<string> = new Set()) {}

  /** Returns the record; mutation only applied when decided==='applied'. */
  propose(p: ChangeProposal, opts: { approved?: boolean; commanderToken?: string } = {}): ChangeRecord {
    const cls = classify(p.target, p.proposed);
    const rec: ChangeRecord = { ...p, cls, prev: this.state[p.target], at: Date.now(), decided: 'pending_review', why: '' };
    if (cls === 'A_bounded') {
      if (!p.validation) { rec.decided = 'denied'; rec.why = 'bounded change requires baseline validation'; }
      else { rec.decided = 'applied'; rec.why = 'within bounded range + validation attached'; this.state[p.target] = p.proposed; }
    } else if (cls === 'B_reviewed') {
      if (opts.approved && p.validation) { rec.decided = 'applied'; rec.why = 'reviewed+approved with validation'; this.state[p.target] = p.proposed; }
      else { rec.decided = 'denied'; rec.why = 'reviewed-class requires explicit approval + validation'; }
    } else {
      if (opts.commanderToken && this.commanderTokens.has(opts.commanderToken) && opts.approved && p.validation) {
        rec.decided = 'applied'; rec.why = 'Commander-authorized'; this.state[p.target] = p.proposed;
      } else { rec.decided = 'denied'; rec.why = 'Commander-reserved: requires commander token + approval + validation'; }
    }
    this.log.push(rec);
    return rec;
  }
  audit() { return [...this.log]; }
  denied() { return this.log.filter((r) => r.decided === 'denied'); }
  get(target: string) { return this.state[target]; }
}
