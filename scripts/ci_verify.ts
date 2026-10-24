/** COMPTOOL verification — independent reproduction from canonical records. */
import { CiStore } from '../src/ci/store.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

const store = new CiStore();
const recs = store.trusted().filter((r) => r.chain === 'eth' && r.tx.startsWith('0x'));

// independent re-aggregation (not reusing aggregate())
const byEntity = new Map<string, { n: number; priced: number[]; gas: number[]; cls: string[] }>();
for (const r of recs) {
  const id = r.signer ?? 'unknown';
  const e = byEntity.get(id) ?? { n: 0, priced: [], gas: [], cls: [] };
  e.n++; if (r.econ?.netUsd !== undefined) e.priced.push(r.econ.netUsd);
  if (r.econ?.gasUsd !== undefined) e.gas.push(r.econ.gasUsd);
  if (r.entityClass) e.cls.push(r.entityClass);
  byEntity.set(id, e);
}
// independent scoring: net×conf×pricedShare (conf=0.8 default per rank.ts)
const eligible = [...byEntity.entries()].filter(([, e]) => e.n >= 2 && e.priced.length >= 1 && e.cls.every((c) => c !== 'unclassifiable_decode_artifact') && e.cls.every((c) => c.startsWith('verified_active')));
const scored = eligible.map(([id, e]) => ({ id, n: e.n, net: e.priced.reduce((a, b) => a + b, 0), score: e.priced.reduce((a, b) => a + b, 0) * 0.8 * (e.priced.length / e.n) })).sort((a, b) => b.score - a.score);

// funnel reconstruction
const visFail = recs.filter((r) => r.attribution?.outcome === 'visibility_failure' || (r.pools?.length && !r.receiptVerified)).length;
const receiptVerified = recs.filter((r) => r.receiptVerified).length;
const priced = recs.filter((r) => r.econ?.netUsd !== undefined).length;
const unpriced = recs.length - priced;

// econ reconciliation sample
let reconOk = 0, reconFail = 0;
for (const r of recs.filter((x) => x.econ?.netUsd !== undefined)) {
  const e = r.econ!;
  const recalc = (e.grossUsd ?? 0) - (e.gasUsd ?? 0) - (e.flashFeeUsd ?? 0) - (e.builderPayUsd ?? 0);
  Math.abs(recalc - e.netUsd!) < 0.01 ? reconOk++ : reconFail++;
}

console.log(`=== INDEPENDENT REPRODUCTION ===`);
console.log(`records=${recs.length} entities=${byEntity.size} eligible=${eligible.length} scored=${scored.length}`);
console.log(`independent top3: ${scored.slice(0, 3).map((s) => `${s.id.slice(0, 10)}(${s.score.toFixed(3)},n=${s.n},net=${s.net.toFixed(3)})`).join(' | ')}`);
console.log(`econ reconcile: ${reconOk} ok / ${reconFail} fail of ${reconOk + reconFail} priced`);
console.log(`funnel: ${receiptVerified} receipt-verified | ${visFail} vis-fail | ${priced} priced | ${unpriced} unpriced`);
console.log(`hash=${createHash('sha256').update(readFileSync('data/ci/store.json')).digest('hex').slice(0, 12)}`);
