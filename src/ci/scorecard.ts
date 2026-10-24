/**
 * COMPTOOL V1.2 — canonical scorecard + completeness gate + top-3 benchmark.
 * Every metric has an explicit status; missing evidence is never zero.
 * COMPLETE only when every required metric is a valid non-'not_assessed' status.
 */
import type { CiRecord } from './store.js';
import type { EntityAgg } from './rank.js';

export type EvStatus = 'verified' | 'estimated' | 'inferred' | 'unknown' | 'not_applicable' | 'not_assessed';
export interface Metric<T = unknown> { value?: T; status: EvStatus; evidence: string; window?: string; confidence?: number; }

export interface Scorecard {
  schema: 'sc-v1';
  entityId: string;
  generatedAt: number;
  // identity
  entityType: Metric<string>;         // signer | contract | cluster
  attributionConfidence: Metric<number>;
  // A. economics
  verifiedNetUsd: Metric<number>;     // only trace-verified nets
  estimatedNetUsd: Metric<number>;
  profitPerTx: Metric<number>;
  gasCostUsd: Metric<number>;
  unpricedShare: Metric<number>;      // fraction of events without net
  // B. score + rank
  competitiveScore: Metric<number>;   // formula-versioned, component-disclosed
  rankUniverse: Metric<number>;
  // C. win rates (each num/den explicit)
  executionSuccessRate: Metric<{ num: number; den: number }>;
  profitableExecutionRate: Metric<{ num: number; den: number }>;
  // D. longevity
  firstObservedBlock?: Metric<number>;
  lastObservedBlock?: Metric<number>;
  activeWindows: Metric<number>;      // distinct windows with activity
  // E. strategy/ops
  fingerprints: Metric<string[]>;
  chains: Metric<string[]>;
  entityClass: Metric<string>;
  // gaps + completeness
  allbrightGap?: Metric<string>;
  completeness: 'COMPLETE' | 'INCOMPLETE' | 'INSUFFICIENT';
  missing: string[];
}

export const SCORE_VERSION = 'score-v1';

/** Per-event status → entity metric. Never invent a value. */
export function buildScorecard(a: EntityAgg, rank?: { rank: number; universeSize: number }): Scorecard {
  const sc: Scorecard = {
    schema: 'sc-v1', entityId: a.id, generatedAt: Date.now(), completeness: 'INCOMPLETE', missing: [],
    entityType: { value: a.kind, status: 'verified', evidence: 'signer/executor pair + cluster heuristic' },
    attributionConfidence: { value: a.confidence, status: a.confidence > 0 ? 'estimated' : 'unknown', evidence: 'mean record confidence' },
    verifiedNetUsd: { status: 'unknown', evidence: 'no trace-level evidence in public-data corpus' },
    estimatedNetUsd: a.netUsdKnown.length
      ? { value: a.netUsdSum, status: 'estimated', evidence: `${a.netUsdKnown.length}/${a.events.length} priced`, confidence: a.confidence }
      : { status: 'unknown', evidence: 'no priced events' },
    profitPerTx: a.netUsdKnown.length ? { value: a.netUsdSum / a.events.length, status: 'estimated', evidence: 'net over observed events' } : { status: 'unknown', evidence: 'no priced events' },
    gasCostUsd: a.avgGasUsd !== undefined ? { value: a.avgGasUsd * a.events.length, status: 'estimated', evidence: 'gasUsed×effectiveGasPrice×WETH' } : { status: 'unknown', evidence: 'gas unpriced' },
    unpricedShare: { value: (a.events.length - a.netUsdKnown.length) / a.events.length, status: 'verified', evidence: 'priced-event share' },
    competitiveScore: { status: 'not_assessed', evidence: 'set by rank layer' },
    rankUniverse: { status: 'not_assessed', evidence: 'set by rank layer' },
    executionSuccessRate: { status: 'unknown', evidence: 'public data cannot observe failed attempts' },
    profitableExecutionRate: a.netUsdKnown.length ? { value: { num: a.netUsdKnown.filter((n) => n > 0).length, den: a.netUsdKnown.length }, status: 'estimated', evidence: 'priced events only — unpriced excluded' } : { status: 'unknown', evidence: 'no priced events' },
    firstObservedBlock: { status: 'unknown', evidence: 'set by caller when blocks present' },
    lastObservedBlock: { status: 'unknown', evidence: 'set by caller when blocks present' },
    activeWindows: { status: 'unknown', evidence: 'window tracking pending' },
    fingerprints: { value: [...a.fingerprints], status: 'estimated', evidence: 'route-shape signature' },
    chains: { value: [...a.chains], status: 'verified', evidence: 'per-record chain field' },
    entityClass: { value: a.evidenceClass, status: 'verified', evidence: 'entity classification' },
  };
  // completeness gate: every metric must carry a VALID status incl. explicit unknowns
  const required: (keyof Scorecard)[] = ['entityType', 'attributionConfidence', 'verifiedNetUsd', 'estimatedNetUsd', 'profitPerTx', 'gasCostUsd', 'unpricedShare', 'competitiveScore', 'rankUniverse', 'executionSuccessRate', 'profitableExecutionRate', 'firstObservedBlock', 'lastObservedBlock', 'activeWindows', 'fingerprints', 'chains', 'entityClass'];
  sc.missing = required.filter((k) => (sc[k] as Metric).status === 'not_assessed');
  const known = required.filter((k) => (sc[k] as Metric).status !== 'unknown' && (sc[k] as Metric).status !== 'not_assessed').length;
  sc.completeness = sc.missing.length === 0 ? (known >= 10 ? 'COMPLETE' : 'INCOMPLETE') : 'INCOMPLETE';
  return sc;
}
