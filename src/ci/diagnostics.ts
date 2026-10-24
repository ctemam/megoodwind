/**
 * WO-14 — Nine-stage pipeline diagnostics. READ-ONLY measurement: counts
 * where opportunity evidence is lost, using mc-v1 denominators. Never tunes
 * thresholds or mutates what it measures. Every rate carries num/den/window.
 *
 * Stage map (WO-14 spec):
 *  1 detection/visibility   2 observation/ingestion  3 validation
 *  4 projection/pricing     5 replay/simulation      6 candidate generation
 *  7 qualification          8 execution-readiness    9 settlement/econ-verify
 */
import type { CiRecord } from './store.js';
import { attribute } from './attribute.js';
import type { JoinOutcome, ObsWindow } from './measure.js';

export const STAGES = [
  'detection_visibility', 'observation_ingestion', 'validation',
  'projection_pricing', 'replay_simulation', 'candidate_generation',
  'qualification', 'execution_readiness', 'settlement_econ',
] as const;
export type StageName = (typeof STAGES)[number];

export interface StageCell { entered: number; passed: number; lost: number; reasons: Record<string, number>; }
export interface Funnel {
  window?: ObsWindow; eligible: number; excluded: number; unresolved: number;
  stages: Record<StageName, StageCell>;
  join: Record<JoinOutcome, number>;
}

export function newFunnel(w?: ObsWindow): Funnel {
  const cell = (): StageCell => ({ entered: 0, passed: 0, lost: 0, reasons: {} });
  return { window: w, eligible: 0, excluded: 0, unresolved: 0,
    stages: Object.fromEntries(STAGES.map((s) => [s, cell()])) as Funnel['stages'],
    join: { matched: 0, partial: 0, unmatched: 0, unresolved: 0, excluded: 0 } };
}

// attribute() outcome → (stage lost at, loss family) — stages 7-9 unreachable
// in shadow (no our-side execution); honest gap, not zero.
function stageOf(outcome: string, attrStage: number): { stage: StageName; family: string } {
  switch (outcome) {
    case 'visibility_failure': return { stage: 'detection_visibility', family: 'pool/route absent from registry' };
    case 'pipeline_rejection': return { stage: attrStage <= 2 ? 'validation' : 'projection_pricing', family: `stage-${attrStage} gate rejection` };
    case 'not_economically_viable': return { stage: 'qualification', family: 'net≤floor under OUR costs' };
    case 'execution_failure': return { stage: 'execution_readiness', family: 'prep/submission failure' };
    case 'confirmed_missed': return { stage: 'settlement_econ', family: 'passed all gates — genuinely missed' };
    default: return { stage: attrStage >= 4 ? 'replay_simulation' : 'projection_pricing', family: 'insufficient evidence (indeterminate)' };
  }
}

/**
 * Funnel computation: each record counted ONCE at its loss stage.
 * entered = eligible population; passed = entered - lost for that stage
 * (record reaching a later stage passed all earlier ones implicitly).
 */
export function computeFunnel(
  records: CiRecord[],
  ctx: { ourPools: Set<string>; convictedPools?: Set<string>; ourMinProfitUsd?: number; replayed?: Map<string, { executable: boolean; netUsd?: number; reason?: string }> },
  w?: ObsWindow,
): Funnel {
  const f = newFunnel(w);
  // observation/ingestion accounting first
  for (const r of records) {
    if (!r.receiptVerified) { f.unresolved++; continue; }   // can't even confirm event
    f.eligible++;
    const a = attribute({ rec: r, ourPools: ctx.ourPools, convictedPools: ctx.convictedPools, ourMinProfitUsd: ctx.ourMinProfitUsd, replayed: ctx.replayed?.get(r.eventId) });
    const { stage, family } = stageOf(a.outcome, a.stage);
    // entered+passed all stages before loss stage; lost at its stage
    const si = STAGES.indexOf(stage);
    for (let s = 0; s < STAGES.length; s++) {
      const cell = f.stages[STAGES[s]];
      if (s < si) { cell.entered++; cell.passed++; }
      else if (s === si) { cell.entered++; cell.lost++; cell.reasons[`${a.outcome}:${family}`] = (cell.reasons[`${a.outcome}:${family}`] ?? 0) + 1; }
      // stages after loss: never entered
    }
    if (a.outcome === 'confirmed_missed') { f.stages.settlement_econ.passed += 0; } // explicit: reached end but missed
  }
  return f;
}

/** Loss rate per stage with honest denominator (entered). */
export function stageRates(f: Funnel) {
  return STAGES.map((s, i) => {
    const c = f.stages[s];
    return { stage: i + 1, name: s, entered: c.entered, lost: c.lost, lossRate: c.entered > 0 ? c.lost / c.entered : undefined, topReasons: Object.entries(c.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3) };
  });
}
