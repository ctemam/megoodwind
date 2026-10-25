import { spreadFor } from '../src/ci/spread.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const q = (v: string, p: number, over: any = {}) => ({ venue: v, price: p, ...over });

ok('T1 equal quotes → 0bps', spreadFor('WETH/USDC', [q('v2', 3000), q('v3', 3000)]).spreadBps === 0);
ok('T2 divergence', Math.abs((spreadFor('WETH/USDC', [q('v2', 3000), q('v3', 3030)]).spreadBps ?? 0) - 100) < 1);
ok('T3 order-independent', spreadFor('p', [q('b', 3030), q('a', 3000)]).spreadBps === spreadFor('p', [q('a', 3000), q('b', 3030)]).spreadBps);
ok('T4 one quote → unavailable', spreadFor('p', [q('a', 3000)]).status === 'unavailable');
ok('T5 stale rejected', spreadFor('p', [q('a', 3000, { ageMs: 99999 }), q('b', 3030, { ageMs: 99999 })]).status === 'stale');
ok('T6 mixed stale → uses fresh only', spreadFor('p', [q('a', 3000), q('b', 4000, { ageMs: 99999 })]).validQuotes === 1);
ok('T7 non-finite rejected', spreadFor('p', [q('a', NaN), q('b', Infinity), q('c', -1)]).validQuotes === 0);
ok('T8 block mismatch → unavailable', spreadFor('p', [q('a', 3000, { block: 1 }), q('b', 3030, { block: 2 })], { block: 1 }).validQuotes === 1);
ok('T9 unavailable≠zero', spreadFor('p', []).spreadBps === undefined);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
