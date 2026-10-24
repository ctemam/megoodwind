/**
 * WO-06 — Two-ranking system. Performance ≠ threat. NEVER combined into one score.
 * Performance rank requires econ evidence; threat rank requires observable behavior.
 * Min-evidence gate; confidence-aware; sample sizes published. Quarantined excluded.
 */
import type { CiRecord } from './store.js';

export interface EntityAgg {
  id: string;                    // signer or cluster id
  kind: 'signer' | 'cluster';
  events: CiRecord[];
  verifiedCount: number;         // verified_active classes only
  arbCount: number;
  netUsdKnown: number[];         // only records with defensible netUsd
  netUsdSum: number;
  avgGasUsd?: number;
  chains: Set<string>;
  fingerprints: Set<string>;
  confidence: number;            // min over inputs, weighted
  evidenceClass: 'verified' | 'provisional' | 'unverified';
}

export interface RankRow {
  rank: number; id: string; kind: string;
  score?: number;                // undefined if below evidence floor — never faked
  sample: number;                // n events
  verifiedN: number;
  netUsd?: number;               // only if ≥1 priced event
  confidence: number;
  evidenceClass: string;
  flags: string[];               // limitations disclosed
}

const MIN_SAMPLE = 2;            // below this → unranked, disclosed

export function aggregate(records: CiRecord[]): EntityAgg[] {
  const byId = new Map<string, CiRecord[]>();
  for (const r of records) {
    const id = r.clusterId ?? r.signer;
    if (!id) continue;
    (byId.get(id) ?? byId.set(id, []).get(id)!).push(r);
  }
  return [...byId.entries()].map(([id, ev]) => {
    const verified = ev.filter((r) => r.entityClass?.startsWith('verified_active')).length;
    const priced = ev.filter((r) => r.econ?.netUsd !== undefined).map((r) => r.econ!.netUsd!);
    const gas = ev.map((r) => r.econ?.gasCostUsd).filter((x): x is number => x !== undefined);
    const confs = ev.map((r) => r.econ?.confidence ?? r.classConfidence ?? 0);
    const cls = ev.every((r) => r.entityClass?.startsWith('verified_active')) ? 'verified'
      : ev.some((r) => r.entityClass === 'suspected_deceptive' || r.entityClass === 'unverified_frontrunner') ? 'unverified' : 'provisional';
    return {
      id, kind: ev[0].clusterId ? 'cluster' : 'signer', events: ev, verifiedCount: verified, arbCount: ev.filter((r) => r.kind === 'arb').length,
      netUsdKnown: priced, netUsdSum: priced.reduce((a, b) => a + b, 0),
      avgGasUsd: gas.length ? gas.reduce((a, b) => a + b, 0) / gas.length : undefined,
      chains: new Set(ev.map((r) => r.chain)), fingerprints: new Set(ev.map((r) => r.fingerprint).filter((f): f is string => !!f)),
      confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0,
      evidenceClass: cls,
    };
  });
}

/** A. Verified performance — ONLY entities meeting evidence floor get a score. */
export function rankPerformance(aggs: EntityAgg[]): RankRow[] {
  const rows: RankRow[] = aggs.map((a) => {
    const flags: string[] = [];
    if (a.events.length < MIN_SAMPLE) flags.push('below_min_sample');
    if (a.netUsdKnown.length === 0) flags.push('all_unpriced');
    if (a.netUsdKnown.length < a.events.length) flags.push(`${a.events.length - a.netUsdKnown.length}/${a.events.length} unpriced`);
    const eligible = a.evidenceClass === 'verified' && a.events.length >= MIN_SAMPLE;
    // score = confidence-weighted normalized net + consistency (only when priced data exists)
    const score = eligible && a.netUsdKnown.length
      ? a.netUsdSum * a.confidence * (a.netUsdKnown.length / a.events.length)
      : undefined;
    if (!eligible) flags.push(a.evidenceClass !== 'verified' ? 'provisional_evidence' : 'insufficient_verified_events');
    return { rank: 0, id: a.id, kind: a.kind, score, sample: a.events.length, verifiedN: a.verifiedCount,
             netUsd: a.netUsdKnown.length ? a.netUsdSum : undefined, confidence: a.confidence, evidenceClass: a.evidenceClass, flags };
  });
  const scored = rows.filter((r) => r.score !== undefined).sort((a, b) => b.score! - a.score!);
  scored.forEach((r, i) => (r.rank = i + 1));
  return [...scored, ...rows.filter((r) => r.score === undefined)];
}

/** B. Threat/capability — observable behavior, separate leaderboard. */
export function rankThreat(aggs: EntityAgg[]): RankRow[] {
  const rows: RankRow[] = aggs.map((a) => {
    const flags: string[] = ['threat_is_observable_capability_not_profit'];
    if (a.events.length < MIN_SAMPLE) flags.push('below_min_sample');
    // threat score: coverage breadth + volume + consistency — observable only
    const score = a.events.length >= MIN_SAMPLE
      ? a.events.length * 0.4 + a.fingerprints.size * 0.3 + a.chains.size * 0.2 + (a.avgGasUsd !== undefined ? 0.1 : 0)
      : undefined;
    return { rank: 0, id: a.id, kind: a.kind, score, sample: a.events.length, verifiedN: a.verifiedCount,
             netUsd: a.netUsdKnown.length ? a.netUsdSum : undefined, confidence: a.confidence, evidenceClass: a.evidenceClass, flags };
  });
  const scored = rows.filter((r) => r.score !== undefined).sort((a, b) => b.score! - a.score!);
  scored.forEach((r, i) => (r.rank = i + 1));
  return [...scored, ...rows.filter((r) => r.score === undefined)];
}
