/** WO-12 integrated e2e — Lane A deterministic. Run: npx tsx test/ci_e2e_test.ts */
import { CiStore } from '../src/ci/store.js';
import { attribute } from '../src/ci/attribute.js';
import { TriggerEngine, DEFAULT_TRIGGERS } from '../src/ci/triggers.js';
import { HypothesisRegister } from '../src/ci/hypotheses.js';
import { ChangeControl } from '../src/ci/changeControl.js';
import { rmSync } from 'fs';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const RUN = 'e2e-fixture-001';
const F = 'data/ci/test_e2e.json', TF = 'data/ci/test_e2e_trig.json', HF = 'data/ci/test_e2e_hyp.json';
[F, TF, HF].forEach((f) => rmSync(f, { force: true }));

// --- FIXTURE (synthetic — labeled, never presented as live) ---
const ourPools = new Set(['0xp1', '0xp2', '0xp3']);
const fixture = (i: number, over: any = {}) => ({
  schema: 'ci-v3', chain: 'eth', kind: 'arb' as const, block: 100 + i, txIndex: i,
  tx: `0xFIX${i}`, signer: '0xFAKE', executor: '0xEXEC', pools: over.pools ?? ['0xP1', '0xP2'],
  receiptVerified: true, profitToken: '0xT', profitRaw: '5000000',
  econ: { status: 'net_profit_estimated', netUsd: over.net ?? 10, gasCostUsd: 5, unknowns: [], confidence: 0.8 },
  entityClass: 'verified_active_eoa_signer' as const, source: RUN, ...over,
});

const store = new CiStore(F);
const cc = new ChangeControl(new Set(['CMDR-T']));
const reg = HypothesisRegister.load(HF, cc);
const eng = new TriggerEngine(DEFAULT_TRIGGERS, TF);

// seed hypothesis
reg.register({ id: 'H-T1', description: 'fixture: expand coverage', source: RUN, observed: 'synthetic', confidence: 0.7,
  family: 'coverage', chains: ['eth'], mechanism: 'test', alternatives: [], requirements: {}, constraints: [],
  acceptance: { metric: 'visibility_failure_rate', direction: 'lt', threshold: 0.5, minSample: 20 }, rollback: 'test' });
reg.setBaseline('H-T1', { metric: 'visibility_failure_rate', value: 0.8, window: 'fixture' });

// === T1: trace one observation through the whole chain ===
store.ingest(fixture(1));
const ev = store.trusted()[0];
const attr = attribute({ rec: ev, ourPools });
ok('T1 observe→attribute linked by eventId', attr.eventId === ev.eventId && attr.eventId === 'eth:0xfix1');

// === T2: dup ingest doesn't inflate ===
store.ingest(fixture(1)); store.ingest(fixture(1));
ok('T2 dup suppressed', store.counters().dupsSuppressed === 2 && store.counters().unique === 1);

// === T3: insufficient sample suppresses trigger ===
const attrCounts: Record<string, number> = { visibility_failure: 15 };
let acts = eng.evaluate({ metric: 'visibility_failure_rate', value: 0.75, sample: 15, coverage: 1, window: RUN, evidenceId: 'fx1' });
ok('T3 n<20 suppressed w/ reason', acts.length === 0 && eng.stats().suppressed_minsample === 1);

// === T4: qualifying fixture exercises full trigger→hypothesis path ===
acts = eng.evaluate({ metric: 'visibility_failure_rate', value: 0.8, sample: 30, coverage: 1, window: RUN, evidenceId: 'fx2' }); // breach 1
acts = eng.evaluate({ metric: 'visibility_failure_rate', value: 0.8, sample: 30, coverage: 1, window: RUN, evidenceId: 'fx3' }); // breach 2 → fires
ok('T4 trigger fires → H-001 investigate (fixture def)', acts.some((a) => a.hypothesisId === 'H-001'));

// === T5: hypothesis cannot be accepted w/o baseline+result ===
const h = reg.get('H-T1')!;
ok('T5 accepted only via lifecycle', h.status === 'baselined' && !['accepted', 'integrated'].includes(h.status));

// === T6: protected target denied even when hypothesis qualifies ===
reg.recordResult('H-T1', { metric: 'visibility_failure_rate', value: 0.3, n: 30, method: 'shadow' });
ok('T6a hypothesis accepted on fixture evidence', reg.compare('H-T1') === 'accepted');
const denied = reg.integrate('H-T1', { target: 'solver.minProfitFloor', proposed: 0.1, reason: RUN, evidence: 'fixture', validation: { baseline: 0.8, result: 0.3, method: 'shadow' } });
ok('T6b Class C denied', denied.decided === 'denied' && denied.cls === 'C_commander');

// === T7: eligible proposal (Class B) recorded w/o approval ===
const propB = reg.integrate('H-T1', { target: 'discovery.factories_extended', proposed: true, reason: RUN, evidence: 'fixture', validation: { baseline: 0.8, result: 0.3, method: 'shadow' } });
ok('T7 Class B unapproved → denied/pending, not applied', propB.decided === 'denied');

// === T8: restart idempotency — flush then reload, same inputs, same outcomes ===
store.flush();
const store2 = new CiStore(F);
store2.ingest(fixture(1));
ok('T8 restart dedupe (cumulative 3)', store2.counters().unique === 1 && store2.counters().dupsSuppressed === 3);

// === T9: corrections preserve original + trail ===
store2.ingest(fixture(1, { profitRaw: '9000000' }));
const corrected = store2.get('eth:0xfix1')!;
ok('T9 correction trail preserved', corrected.corrections.length >= 1 && corrected.corrections.some((c) => c.field === 'profitRaw'));

// === T10: unpriced never zero-profit ===
const unpriced = attribute({ rec: { ...ev, econ: { status: 'successful_unpriced', unknowns: ['profit_token_unpriced'], confidence: 0.3 } } as any, ourPools });
ok('T10 unpriced → indeterminate not missed', unpriced.outcome === 'indeterminate');

// === T11: kill switch end-to-end ===
eng.kill();
const k = eng.evaluate({ metric: 'indeterminate_rate', value: 0.9, sample: 30, coverage: 1, window: RUN, evidenceId: 'fxK' });
ok('T11 kill suppresses everything', k.length === 0 && eng.stats().suppressed_killed === 1);
eng.revive();

// === T12: daily cap — fixed timestamps inside one UTC day so the budget can't reset ===
let fires = 0;
const day0 = Date.UTC(2026, 9, 24, 0);
for (let i = 0; i < 6; i++) { const a = eng.evaluate({ metric: 'indeterminate_rate', value: 0.5, sample: 30, coverage: 1, window: RUN, evidenceId: 'cap' + i }, day0 + i * 2 * 3_600_000); fires += a.length; }
ok('T12 daily cap ≤2 for indet def', fires <= 2);

[F, TF, HF].forEach((f) => rmSync(f, { force: true }));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
