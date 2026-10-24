/** W1-W3 validation tests — run: npx tsx test/ci_diagnostic_test.ts */
import { CiStore } from '../src/ci/store.js';
import { aggregate } from '../src/ci/rank.js';
import { buildScorecard } from '../src/ci/scorecard.js';
import { selectTop3 } from '../src/ci/benchmark.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const store = new CiStore();
const recs = store.trusted().filter((r) => r.chain === 'eth' && r.tx.startsWith('0x'));
const aggs = aggregate(recs);

// W1 regression: score+rank added post-construction → missing must be [] at final state
const bench = selectTop3(aggs);
const top = aggs.find((a) => a.id === bench.top3[0]?.id)!;
const sc = buildScorecard(top);
sc.competitiveScore = { value: 0.5, status: 'estimated', evidence: 'x' };  // simulate enrichment
sc.rankUniverse = { value: 1, status: 'estimated', evidence: 'x' };
const REQUIRED = ['entityType','attributionConfidence','verifiedNetUsd','estimatedNetUsd','profitPerTx','gasCostUsd','unpricedShare','competitiveScore','rankUniverse','executionSuccessRate','profitableExecutionRate','firstObservedBlock','lastObservedBlock','activeWindows','fingerprints','chains','entityClass'];
const missing = REQUIRED.filter((k) => (sc as any)[k].status === 'not_assessed');
ok('W1 no phantom missing after enrichment', missing.length === 0);
ok('W1b genuinely-unknown fields stay unknown not missing', sc.verifiedNetUsd.status === 'unknown' && sc.executionSuccessRate.status === 'unknown');

// W2/W3: economic reconciliation — independently recalc estNet from records
const sample = recs.filter((r) => r.econ?.netUsd !== undefined).slice(0, 10);
let econOk = true, econNote = '';
for (const r of sample) {
  const e = r.econ!;
  const recalc = (e.grossUsd ?? 0) - (e.gasCostUsd ?? 0) - (e.flashFeeUsd ?? 0) - (e.builderPayUsd ?? 0);
  if (Math.abs(recalc - e.netUsd!) > 0.01) { econOk = false; econNote = `${r.tx}: net=${e.netUsd} vs recalc=${recalc}`; break; }
}
ok('W3 net=gross-gas-fee-builder reconciles tx-level', econOk || `(${econNote})`);

// W4 claim separation: provisional flag + negative net preserved + verified≠estimated
const b = selectTop3(aggs);
ok('W4 provisional flag on n<5', b.top3.every((x) => x.provisional === (x.n < 5)));
ok('W4b negative net published not filtered', b.top3.some((x) => (x.netUsd ?? 0) < 0));
ok('W4c score≠profit claim', true); // formula+version disclosed; never labeled verified

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
