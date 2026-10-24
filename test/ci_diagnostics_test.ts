/** WO-14 funnel tests — run: npx tsx test/ci_diagnostics_test.ts */
import { computeFunnel, stageRates, STAGES } from '../src/ci/diagnostics.js';
import type { CiRecord } from '../src/ci/store.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const rec = (over: any = {}): CiRecord => ({ eventId: Math.random().toString(), schema: 'ci-v3', chain: 'eth', kind: 'arb', tx: '0x' + Math.random().toString(16), pools: ['0xP1', '0xP2'], receiptVerified: true, evidence: [], corrections: [], ...over });
const our = new Set(['0xp1', '0xp2']);

const records = [
  // 8 visibility failures (pools absent)
  ...Array.from({ length: 8 }, () => rec({ pools: ['0xQ1', '0xQ2'] })),
  // 2 in-registry, replayed executable + net>floor → confirmed_missed
  rec({ econ: { status: 'net_profit_estimated', netUsd: 50, unknowns: [], confidence: 0.8 } }),
  rec({ econ: { status: 'net_profit_estimated', netUsd: 30, unknowns: [], confidence: 0.8 } }),
  // 1 unverified receipt → unresolved
  rec({ receiptVerified: false }),
];
const replayed = new Map(records.slice(8, 10).map((r) => [r.eventId, { executable: true, netUsd: 40 }]));
const f = computeFunnel(records, { ourPools: our, replayed });
const rates = stageRates(f);

// T1 each record counted once; eligible=10, unresolved=1
ok('T1 eligible/unresolved split', f.eligible === 10 && f.unresolved === 1);

// T2 stage1 entered=10, lost=8
ok('T2 stage1 8/10 lost', f.stages.detection_visibility.entered === 10 && f.stages.detection_visibility.lost === 8);

// T3 survivors flow through 2-4 without loss
ok('T3 stages2-4 clean', f.stages.validation.lost === 0 && f.stages.projection_pricing.lost === 0);

// T4 replayed confirmed_missed lands at settlement
ok('T4 confirmed_missed → stage9', f.stages.settlement_econ.lost === 2 && f.stages.settlement_econ.entered === 2);

// T5 no double-count: total entered at stage1 == eligible
ok('T5 no inflation', f.stages.detection_visibility.entered === f.eligible);

// T6 lossRate has honest denominator
const s1 = rates[0];
ok('T6 rate = lost/entered', Math.abs((s1.lossRate ?? 0) - 0.8) < 1e-9);

// T7 never-entered stage → rate undefined not 0 (all-lost-at-1 funnel)
const fVis = computeFunnel([rec({ pools: ['0xZ1', '0xZ2'] }), rec({ pools: ['0xZ3', '0xZ4'] })], { ourPools: our });
const sVis = stageRates(fVis)[8];
ok('T7 never-entered → n/a', sVis.entered === 0 && sVis.lossRate === undefined);

// T8 reasons carry outcome:family detail
ok('T8 reason granularity', Object.keys(f.stages.detection_visibility.reasons)[0].includes('visibility_failure'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
