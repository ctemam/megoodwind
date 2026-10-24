/**
 * COMPTOOL Metric Registry — canonical map: metric → sources → collection →
 * formula → validation → status → dashboard field. SINGLE source of truth;
 * scorecard consumes these definitions, not ad-hoc fields.
 */
import type { EvStatus } from './scorecard.js';

export interface MetricDef {
  id: string; name: string; family: string; priority: 'primary' | 'supporting';
  evidenceReq: string;                       // minimum acceptable evidence
  sources: { tier: 1 | 2 | 3; kind: string }[];
  collection: string;                        // how to obtain
  formula: string;                           // inputs/units/denominator/exclusions
  validation: string;                        // consistency checks + failure modes
  dashboardField: string;                    // scorecard key
  governance: 'observational' | 'calculated' | 'experimental';
}

export const REGISTRY_VERSION = 'mr-v1';

export const METRIC_REGISTRY: MetricDef[] = [
  { id: 'econ.verified_net', name: 'Verified net profit', family: 'profitability', priority: 'primary',
    evidenceReq: 'receipt + trace balance deltas + all costs', sources: [{ tier: 1, kind: 'trace/receipt' }],
    collection: 'eth_getTransactionReceipt + debug_trace when available', formula: 'verifiedGross − verifiedCosts; any unknown cost → NOT verified',
    validation: 'status gate: traceVerified required', dashboardField: 'verifiedNetUsd', governance: 'calculated' },
  { id: 'econ.estimated_net', name: 'Estimated net profit', family: 'profitability', priority: 'primary',
    evidenceReq: 'gross flow + gas + priced inputs', sources: [{ tier: 1, kind: 'receipt+logs' }],
    collection: 'receipt gasUsed×effectiveGasPrice, TOKEN_USD pricing, decimals()', formula: 'grossUsd − gasUsd − flashFeeUsd − builderPayUsd',
    validation: 'unpriced cost blocks net; unknowns[] explicit', dashboardField: 'estimatedNetUsd', governance: 'calculated' },
  { id: 'econ.gas_cost', name: 'Gas expenditure', family: 'profitability', priority: 'supporting',
    evidenceReq: 'receipt gasUsed+effectiveGasPrice', sources: [{ tier: 1, kind: 'receipt' }],
    collection: 'receipt fields', formula: 'gasUsed×effectiveGasPrice×ethUsd',
    validation: 'no double-count; unpriced eth → unknown', dashboardField: 'gasCostUsd', governance: 'calculated' },
  { id: 'rank.score', name: 'Competitive score', family: 'score', priority: 'supporting',
    evidenceReq: 'verified class + n≥2 + ≥1 priced', sources: [{ tier: 1, kind: 'aggregated records' }],
    collection: 'aggregate(records)→rankPerformance', formula: 'netUsdSum × confidence × pricedShare (score-v1)',
    validation: 'below floor → unranked not zero; formula versioned', dashboardField: 'competitiveScore', governance: 'calculated' },
  { id: 'win.exec_success', name: 'Execution success rate', family: 'win_rate', priority: 'primary',
    evidenceReq: 'eligible attempts denominator — usually UNOBSERVABLE publicly', sources: [{ tier: 1, kind: 'receipts' }],
    collection: 'landed txs only; failed/private attempts invisible', formula: 'n/a — denominator unknowable from public data',
    validation: 'always unknown from public corpus alone', dashboardField: 'executionSuccessRate', governance: 'observational' },
  { id: 'win.profitable_exec', name: 'Profitable execution rate', family: 'win_rate', priority: 'primary',
    evidenceReq: 'priced events subset', sources: [{ tier: 1, kind: 'receipts+econ' }],
    collection: 'netUsd>0 count / priced events', formula: 'positiveNet / pricedEvents (unpriced excluded — disclosed)',
    validation: 'denominator = priced only, never all', dashboardField: 'profitableExecutionRate', governance: 'calculated' },
  { id: 'longevity.span', name: 'Observed operating span', family: 'longevity', priority: 'supporting',
    evidenceReq: '≥1 record w/ block', sources: [{ tier: 1, kind: 'block numbers' }],
    collection: 'min/max block × chain secPerBlock', formula: '(lastBlock−firstBlock)×spb/86400 days',
    validation: 'observed≠launch; single observation → span 0 disclosed', dashboardField: 'firstObservedBlock', governance: 'observational' },
  { id: 'strategy.fingerprints', name: 'Strategy fingerprints', family: 'strategy', priority: 'supporting',
    evidenceReq: 'decoded routes', sources: [{ tier: 1, kind: 'swap logs' }],
    collection: 'routeLen×venueCount signature per arb', formula: 'n/a — categorical',
    validation: 'shape ≠ strategy proof', dashboardField: 'fingerprints', governance: 'observational' },
  { id: 'quality.evidence_coverage', name: 'Evidence coverage', family: 'transparency', priority: 'primary',
    evidenceReq: 'scorecard field statuses', sources: [{ tier: 1, kind: 'scorecard' }],
    collection: 'count usable / required', formula: 'usableEvidence / applicableRequired ×100',
    validation: 'separate from performance score', dashboardField: 'completeness', governance: 'calculated' },
];

export function defFor(field: string) { return METRIC_REGISTRY.find((m) => m.dashboardField === field); }

/** Named-source observability class — drives what's honestly measurable. */
export type Observability = 'directly_observable' | 'reconstructable' | 'partially_observable' | 'private_unavailable';
export interface SourceMap { primary: { name: string; method: string }; corroborating?: { name: string; limit: string }; fallback?: { name: string; limit: string }; observability: Observability; }
export const SOURCE_MAPS: Record<string, SourceMap> = {
  verifiedNetUsd: { observability: 'private_unavailable', primary: { name: 'eth debug_traceTransaction', method: 'trace balance deltas (archive-only)' }, fallback: { name: 'public receipts', limit: 'no internal transfers/pricing' } },
  estimatedNetUsd: { observability: 'reconstructable', primary: { name: 'eth_getTransactionReceipt+Swap logs', method: 'gross flow − gasUsed×effPrice − detected fees' }, corroborating: { name: 'Dune/ EigenPhi labels', limit: 'Tier-2 corroboration only' } },
  gasCostUsd: { observability: 'directly_observable', primary: { name: 'eth_getTransactionReceipt', method: 'gasUsed×effectiveGasPrice' }, fallback: { name: 'eth_price feed', limit: 'WETH price only' } },
  executionSuccessRate: { observability: 'private_unavailable', primary: { name: 'unavailable publicly', method: 'failed attempts never land on-chain' } },
  profitableExecutionRate: { observability: 'partially_observable', primary: { name: 'receipts+econ layer', method: 'netUsd>0 / priced events' }, corroborating: { name: 'third-party analytics', limit: 'sample only' } },
  competitiveScore: { observability: 'reconstructable', primary: { name: 'aggregated trusted records', method: 'score-v1 formula' } },
  firstObservedBlock: { observability: 'partially_observable', primary: { name: 'block scan windows', method: 'min block observed' }, fallback: { name: 'deeper backfill', limit: 'bounded by scan depth — ≠ launch' } },
  fingerprints: { observability: 'reconstructable', primary: { name: 'Swap event decode', method: 'routeLen×venues' } },
  completeness: { observability: 'directly_observable', primary: { name: 'scorecard statuses', method: 'usable/required ratio' } },
};
