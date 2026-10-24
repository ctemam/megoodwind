/** COMPTOOL dashboard — scorecards + top-3 + gap report. Run: npx tsx scripts/ci_dashboard.ts eth */
import { CiStore } from '../src/ci/store.js';
import { aggregate, rankPerformance } from '../src/ci/rank.js';
import { buildScorecard } from '../src/ci/scorecard.js';
import { selectTop3, longevity } from '../src/ci/benchmark.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';

const KEY = process.argv[2] ?? 'eth';
const store = new CiStore();
const recs = store.trusted().filter((r) => r.chain === KEY && r.tx.startsWith('0x'));
const aggs = aggregate(recs);
const bench = selectTop3(aggs);
const perf = rankPerformance(aggs);
const uni = perf.filter((r) => r.score !== undefined).length;

const cards = aggs.map((a) => {
  const sc = buildScorecard(a);
  const lon = longevity(a.events, KEY);
  sc.firstObservedBlock = lon.firstBlock !== undefined ? { value: lon.firstBlock, status: 'estimated', evidence: 'observed first-activity block' } : sc.firstObservedBlock;
  sc.lastObservedBlock = lon.lastBlock !== undefined ? { value: lon.lastBlock, status: 'estimated', evidence: 'observed last-activity block' } : sc.lastObservedBlock;
  sc.activeWindows = { value: lon.activeBlocks, status: 'verified', evidence: 'distinct active blocks' };
  const rk = perf.findIndex((r) => r.id === a.id && r.score !== undefined);
  sc.competitiveScore = rk >= 0 ? { value: perf[rk].score, status: 'estimated', evidence: `score-v1: net×conf×pricedShare` } : { status: 'unknown', evidence: 'below evidence floor' };
  sc.rankUniverse = rk >= 0 ? { value: rk + 1, status: 'estimated', evidence: `of ${uni} scored` } : { status: 'unknown', evidence: 'unranked' };
  const missing = sc.missing.length === 0 ? Object.entries(sc).filter(([, v]) => v && typeof v === 'object' && 'status' in v && (v as any).status === 'not_assessed').map(([k]) => k) : sc.missing;
  sc.missing = missing;
  const known = ['entityType','attributionConfidence','verifiedNetUsd','estimatedNetUsd','profitPerTx','gasCostUsd','unpricedShare','competitiveScore','rankUniverse','executionSuccessRate','profitableExecutionRate','firstObservedBlock','lastObservedBlock','activeWindows','fingerprints','chains','entityClass'].filter((k) => (sc as any)[k].status !== 'unknown' && (sc as any)[k].status !== 'not_assessed').length;
  sc.completeness = missing.length === 0 ? (known >= 10 ? 'COMPLETE' : 'INCOMPLETE') : 'INCOMPLETE';
  return sc;
});

// canonical 13-section reports per entity (spec §3) — wired, not authored
const { canonicalReport } = await import('../src/ci/canonicalReport.js');
const canon = aggs.map((a, i) => canonicalReport(a.id, KEY, cards[i], a,
  { ok: bench.top3.some((b) => b.id === a.id), why: bench.insufficient.find((x) => x.id === a.id)?.why },
  { eligible: bench.eligible, total: bench.universe }));

const out = {
  generatedAt: new Date().toISOString(), chain: KEY, schema: 'comptool-v1.2',
  benchmark: bench, scorecards: cards, canonicalReports: canon,
  counters: { records: recs.length, entities: aggs.length, scored: uni, complete: cards.filter((c) => c.completeness === 'COMPLETE').length },
};
const hash = createHash('sha256').update(JSON.stringify(out)).digest('hex').slice(0, 12);
writeFileSync(`data/ci/dashboard_${KEY}.json`, JSON.stringify({ ...out, hash }, null, 1));

// md view — preserved prev report pattern: write only on success
const L: string[] = [`# COMPTOOL v1.2 — ${KEY}`, `generated ${out.generatedAt} | hash=${hash}`, '', `## Top-3 benchmark (eligible=${bench.eligible}/${bench.universe})`];
for (const b of bench.top3) L.push(`- #${b.rank} ${b.id.slice(0, 12)} score=${b.score?.toFixed(3)} n=${b.n} net=${b.netUsd?.toFixed(4)} conf=${b.confidence.toFixed(2)}`);
L.push('', `## Scorecards (${cards.length})`, '| entity | score | rank | net$ | winRate | spanDays | active | completeness |');
L.push('|---|---|---|---|---|---|---|---|');
for (const c of cards.slice(0, 15)) {
  const wr = c.profitableExecutionRate.value as any;
  L.push(`| ${c.entityId.slice(0, 12)} | ${typeof c.competitiveScore.value === 'number' ? c.competitiveScore.value.toFixed(3) : 'n/a'} | ${c.rankUniverse.value ?? 'n/a'} | ${c.estimatedNetUsd.value?.toFixed(4) ?? 'unpriced'} | ${wr ? `${wr.num}/${wr.den}` : 'unknown'} | ${(c.firstObservedBlock.value !== undefined && c.lastObservedBlock.value !== undefined) ? 'obs' : 'n/a'} | ${c.activeWindows.value ?? 0} | ${c.completeness} |`);
}
L.push('', '_Evidence class: shadow/public-data. estimated≠verified. Missing=unknown, never 0._');
writeFileSync(`docs/comptool_${KEY}.md`, L.join('\n'));
console.log(`dashboard: ${cards.length} scorecards, top3=${bench.top3.length}, complete=${out.counters.complete}, hash=${hash}`);
console.log(`top3: ${bench.top3.map((b) => `#${b.rank} ${b.id.slice(0, 10)} (${b.score?.toFixed(2)})`).join(' | ') || 'insufficient evidence'}`);
