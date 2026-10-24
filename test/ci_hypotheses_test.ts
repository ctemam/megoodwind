/** WO-08 hypothesis lifecycle tests — run: npx tsx test/ci_hypotheses_test.ts */
import { HypothesisRegister } from '../src/ci/hypotheses.js';
import { ChangeControl } from '../src/ci/changeControl.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const cc = new ChangeControl(new Set(['CMDR-1']));
const reg = new HypothesisRegister(cc);
const mk = (id: string) => reg.register({
  id, description: 'expand pool discovery via additional factory matrices', source: 'WO-07 attribution eth 80blk',
  observed: 'visibility_failure=26/34 verified arbs — pools outside 207-registry', inferred: 'broader discovery recovers coverage',
  confidence: 0.8, family: 'coverage', chains: ['eth'], mechanism: 'more factories→more pools→fewer visibility failures',
  alternatives: ['pools may be bait/stale', 'added pools may not be profitable'], requirements: { protocols: ['extra factories'], cost: 'RPC calls' },
  constraints: ['no manual pool seeding', 'data quality gates preserved'],
  acceptance: { metric: 'visibility_failure_rate', direction: 'lt', threshold: 0.5, minSample: 20 },
  rollback: 'revert factory registry addition',
});

// T1 register → registered
ok('T1 registered', mk('H-001').status === 'registered');

// T2 cannot compare before baseline+result
try { reg.compare('H-001'); fail++; console.log('FAIL T2 compare early'); } catch { pass++; console.log('PASS T2 compare early blocked'); }

// T3 baseline → baselined
reg.setBaseline('H-001', { metric: 'visibility_failure_rate', value: 0.765, window: 'eth 80-blk @mc-v1' });
ok('T3 baselined', reg.get('H-001')!.status === 'baselined');

// T4 result below minSample → rejected
reg.recordResult('H-001', { metric: 'visibility_failure_rate', value: 0.1, n: 3, method: 'shadow' });
ok('T4 n<minSample → rejected', reg.compare('H-001') === 'rejected');

// T5 rejected is terminal (can't re-baseline)
try { reg.setBaseline('H-001', { metric: 'x', value: 0, window: 'x' }); fail++; console.log('FAIL T5'); } catch { pass++; console.log('PASS T5 rejected terminal'); }

// T6 full lifecycle on H-002: pass criteria → accepted
mk('H-002');
reg.setBaseline('H-002', { metric: 'visibility_failure_rate', value: 0.765, window: 'eth 80-blk' });
reg.recordResult('H-002', { metric: 'visibility_failure_rate', value: 0.4, n: 50, method: 'shadow' });
ok('T6 accepted on evidence', reg.compare('H-002') === 'accepted');

// T7 integrate requires accepted + change-control gate (Class B needs approval)
const r7 = reg.integrate('H-002', { target: 'discovery.factories_extended', proposed: true, reason: 'coverage', evidence: 'WO-07', validation: { baseline: 0.765, result: 0.4, method: 'shadow' } });
ok('T7 unapproved Class B denied', r7.decided === 'denied');
ok('T7b still accepted not integrated', reg.get('H-002')!.status === 'accepted');

// T8 approved integration → integrated
const r8 = reg.integrate('H-002', { target: 'discovery.factories_extended', proposed: true, reason: 'coverage', evidence: 'WO-07', validation: { baseline: 0.765, result: 0.4, method: 'shadow' } }, { approved: true });
ok('T8 approved → integrated', r8.decided === 'applied' && reg.get('H-002')!.status === 'integrated');

// T9 Class C target still denied even for accepted hypothesis
mk('H-003'); reg.setBaseline('H-003', { metric: 'x', value: 1, window: 'w' });
reg.recordResult('H-003', { metric: 'x', value: 2, n: 30, method: 'replay' });
// H-003 acceptance is lt 0.5 → rejected; re-register H-004 accepted
mk('H-004'); reg.setBaseline('H-004', { metric: 'x', value: 1, window: 'w' });
reg.recordResult('H-004', { metric: 'x', value: 0.1, n: 30, method: 'replay' });
reg.compare('H-004');
const r9 = reg.integrate('H-004', { target: 'solver.minProfitFloor', proposed: 0.5, reason: 'x', evidence: 'x', validation: { baseline: 1, result: 0.1, method: 'replay' } });
ok('T9 DNA target denied even when accepted', r9.cls === 'C_commander' && r9.decided === 'denied');

// T10 rollback from integrated
reg.rollback('H-002', 'post-integration regression');
ok('T10 rollback works', reg.get('H-002')!.status === 'rolled_back');

// T11 history is auditable
ok('T11 full history', reg.get('H-002')!.history.length >= 5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
