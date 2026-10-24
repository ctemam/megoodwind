/**
 * COMPTOOL — canonical 13-section competitor report (spec §3).
 * Every field: value or explicit EvStatus. Generated from real pipeline
 * outputs (scorecard+benchmark+longevity+records), never hand-authored.
 */
import type { EntityAgg } from './rank.js';
import type { Scorecard, EvStatus } from './scorecard.js';
import { longevity } from './benchmark.js';
import { SOURCE_MAPS, defFor } from './metricRegistry.js';

export interface CanonField { value?: unknown; status: EvStatus; note?: string }
const f = (m: { value?: unknown; status: EvStatus; evidence?: string } | undefined): CanonField =>
  m ? { value: m.value, status: m.status, note: m.evidence } : { status: 'not_assessed', note: 'metric not produced' };

export function canonicalReport(entityId: string, chain: string, sc: Scorecard, agg: EntityAgg, eligible: { ok: boolean; why?: string }, universe: { eligible: number; total: number }) {
  const lon = longevity(agg.events, chain);
  const sm = (field: string) => SOURCE_MAPS[field]?.observability ?? 'not_assessed';
  return {
    schema: 'canon-v1', entityId, chain, generatedAt: Date.now(),
    sections: {
      identity_provenance: {
        address: { value: entityId, status: 'verified' },
        entityClass: f(sc.entityClass), kind: f(sc.entityType),
        confidence: f(sc.attributionConfidence), cluster: { value: agg.kind === 'cluster', status: 'verified' },
      },
      benchmark_eligibility: { eligible: { value: eligible.ok, status: 'verified', note: eligible.why ?? (eligible.ok ? 'verified+n≥2+priced+!artifact' : 'below evidence floor') }, universe: { value: universe, status: 'verified', note: 'corpus-bounded — NOT market-wide' } },
      competitive_score: { score: f(sc.competitiveScore), formula: { value: 'score-v1: netUsdSum×confidence×pricedShare', status: 'verified' } },
      rank: { rank: f(sc.rankUniverse), universe: { value: universe, status: 'verified', note: 'corpus-bounded — NOT market-wide' } },
      profitability: { verifiedNet: f(sc.verifiedNetUsd), estimatedNet: f(sc.estimatedNetUsd), profitPerTx: f(sc.profitPerTx), gasCostUsd: f(sc.gasCostUsd), unpricedShare: f(sc.unpricedShare), formula: { value: 'estimatedNet = grossFlow − gas − flashFee − builderPay (gas ALREADY deducted)', status: 'verified' } },
      win_rates: { profitableExecution: f(sc.profitableExecutionRate), executionSuccess: { status: 'unknown', note: 'denominator unobservable publicly' }, opportunityCapture: { status: 'unknown', note: 'opportunity universe undefined' }, benchmarkWin: { status: 'not_applicable', note: 'requires head-to-head contests' } },
      longevity_activity: { first: { value: lon.firstBlock, status: lon.firstBlock ? 'estimated' : 'unknown', note: 'observed ≠ launch' }, last: { value: lon.lastBlock, status: lon.lastBlock ? 'estimated' : 'unknown' }, spanDays: { value: lon.spanDays, status: lon.spanDays !== undefined ? 'estimated' : 'unknown' }, activeBlocks: { value: lon.activeBlocks, status: 'verified' }, scanDepthLimit: { value: 'bounded by observation windows', status: 'verified' } },
      strategy_coverage: { fingerprints: f(sc.fingerprints), chains: f(sc.chains), note: { value: 'route-shape ≠ strategy proof', status: 'verified' } },
      execution_reliability: { revertRate: { status: 'unknown', note: 'reverted attempts filtered — not observable' }, gasStats: f(sc.gasCostUsd), inclusionLatency: { status: 'unknown', note: 'mempool timing unobservable' } },
      data_infrastructure: { sourceCoverage: { value: 'public getLogs+receipts', status: 'verified' }, traceAvailability: { value: 'none — public corpus', status: 'verified', note: 'caps econ at estimated' }, freshness: { value: 'per-scan', status: 'verified' } },
      evidence_quality: Object.fromEntries(Object.entries(sc).filter(([, v]) => v && typeof v === 'object' && 'status' in v).map(([k, v]) => [k, { status: (v as any).status, observability: sm(k) }])),
      allbright_comparison: { visibilityGap: { value: 'pools-outside-registry dominant loss stage', status: 'estimated', note: 'WO-14 funnel' }, replayable: { status: 'unknown', note: 'counterfactual corpus pending' } },
      conclusion: { completeness: { value: sc.completeness, status: 'verified' }, missing: { value: sc.missing, status: 'verified' }, claim: { value: 'corpus-bounded observation; no profitability/market claim', status: 'verified' } },
    },
  };
}
