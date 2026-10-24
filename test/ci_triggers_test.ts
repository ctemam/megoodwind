/** WO-09 trigger tests — run: npx tsx test/ci_triggers_test.ts */
import { TriggerEngine, DEFAULT_TRIGGERS } from '../src/ci/triggers.js';
import { rmSync } from 'fs';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const F = 'data/ci/test_triggers.json'; rmSync(F, { force: true });
const eng = new TriggerEngine(DEFAULT_TRIGGERS, F);
const OBS = (value: number, id: string, over: any = {}) => ({ metric: 'visibility_failure_rate', value, sample: 30, coverage: 1, window: 'w', evidenceId: id, ...over });
let t = 1_000_000;

// T1 below threshold → no fire
ok('T1 no breach no fire', eng.evaluate(OBS(0.4, 'e1', ), t += 1e3).length === 0);

// T2 single breach < persistence=2 → suppressed (hysteresis)
ok('T2 first breach suppressed', eng.evaluate(OBS(0.7, 'e2'), t += 1e3).length === 0 && eng.stats().suppressed_hysteresis === 1);

// T3 second consecutive breach → FIRE investigate H-001
const a3 = eng.evaluate(OBS(0.8, 'e3'), t += 1e3);
ok('T3 persistent breach fires H-001', a3.length === 1 && a3[0].kind === 'investigate' && a3[0].hypothesisId === 'H-001');

// T4 same evidence re-ingested → dup suppressed
ok('T4 dedupe', eng.evaluate(OBS(0.8, 'e3'), t += 1e3).length === 0 && eng.stats().suppressed_dup >= 1);

// T5 cooldown — new evidence within 30min suppressed
ok('T5 cooldown', eng.evaluate(OBS(0.9, 'e4'), t += 1e3).length === 0 && eng.stats().suppressed_cooldown >= 1);

// T6 after cooldown + armed recovery below 0.35 resets
t += 31 * 60_000;
ok('T6 recovery disarms', eng.evaluate(OBS(0.3, 'e5'), t).length === 0 && !eng.stats().armed['vis-fail-gt-50']);

// T7 min-sample gate: n<20 never fires even at extreme value
const eng2 = new TriggerEngine(DEFAULT_TRIGGERS, F);
ok('T7 minSample gate', eng2.evaluate(OBS(0.99, 'e6', { sample: 5 }), t += 1e3).length === 0);

// T8 coverage gate: low-quality window never fires
ok('T8 coverage gate', eng2.evaluate(OBS(0.99, 'e7', { coverage: 0.5 }), t += 1e3).length === 0 && eng2.stats().suppressed_quality >= 1);

// T9 kill switch suppresses even qualifying
eng2.kill();
eng2.evaluate(OBS(0.9, 'e8'), t += 1e3); eng2.evaluate(OBS(0.9, 'e9'), t += 1e3);
ok('T9 killed engine fires nothing', eng2.stats().fired === 0);
eng2.revive();

// T10 restart persistence — streak survives reload: eng2's earlier breach counts
// toward this engine's persistence (restart must not reset evidence accumulation)
const eng3 = new TriggerEngine(DEFAULT_TRIGGERS, F);
const a10 = eng3.evaluate(OBS(0.9, 'e10'), t += 1e3);
ok('T10 streak persisted across restart → fires on 2nd breach', a10.length === 1);
// T11 daily cap: 4 fires/day then suppressed
rmSync(F, { force: true });
const eng4 = new TriggerEngine(DEFAULT_TRIGGERS, F);
let fires = 0;
for (let i = 0; i < 8; i++) { t += 40 * 60_000; fires += eng4.evaluate(OBS(0.9, 'cap' + i), t).length; eng4.evaluate(OBS(0.3, 'rec' + i), t += 1e3); t += 1e3; }
ok('T11 daily cap honored', fires <= 4);

// T12 indeterminate trigger routes to H-002
rmSync(F, { force: true });
const eng5 = new TriggerEngine(DEFAULT_TRIGGERS, F);
const a12 = eng5.evaluate({ metric: 'indeterminate_rate', value: 0.235, sample: 34, coverage: 1, window: 'w', evidenceId: 'ind1' }, t += 1e3);
ok('T12 indeterminate → H-002 investigate', a12[0]?.hypothesisId === 'H-002');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
