/** Deconstruct harness tests — run: npx tsx test/ci_deconstruct_test.ts */
import { deconstructTx, deconstructEntity } from '../src/ci/deconstruct.js';
import type { CiRecord } from '../src/ci/store.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const rec = (over: any = {}): CiRecord => ({ eventId: 'x', schema: 'ci-v3', chain: 'eth', kind: 'arb', tx: '0x1', block: 26260000, txIndex: 91, pools: ['0xP1', '0xP2'], signer: '0xE', receiptVerified: true, econ: { status: 'net_profit_estimated', netUsd: 0.5, gasCostUsd: 0.1, unknowns: [], confidence: 0.8 }, evidence: [], corrections: [], ...over } as any);

// T1 all 9 stages present, each with explicit status
const rep = deconstructTx(rec());
ok('T1 9 stages all statused', rep.stages.length === 9 && rep.stages.every((s) => ['observed','reconstructed','unavailable','not_applicable'].includes(s.status)));

// T2 private stages honestly unavailable (5 candidate, 6 qualification)
ok('T2 private stages unavailable', rep.stages[4].status === 'unavailable' && rep.stages[5].status === 'unavailable');

// T3 receipt+route observed
ok('T3 receipt+zone observed', rep.stages[1].status === 'observed' && rep.stages[7].status === 'observed');

// T4 replay unavailable unless evidence passed
ok('T4 replay gated', rep.stages[3].status === 'unavailable' && deconstructTx(rec(), { replayOutcome: 'PASS' }).stages[3].status === 'observed');

// T5 no econ → projection+reconciliation unavailable not zero
const noEcon = deconstructTx(rec({ econ: undefined }));
ok('T5 missing econ → unavailable', noEcon.stages[2].status === 'unavailable' && noEcon.stages[8].status === 'unavailable');

// T6 privateHint → hypothesis generated; plain → not
ok('T6 hypothesis from evidence only', deconstructTx(rec({ privateHint: true })).advantageHypotheses.length > 0 && deconstructTx(rec()).advantageHypotheses.length === 0);

// T7 batch coverage counts statuses
const agg = deconstructEntity([rec(), rec({ tx: '0x2' })]);
ok('T7 coverage aggregates', agg.coverage.zone_selection.observed === 2 && agg.coverage.candidate_generation.unavailable === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
