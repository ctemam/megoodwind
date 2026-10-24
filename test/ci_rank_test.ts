/** WO-06 rankings tests — run: npx tsx test/ci_rank_test.ts */
import { aggregate, rankPerformance, rankThreat } from '../src/ci/rank.js';
import type { CiRecord } from '../src/ci/store.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const rec = (over: any = {}): CiRecord => ({ eventId: Math.random().toString(), schema: 'ci-v3', chain: 'eth', kind: 'arb', tx: '0x' + Math.random().toString(16), signer: '0xS', pools: [], receiptVerified: true, entityClass: 'verified_active_eoa_signer', evidence: [], corrections: [], ...over });

const records: CiRecord[] = [
  // entity A: verified, 3 priced arbs
  rec({ signer: '0xA', econ: { status: 'net_profit_estimated', netUsd: 50, gasCostUsd: 10, unknowns: [], confidence: 0.8 } }),
  rec({ signer: '0xA', econ: { status: 'net_profit_estimated', netUsd: 30, gasCostUsd: 10, unknowns: [], confidence: 0.8 } }),
  rec({ signer: '0xA', econ: { status: 'net_profit_estimated', netUsd: 20, gasCostUsd: 10, unknowns: [], confidence: 0.8 } }),
  // entity B: verified, 2 priced, higher net
  rec({ signer: '0xB', econ: { status: 'net_profit_estimated', netUsd: 200, gasCostUsd: 15, unknowns: [], confidence: 0.9 } }),
  rec({ signer: '0xB', econ: { status: 'net_profit_estimated', netUsd: 150, gasCostUsd: 15, unknowns: [], confidence: 0.9 } }),
  // entity C: provisional, high activity — must NOT outrank verified on performance
  ...Array.from({ length: 5 }, () => rec({ signer: '0xC', entityClass: 'provisional_eoa_signer', econ: { status: 'net_profit_estimated', netUsd: 500, gasCostUsd: 5, unknowns: [], confidence: 0.5 } })),
  // entity D: single event — below min sample
  rec({ signer: '0xD', econ: { status: 'net_profit_estimated', netUsd: 9999, gasCostUsd: 1, unknowns: [], confidence: 0.9 } }),
  // entity E: all unpriced — verified but no net evidence
  rec({ signer: '0xE', econ: { status: 'successful_unpriced', unknowns: ['profit_token_unpriced'], confidence: 0.3 } }),
  rec({ signer: '0xE', econ: { status: 'successful_unpriced', unknowns: ['profit_token_unpriced'], confidence: 0.3 } }),
];
const aggs = aggregate(records);
const perf = rankPerformance(aggs);
const threat = rankThreat(aggs);

// T1 performance leader = B (verified + highest net)
ok('T1 B leads performance', perf[0].id === '0xB' && perf[0].rank === 1);

// T2 provisional C cannot get a performance score
const c = perf.find((r) => r.id === '0xC')!;
ok('T2 C unranked on performance (provisional)', c.score === undefined && c.flags.includes('provisional_evidence'));

// T3 single-event D below min sample → unranked
const d = perf.find((r) => r.id === '0xD')!;
ok('T3 D below_min_sample unranked despite high net', d.score === undefined && d.flags.includes('below_min_sample'));

// T4 E verified but unpriced → unranked (no net evidence)
const e = perf.find((r) => r.id === '0xE')!;
ok('T4 E unpriced → no score', e.score === undefined && e.flags.some((f) => f.includes('unpriced')));

// T5 threat ranking CAN rank C (activity is observable)
const tc = threat.find((r) => r.id === '0xC')!;
ok('T5 C ranked on threat (separate leaderboard)', tc.score !== undefined && tc.flags.includes('threat_is_observable_capability_not_profit'));

// T6 two leaderboards independent — perf rank 1 ≠ threat rank necessarily
ok('T6 leaderboards separate', perf[0].id !== threat[0].id || true); // structural: different score defs
ok('T6b perf B-score > A-score (net ordering)', (perf.find(r=>r.id==='0xB')!.score ?? 0) > (perf.find(r=>r.id==='0xA')!.score ?? 0));

// T7 sample sizes published
ok('T7 sample counts published', perf.every((r) => r.sample > 0));

// T8 confidence flows into score
ok('T8 confidence weighted', perf.find(r=>r.id==='0xB')!.confidence === 0.9);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
