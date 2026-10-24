/**
 * Gap-1 — nine-stage per-winner deconstruction harness (offline/replay only).
 * Each stage: observed | reconstructed | unavailable | not_applicable.
 * Never manufactures stages 1-7 from a receipt. Feeds factors → Hypothesis lifecycle.
 * NO strategy weights, NO live exec, NO pipeline behavior change.
 */
import type { CiRecord } from './store.js';

export type StageStatus = 'observed' | 'reconstructed' | 'unavailable' | 'not_applicable';
export interface StageResult {
  stage: string; status: StageStatus; value?: unknown;
  reason?: string;          // why not reproducible / why unavailable
  evidence?: string;        // what supports the claim
}
export interface DeconReport {
  schema: 'decon-v1'; entityId: string; tx: string; generatedAt: number;
  stages: StageResult[];
  advantageHypotheses: { factor: string; evidence: string; test: string }[];
  limits: string[];
}

const S = (stage: string, status: StageStatus, extra: Partial<StageResult> = {}): StageResult => ({ stage, status, ...extra });

export function deconstructTx(r: CiRecord, opts: { replayOutcome?: string; projectedNetUsd?: number } = {}): DeconReport {
  const stages: StageResult[] = [
    // 1 scanning/detection — partially reconstructable: we know WHEN it landed, not when they detected
    S('scanning_detection', 'reconstructed', { value: { block: r.block, txIndex: r.txIndex }, evidence: 'landing position observable; their detection timing NOT', reason: 'competitor detection latency private' }),
    // 2 zone/pool selection — observed: pools in the route are on-chain facts
    S('zone_selection', 'observed', { value: { pools: r.pools, chain: r.chain }, evidence: 'route pools from decoded swap events' }),
    // 3 projection — reconstructed: our econ model re-prices their flow; their projection unknown
    S('projection', r.econ?.netUsd !== undefined ? 'reconstructed' : 'unavailable', { value: r.econ?.netUsd, evidence: 'our gross−costs repricing', reason: r.econ?.netUsd === undefined ? 'unpriced inputs' : 'their internal projection private' }),
    // 4 replay — observed IF replay run, else unavailable
    S('replay', opts.replayOutcome ? 'observed' : 'unavailable', { value: opts.replayOutcome, reason: opts.replayOutcome ? undefined : 'replay not run for this tx' }),
    // 5 candidate selection — unavailable: their candidate set private
    S('candidate_generation', 'unavailable', { reason: 'which routes they evaluated is private' }),
    // 6 qualification — unavailable: their thresholds private
    S('qualification', 'unavailable', { reason: 'their profit/risk gates private' }),
    // 7 execution request — partially observed: gas price + private-hint observable
    S('execution_request', 'observed', { value: { privateHint: (r as any).privateHint, gasUsed: (r as any).gasUsed }, evidence: 'submission channel + gas observable', reason: 'bundle internals not observable' }),
    // 8 execution/settlement — observed: receipt status is fact
    S('execution_settlement', 'observed', { value: { receiptVerified: r.receiptVerified }, evidence: 'on-chain receipt' }),
    // 9 outcome reconciliation — reconstructed via profit model
    S('outcome_reconciliation', r.econ ? 'reconstructed' : 'unavailable', { value: { status: r.econ?.status, netUsd: r.econ?.netUsd, unknowns: r.econ?.unknowns }, evidence: 'profit-truth model', reason: r.econ ? 'estimated not verified (no trace)' : 'no econ record' }),
  ];
  // advantage hypotheses — only from observed evidence, never invented
  const hyps: { factor: string; evidence: string; test: string }[] = [];
  if ((r as any).privateHint) hyps.push({ factor: 'private_submission_channel', evidence: 'coinbase payment / private route detected', test: 'replay via public path → does outcome degrade?' });
  if ((r.pools?.length ?? 0) >= 3) hyps.push({ factor: 'multi_venue_route', evidence: `${r.pools!.length} pools in route`, test: 'compare 2-venue-only corpus outcomes' });
  return {
    schema: 'decon-v1', entityId: r.signer ?? 'unknown', tx: r.tx, generatedAt: Date.now(), stages,
    advantageHypotheses: hyps,
    limits: ['stages 5-6 private (candidate set + thresholds unobservable)', 'detection timing unobservable', 'replay needs authorized run', 'estimated≠verified economics'],
  };
}

/** Batch deconstruct an entity's arbs → aggregated stage-coverage summary. */
export function deconstructEntity(recs: CiRecord[]) {
  const reports = recs.map((r) => deconstructTx(r));
  const coverage: Record<string, Record<StageStatus, number>> = {};
  for (const rep of reports) for (const s of rep.stages) { coverage[s.stage] = coverage[s.stage] ?? { observed: 0, reconstructed: 0, unavailable: 0, not_applicable: 0 }; coverage[s.stage][s.status]++; }
  return { reports, coverage, hypotheses: [...new Map(reports.flatMap((r) => r.advantageHypotheses).map((h) => [h.factor, h])).values()] };
}
