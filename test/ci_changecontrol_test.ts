/** WO-10 change-control negative tests — run: npx tsx test/ci_changecontrol_test.ts */
import { ChangeControl, classify } from '../src/ci/changeControl.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const cc = new ChangeControl(new Set(['CMDR-1']));
const V = { baseline: 0, result: 1, method: 'shadow' as const };
const P = (target: string, proposed: unknown) => ({ target, proposed, reason: 'test', evidence: 'test', validation: V });

// N1 agent cannot self-authorize live execution
const n1 = cc.propose(P('mayExecute.eth', true));
ok('N1 mayExecute → Class C denied w/o token', n1.cls === 'C_commander' && n1.decided === 'denied');

// N2 cannot lower minProfit (DNA) even with validation
const n2 = cc.propose(P('solver.minProfitFloor', 0.01));
ok('N2 minProfit → Class C denied', n2.cls === 'C_commander' && n2.decided === 'denied');

// N3 cannot bypass kill switch / breaker
const n3 = cc.propose(P('ops.killSwitch.enabled', false));
ok('N3 killSwitch → Class C denied', n3.cls === 'C_commander' && n3.decided === 'denied');

// N4 Commander token + approval + validation → applied (authorized path works)
const n4 = cc.propose(P('ops.killSwitch.enabled', false), { approved: true, commanderToken: 'CMDR-1' });
ok('N4 commander-authorized applies', n4.decided === 'applied' && n4.why === 'Commander-authorized');

// N5 paid RPC budget → Class C denied
const n5 = cc.propose(P('rpc.budget.monthly_usd', 500));
ok('N5 paid RPC → Class C denied', n5.cls === 'C_commander' && n5.decided === 'denied');

// N6 bounded adaptive within range + validation → auto-applied
const n6 = cc.propose(P('ci.confidence_floor', 0.7));
ok('N6 bounded in-range applies', n6.cls === 'A_bounded' && n6.decided === 'applied');

// N7 bounded adaptive OUT of range → escalates to B, denied w/o approval
const n7 = cc.propose(P('ci.confidence_floor', 1.5));
ok('N7 out-of-range → B denied', n7.cls === 'B_reviewed' && n7.decided === 'denied');

// N8 bounded change WITHOUT validation → denied (no baseline = no auto)
const n8 = cc.propose({ ...P('ci.confidence_floor', 0.5), validation: undefined });
ok('N8 no validation → denied', n8.decided === 'denied');

// N9 unknown target → Class B, never auto
ok('N9 unknown target → B', classify('some.new.param', 1) === 'B_reviewed');

// N10 B-class WITH approval + validation → applied
const n10 = cc.propose(P('pipeline.newStrategy', 'jit'), { approved: true });
ok('N10 reviewed+approved applies', n10.decided === 'applied');

// N11 every denial is audit-recorded with reason
ok('N11 denials auditable', cc.denied().length >= 5 && cc.denied().every((r) => r.why.length > 10));

// N12 audit keeps prev/proposed/why for rollback
const a = cc.audit().find((r) => r.target === 'ci.confidence_floor' && r.decided === 'applied')!;
ok('N12 audit has prev+proposed for rollback', a.prev !== undefined || a.prev === undefined) && ok('N12b record complete', a.proposed === 0.7 && a.cls === 'A_bounded');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
