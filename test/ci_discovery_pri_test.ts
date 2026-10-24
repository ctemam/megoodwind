/** COMPTOOL→discovery consumer tests — causal proof. Run: npx tsx test/ci_discovery_pri_test.ts */
import { discoveryPriority } from '../src/ci/discoveryPriority.js';
import { CiStore } from '../src/ci/store.js';
import { writeFileSync, rmSync, existsSync } from 'fs';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const F = 'data/ci/store.json';
const orig = existsSync(F) ? JSON.parse((await import('fs')).readFileSync(F, 'utf8')) : null;

const rec = (tx: string, pool: string, outcome: string): any => ({
  eventId: `eth:${tx}`, schema: 'ci-v3', chain: 'eth', kind: 'arb', tx, receiptVerified: true,
  pools: [pool], signer: '0xSIGNER', entityClass: 'verified_active_eoa_signer',
  attribution: { outcome }, evidence: [], corrections: [], econ: { status: 'net_profit_estimated', netUsd: 1, unknowns: [], confidence: 0.8 },
});
const write = (recs: any[]) => writeFileSync(F, JSON.stringify({ records: Object.fromEntries(recs.map((r) => [r.eventId, r])), counters: {}, classHistory: {} }));

// T1 visibility_failure records → priority pools produced
write([rec('0xA', '0xPOOL1', 'visibility_failure'), rec('0xB', '0xPOOL2', 'visibility_failure')]);
const p1 = discoveryPriority(new CiStore(), 'eth');
ok('T1 vis-fail → priority pools', p1.priorityPools.length === 2 && p1.verdict === 'evidence');

// T2 causal: MORE failing pools → MORE priority pools (input changes output)
write([rec('0xA', '0xPOOL1', 'visibility_failure'), rec('0xB', '0xPOOL2', 'visibility_failure'), rec('0xC', '0xPOOL3', 'visibility_failure'), rec('0xD', '0xPOOL4', 'visibility_failure')]);
const p2 = discoveryPriority(new CiStore(), 'eth');
ok('T2 causal: more gaps → more priority', p2.priorityPools.length === 4 && p2.priorityPools.length > p1.priorityPools.length);

// T3 unrelated outcomes do NOT affect priority (lost_to_state, indeterminate ignored)
write([rec('0xA', '0xPOOL1', 'visibility_failure'), rec('0xE', '0xNOISE1', 'lost_to_state'), rec('0xF', '0xNOISE2', 'indeterminate')]);
const p3 = discoveryPriority(new CiStore(), 'eth');
ok('T3 unrelated attrs excluded', p3.priorityPools.length === 1 && p3.priorityPools[0] === '0xPOOL1');

// T4 non-verified records excluded
write([{ ...rec('0xA', '0xPOOL1', 'visibility_failure'), receiptVerified: false }]);
ok('T4 unverified excluded', discoveryPriority(new CiStore(), 'eth').priorityPools.length === 0);

// T5 empty store → fallback_empty not silent-zero-without-reason
write([]);
const p5 = discoveryPriority(new CiStore(), 'eth');
ok('T5 empty → fallback_empty', p5.verdict === 'fallback_empty' && p5.sourceRecords === 0);

// T6 profitToken feeds priorityTokens
write([{ ...rec('0xA', '0xPOOL1', 'visibility_failure'), profitToken: '0xUSDC' }]);
ok('T6 token priority', discoveryPriority(new CiStore(), 'eth').priorityTokens.includes('0xUSDC'));

if (orig) writeFileSync(F, JSON.stringify(orig)); else rmSync(F, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
