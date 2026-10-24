/**
 * COMPTOOL V1.2 — top-3 benchmark selection + longevity tracking.
 * Eligibility: verified evidence class + n≥2 + ≥1 priced event. Same scoring
 * method for all eligible. Insufficient evidence → provisional, never forced.
 * Longevity = observed span in blocks→days (12s/blk eth) — observed, NOT launch.
 */
import type { EntityAgg } from './rank.js';
import type { CiRecord } from './store.js';

export interface BenchmarkEntry { rank: number | null; id: string; score?: number; n: number; netUsd?: number; confidence: number; eligible: boolean; provisional?: boolean; why?: string; }
export interface Benchmark { version: 'bench-v1'; generatedAt: number; universe: number; eligible: number; top3: BenchmarkEntry[]; insufficient: BenchmarkEntry[]; }

const ELIG = (a: EntityAgg) => a.evidenceClass === 'verified' && a.events.length >= 2 && a.netUsdKnown.length >= 1
  && !a.events.some((r) => r.entityClass === 'unclassifiable_decode_artifact' || /^0x0{8,}/.test(r.signer?.toLowerCase() ?? 'x')); // AUD-D1

export function selectTop3(aggs: EntityAgg[]): Benchmark {
  const eligible = aggs.filter(ELIG);
  const scored = eligible.map((a) => ({ a, score: a.netUsdSum * a.confidence * (a.netUsdKnown.length / a.events.length) })).sort((x, y) => y.score - x.score);
  const top3 = scored.slice(0, 3).map((s, i) => ({ rank: i + 1, id: s.a.id, score: s.score, n: s.a.events.length, netUsd: s.a.netUsdSum, confidence: s.a.confidence, eligible: true, provisional: s.a.events.length < 5 }));
  const insufficient = aggs.filter((a) => !ELIG(a)).map((a) => ({
    rank: null, id: a.id, n: a.events.length, confidence: a.confidence, eligible: false,
    why: a.evidenceClass !== 'verified' ? 'unverified evidence class' : a.events.length < 2 ? 'below min sample' : 'no priced events',
  }));
  return { version: 'bench-v1', generatedAt: Date.now(), universe: aggs.length, eligible: eligible.length, top3, insufficient };
}

export interface Longevity { firstBlock?: number; lastBlock?: number; spanDays?: number; activeBlocks: number; status: 'measured' | 'unknown'; }
const SEC_PER_BLOCK: Record<string, number> = { eth: 12, base: 2, arb: 0.25, op: 2, poly: 2, avax: 2 };
export function longevity(recs: CiRecord[], chain = 'eth'): Longevity {
  const blks = recs.map((r) => r.block).filter((b): b is number => b !== undefined);
  if (!blks.length) return { activeBlocks: 0, status: 'unknown' };
  const first = Math.min(...blks), last = Math.max(...blks);
  const spb = SEC_PER_BLOCK[chain] ?? 12;
  return { firstBlock: first, lastBlock: last, spanDays: +(((last - first) * spb) / 86400).toFixed(3), activeBlocks: new Set(blks).size, status: 'measured' };
}

/**
 * Winner-selection separation (Commander order): OBSERVED_ENTITY_RANKING ≠
 * QUALIFIED winner. Predeclared qualification requirements — never tuned
 * to the observed set. NO_QUALIFIED_WINNER is a valid output.
 */
export type QualStatus = 'QUALIFIED' | 'PROVISIONAL' | 'INSUFFICIENT_EVIDENCE' | 'EXCLUDED';
export interface Qualification { status: QualStatus; reasons: string[]; }
/** PREDECLARED requirements (spec-frozen, not data-fitted): */
export const QUAL_REQ = { minSample: 10, minPricedShare: 0.8, maxUnknownEcon: 0, requireVerifiedClass: true } as const;

export function qualify(a: EntityAgg): Qualification {
  const reasons: string[] = [];
  if (a.evidenceClass !== 'verified') reasons.push(`evidence_class=${a.evidenceClass}!=verified`);
  if (a.events.length < QUAL_REQ.minSample) reasons.push(`n=${a.events.length}<${QUAL_REQ.minSample}`);
  const pricedShare = a.events.length ? a.netUsdKnown.length / a.events.length : 0;
  if (pricedShare < QUAL_REQ.minPricedShare) reasons.push(`pricedShare=${pricedShare.toFixed(2)}<${QUAL_REQ.minPricedShare}`);
  const unknownEcon = a.events.filter((r) => (r.econ?.unknowns?.length ?? 0) > 0).length;
  if (unknownEcon > QUAL_REQ.maxUnknownEcon) reasons.push(`econ_unknowns_in ${unknownEcon} records`);
  if (a.events.length >= 2 && a.netUsdKnown.length >= 1 && reasons.length) return { status: 'PROVISIONAL', reasons };
  if (reasons.length) return { status: 'INSUFFICIENT_EVIDENCE', reasons };
  return { status: 'QUALIFIED', reasons: [] };
}

export function qualifiedWinner(aggs: EntityAgg[]): { winner: string | null; verdict: string; perEntity: { id: string; q: Qualification }[] } {
  const perEntity = aggs.map((a) => ({ id: a.id, q: qualify(a) }));
  const qualified = perEntity.filter((e) => e.q.status === 'QUALIFIED').map((e) => e.id);
  const ranked = [...aggs.filter((a) => qualified.includes(a.id))].sort((x, y) => y.netUsdSum - x.netUsdSum);
  const winner = ranked[0]?.id ?? null;
  return { winner, verdict: winner ? `qualified: ${winner}` : 'NO_QUALIFIED_WINNER', perEntity };
}
