/** WO-07 attribution tests — run: npx tsx test/ci_attribute_test.ts */
import { attribute } from '../src/ci/attribute.js';
import type { CiRecord } from '../src/ci/store.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const rec = (over: any = {}): CiRecord => ({ eventId: 'e1', schema: 'ci-v3', chain: 'eth', kind: 'arb', tx: '0xX', pools: ['0xP1', '0xP2'], receiptVerified: true, evidence: [], corrections: [], ...over });
const our = new Set(['0xp1', '0xp2']);

// T1 all pools absent → visibility_failure
const t1 = attribute({ rec: rec({ pools: ['0xQ1', '0xQ2'] }), ourPools: our });
ok('T1 0/2 pools → visibility stage1', t1.outcome === 'visibility_failure' && t1.stage === 1);

// T2 partial pools → still visibility (cycle unreachable)
const t2 = attribute({ rec: rec({ pools: ['0xP1', '0xQ2'] }), ourPools: our });
ok('T2 partial → visibility (cycle fails)', t2.outcome === 'visibility_failure');

// T3 convicted pool → pipeline_rejection w/ wrongful-conviction alternative
const t3 = attribute({ rec: rec(), ourPools: our, convictedPools: new Set(['0xp2']) });
ok('T3 convicted → rejection stage2 + alt', t3.outcome === 'pipeline_rejection' && t3.alternatives.length > 0);

// T4 unknown profit token → stage3 rejection
const t4 = attribute({ rec: rec({ profitToken: '0xZZ' }), ourPools: our, knownTokens: new Set(['0xaa']) });
ok('T4 unpriced-token → stage3', t4.outcome === 'pipeline_rejection' && t4.stage === 3);

// T5 replay: executable + net>floor → confirmed_missed
const t5 = attribute({ rec: rec(), ourPools: our, ourMinProfitUsd: 5, replayed: { executable: true, netUsd: 42 } });
ok('T5 replay net 42 → confirmed_missed', t5.outcome === 'confirmed_missed' && t5.confidence > 0.8);

// T6 replay: net ≤ 0 → not_viable (correctly skipped, NOT a miss)
const t6 = attribute({ rec: rec(), ourPools: our, replayed: { executable: true, netUsd: -3 } });
ok('T6 negative net → not_economically_viable', t6.outcome === 'not_economically_viable' && t6.stage === 6);

// T7 replay: net < floor → not_viable + floor hypothesis alternative
const t7 = attribute({ rec: rec(), ourPools: our, ourMinProfitUsd: 5, replayed: { executable: true, netUsd: 2 } });
ok('T7 net<floor → not_viable', t7.outcome === 'not_economically_viable');

// T8 replay failed → indeterminate (cannot establish counterfactual)
const t8 = attribute({ rec: rec(), ourPools: our, replayed: { executable: false, reason: 'fork state unavailable' } });
ok('T8 replay-fail → indeterminate', t8.outcome === 'indeterminate' && t8.stage === 4);

// T9 no replay + positive est → indeterminate (estimate ≠ proof)
const t9 = attribute({ rec: rec({ econ: { status: 'net_profit_estimated', netUsd: 50, unknowns: [], confidence: 0.8 } }), ourPools: our });
ok('T9 est-only → indeterminate, not missed', t9.outcome === 'indeterminate' && t9.stage === 4);

// T10 no replay + negative est → not_viable (low confidence)
const t10 = attribute({ rec: rec({ econ: { status: 'net_profit_estimated', netUsd: -1, unknowns: [], confidence: 0.5 } }), ourPools: our });
ok('T10 neg est → not_viable', t10.outcome === 'not_economically_viable');

// T11 unverified receipt → indeterminate
const t11 = attribute({ rec: rec({ receiptVerified: false }), ourPools: our });
ok('T11 unverified → indeterminate', t11.outcome === 'indeterminate' && t11.stage === 0);

// T12 unmatched never forced: unknown econ → indeterminate not missed
const t12 = attribute({ rec: rec({ econ: undefined }), ourPools: our });
ok('T12 unknown econ → indeterminate', t12.outcome === 'indeterminate');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
