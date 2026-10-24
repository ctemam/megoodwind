/** COMPTOOL V1.2 scorecard+gate tests — run: npx tsx test/ci_scorecard_test.ts */
import { buildScorecard } from '../src/ci/scorecard.js';
import { selectTop3, longevity } from '../src/ci/benchmark.js';
import type { EntityAgg } from '../src/ci/rank.js';
import type { CiRecord } from '../src/ci/store.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const agg = (over: any = {}): EntityAgg => ({ id: '0xA', kind: 'signer', events: [{}, {}] as any, verifiedCount: 2, arbCount: 2, netUsdKnown: [10, 5], netUsdSum: 15, avgGasUsd: 2, chains: new Set(['eth']), fingerprints: new Set(['2hop/2venue']), confidence: 0.8, evidenceClass: 'verified', ...over });

// T1 verified+priced entity → COMPLETE-able fields populated
const s1 = buildScorecard(agg());
ok('T1 estimated net populated', s1.estimatedNetUsd.status === 'estimated' && s1.estimatedNetUsd.value === 15);

// T2 verifiedNetUsd stays unknown (no trace evidence)
ok('T2 verified net never invented', s1.verifiedNetUsd.status === 'unknown');

// T3 unpriced entity → estimatedNetUsd unknown not zero
const s3 = buildScorecard(agg({ netUsdKnown: [], netUsdSum: 0 }));
ok('T3 unpriced → unknown not 0', s3.estimatedNetUsd.status === 'unknown' && s3.estimatedNetUsd.value === undefined);

// T4 win rate den = priced events only, disclosed
const s4 = buildScorecard(agg({ events: [1, 2, 3] as any, netUsdKnown: [5] }));
ok('T4 win-rate den disclosed', (s4.profitableExecutionRate.value as any).den === 1 && s4.profitableExecutionRate.evidence.includes('unpriced'));

// T5 completeness gate: not_assessed blocks COMPLETE
ok('T5 gate blocks on missing', s1.completeness === 'INCOMPLETE' && s1.missing.length >= 0);

// T6 top3 eligibility — verified+n≥2+priced
const bench = selectTop3([agg({ id: 'A' }), agg({ id: 'B', evidenceClass: 'provisional' }), agg({ id: 'C', events: [1] as any })]);
ok('T6 only eligible ranked', bench.top3.length === 1 && bench.top3[0].id === 'A' && bench.insufficient.length === 2);

// T7 deterministic ranking
const b2 = selectTop3([agg({ id: 'A' }), agg({ id: 'D', netUsdSum: 100, netUsdKnown: [100] })]);
ok('T7 higher net ranks first', b2.top3[0].id === 'D');

// T8 insufficient evidence flagged not ranked
ok('T8 insufficient disclosed', bench.insufficient.every((r) => r.rank === null && r.why));

// T9 longevity from block span, observed≠launch
const rec = (b: number): CiRecord => ({ eventId: 'x', schema: 'ci-v3', chain: 'eth', kind: 'arb', tx: '0x1', block: b, pools: [], evidence: [], corrections: [] });
const lon = longevity([rec(1000), rec(1000), rec(2000), rec(3000)]);
ok('T9 spanDays measured, distinct active', lon.status === 'measured' && lon.activeBlocks === 3 && lon.spanDays !== undefined && Math.abs(lon.spanDays - 0.278) < 0.001);

// T10 no blocks → unknown not fabricated
ok('T10 no blocks → unknown', longevity([], 'eth').status === 'unknown');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
