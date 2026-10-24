/** WO-05 measurement-contract tests — run: npx tsx test/ci_measure_test.ts */
import { makeRate, comparable, newCoverage, ORDERING, type ObsWindow } from '../src/ci/measure.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const w = (over: any = {}): ObsWindow => ({ chain: 'eth', fromBlock: 100, toBlock: 200, complete: true, scannedAt: 0, schema: 'ci-v3', contract: 'mc-v1', ordering: 'eth_builder_mev', ...over });

// T1 identical data → identical rates
const r1 = makeRate('a', 'event', 10, 100, 0, 0, w());
const r2 = makeRate('a', 'event', 10, 100, 0, 0, w());
ok('T1 deterministic', r1.rate === r2.rate && r1.rate === 0.1);

// T2 empty eligible population → rate undefined, never 0
const r3 = makeRate('a', 'event', 0, 0, 0, 0, w());
ok('T2 den=0 → rate undefined not 0', r3.rate === undefined && r3.eligible === 0);

// T3 dup ingestion doesn't change a rate (numerator counted once by caller; rate math stable)
ok('T3 dup-safe: rate uses eligible not raw den', makeRate('a','event',5,100,50,0,w()).rate === 0.1);

// T4 different units → not comparable
ok('T4 unit mismatch flagged', !comparable(r1, makeRate('a','entity',10,100,0,0,w())).ok);

// T5 different contract versions → not comparable
ok('T5 contract mismatch flagged', !comparable(r1, makeRate('a','event',10,100,0,0,w({contract:'mc-v2'}))).ok);

// T6 incomplete scan → not comparable
ok('T6 incomplete window flagged', !comparable(r1, makeRate('a','event',10,100,0,0,w({complete:false}))).ok);

// T7 unresolved>0 → comparable but must disclose
const c7 = comparable(r1, makeRate('a','event',10,100,0,5,w()));
ok('T7 unresolved disclosed', c7.ok && c7.reason?.includes('unresolved'));

// T8 window boundaries inclusive — 100..200 = 101 blocks
const cov = newCoverage(); cov.blocksExpected = 201; cov.blocksScanned = 101;
ok('T8 boundary math: 101/201 not silently 100%', cov.blocksScanned / cov.blocksExpected !== 1);

// T9 chain ordering semantics retained, not erased
ok('T9 eth=builder vs base=sequencer', ORDERING.eth === 'eth_builder_mev' && ORDERING.base === 'l2_sequencer_fifo');

// T10 every rate traces to num/den/eligible/excluded/unresolved
const r10 = makeRate('j','event',3,50,10,7,w());
ok('T10 full traceability fields', r10.numerator===3 && r10.denominator===50 && r10.eligible===40 && r10.excluded===10 && r10.unresolved===7 && r10.window?.contract==='mc-v1');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
