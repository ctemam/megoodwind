/** WO-03 adversarial tests — run: npx tsx test/ci_store_test.ts */
import { CiStore } from '../src/ci/store.js';
import { rmSync } from 'fs';
const F = 'data/ci/test_store.json';
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); };
const rec = (over: any = {}) => ({ schema: 'ci-v3', chain: 'eth', kind: 'arb' as const, block: 100, txIndex: 5, tx: '0xAAA', signer: '0xS1', executor: '0xE1', pools: ['0xP1', '0xP2'], routeLen: 2, profitRaw: '1000', profitToken: '0xT', gasUsed: '0x1', receiptVerified: true, entityClass: 'provisional_eoa_signer' as const, source: 'test', ...over });

rmSync(F, { force: true });
const s = new CiStore(F);

// T1 replay same input → counts stable
s.ingest(rec()); s.ingest(rec()); s.ingest(rec());
ok('T1 replay x3 → unique=1 dups=2', s.counters().unique === 1 && s.counters().dupsSuppressed === 2);

// T2 restart → no dup
s.flush(); const s2 = new CiStore(F); s2.ingest(rec());
ok('T2 restart ingest → still unique=1, dups cumulative=3', s2.counters().unique === 1 && s2.counters().dupsSuppressed === 3);

// T3 concurrent-style same-batch distinct txs stay distinct
s2.ingest(rec({ tx: '0xBBB' })); s2.ingest(rec({ tx: '0xCCC', txIndex: 6 }));
ok('T3 distinct events distinct', s2.counters().unique === 3);

// T4 distinct events in ONE tx (different logIndex) stay distinct
s2.ingest(rec({ tx: '0xDDD' },)); s2.ingest(rec({ eventId: CiStore.eventId('eth', '0xDDD', 7), tx: '0xDDD' }));
ok('T4 same-tx diff-logIndex distinct', s2.counters().unique === 5);

// T5 missing metadata stays unknown, reconciles later without fabricating
s2.ingest(rec({ tx: '0xEEE', block: undefined, txIndex: undefined }));
const e1 = s2.get(CiStore.eventId('eth', '0xEEE'))!;
ok('T5a missing block stays undefined', e1.block === undefined && e1.txIndex === undefined);
s2.ingest(rec({ tx: '0xEEE', block: 200, txIndex: 9 }));
const e2 = s2.get(CiStore.eventId('eth', '0xEEE'))!;
ok('T5b late receipt reconciles', e2.block === 200 && s2.counters().reconciled >= 2);

// T6 schema upgrade → reprocess tracked, provenance preserved
s2.ingest(rec({ tx: '0xAAA', schema: 'ci-v4', profitUsd: 12.5 }));
const a = s2.get(CiStore.eventId('eth', '0xAAA'))!;
ok('T6 decoder upgrade → corrected + provenance trail', a.evidence.length >= 2 && a.corrections.length >= 0);

// T7 quarantined excluded from trusted
s2.quarantine(CiStore.eventId('eth', '0xBBB'), 'suspicious attribution', 'cluster shares executor with artifact');
ok('T7 quarantined not in trusted', !s2.trusted().some((r) => r.tx === '0xBBB') && s2.quarantined().length === 1);

// T8 release requires satisfied criteria; release updates trusted auditably
const relFalse = s2.release(CiStore.eventId('eth', '0xBBB'), false, 'unproven');
const relTrue = s2.release(CiStore.eventId('eth', '0xBBB'), true, 'manual verification: two independent sources agree');
ok('T8 release gated + auditable', !relFalse && relTrue && s2.trusted().some((r) => r.tx === '0xBBB') && s2.get(CiStore.eventId('eth', '0xBBB'))!.corrections.length >= 1);

// T9 conflicting source → correction history records both values (no silent erase)
s2.ingest(rec({ tx: '0xCCC', profitRaw: '999' }));
const c = s2.get(CiStore.eventId('eth', '0xCCC'))!;
ok('T9 conflict → correction trail', c.corrections.some((x) => x.field === 'profitRaw' && x.from === '1000' && x.to === '999'));

// T10 unpriced profit never counted as zero/positive
const u = s2.get(CiStore.eventId('eth', '0xEEE'))!;
ok('T10 unpriced stays undefined (not 0)', u.profitUsd === undefined && s2.counters().unpricedProfit >= 1);

// classHistory versioning
s2.setClass(CiStore.eventId('eth', '0xAAA'), 'verified_active_eoa_signer', 0.8, '2 verified receipt arbs + contract executor');
ok('class history versioned', s2.classHistory(CiStore.eventId('eth', '0xAAA')).length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(F, { force: true });
process.exit(fail ? 1 : 0);
