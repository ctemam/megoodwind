/**
 * WO-11 — Consolidated CI reporting. One view: window, attribution (with
 * denominators), econ statuses, two rankings, trigger states WITH suppression
 * reasons, hypothesis lifecycle, quality counters. "No qualifying evidence"
 * is always distinguished from "no problem".
 */
import { CiStore } from './store.js';
import { TriggerEngine, DEFAULT_TRIGGERS } from './triggers.js';
import { HypothesisRegister } from './hypotheses.js';
import { ChangeControl } from './changeControl.js';
import { aggregate, rankPerformance, rankThreat } from './rank.js';

export function buildReport(chain = 'eth'): string {
  const store = new CiStore();
  const reg = HypothesisRegister.load('data/ci/hypotheses.json', new ChangeControl());
  const eng = new TriggerEngine(DEFAULT_TRIGGERS);
  const recs = store.trusted().filter((r) => r.chain === chain && r.tx.startsWith('0x'));
  const windows = Object.values((store as any).s?.records ?? {}).filter((r: any) => r.tx?.startsWith('window:')) as any[];
  const ts = eng.stats();
  const L: string[] = [];
  const push = (s = '') => L.push(s);

  push(`# CI report — ${chain} (generated ${new Date().toISOString()})`);
  push(`evidence class: shadow/public-data | store records: ${recs.length} trusted, ${store.quarantined().length} quarantined`);
  push();

  push(`## Coverage (mc-v1 windows)`);
  for (const w of windows.slice(-5))
    push(`- ${w.tx} blocks ${w.block}.. complete=${(w as any).window?.complete ?? '?'} ordering=${(w as any).window?.ordering ?? '?'}`);
  push();

  const cls: Record<string, number> = {};
  for (const r of recs) cls[r.entityClass ?? 'unclassifiable'] = (cls[r.entityClass ?? 'unclassifiable'] ?? 0) + 1;
  push(`## Entity classes (n=${recs.length})`);
  for (const [k, n] of Object.entries(cls)) push(`- ${k}: ${n}`);
  push();

  const econ: Record<string, number> = {};
  for (const r of recs) econ[r.econ?.status ?? 'economics_incomplete'] = (econ[r.econ?.status ?? 'economics_incomplete'] ?? 0) + 1;
  push(`## Economic statuses`);
  for (const [k, n] of Object.entries(econ)) push(`- ${k}: ${n}`);
  push();

  const aggs = aggregate(recs);
  push(`## Performance ranking (verified+econ gated, top 5)`);
  for (const r of rankPerformance(aggs).slice(0, 5))
    push(`- ${r.rank ? '#' + r.rank : 'unranked'} ${r.id.slice(0, 12)} n=${r.sample} net=${r.netUsd?.toFixed(4) ?? 'unpriced'} conf=${r.confidence.toFixed(2)} [${r.flags.join(',')}]`);
  push(`## Threat/capability ranking (observable only, top 5)`);
  for (const r of rankThreat(aggs).slice(0, 5))
    push(`- ${r.rank ? '#' + r.rank : 'unranked'} ${r.id.slice(0, 12)} n=${r.sample} ${r.evidenceClass}`);
  push();

  push(`## Trigger states (armed≠fired; suppressed≠no-problem)`);
  for (const d of DEFAULT_TRIGGERS) {
    const armed = ts.armed[d.id] ? 'ARMED' : 'disarmed';
    push(`- ${d.id} → ${d.hypothesisId ?? 'investigate'} | ${armed} | threshold ${d.direction}${d.threshold} persist=${d.persistence} n≥${d.minSample} cov≥${d.minCoverage}`);
  }
  push(`counters: fired=${ts.fired} dup=${ts.suppressed_dup} cooldown=${ts.suppressed_cooldown} hyst=${ts.suppressed_hysteresis} quality=${ts.suppressed_quality} minsample=${ts.suppressed_minsample} killed=${ts.suppressed_killed}`);
  push(`NOTE: suppressed_minsample/coverage means "insufficient qualifying evidence" — NOT "no problem exists".`);
  push();

  push(`## Hypotheses`);
  for (const h of reg.all())
    push(`- ${h.id} [${h.status}] ${h.description.slice(0, 90)} | baseline ${h.baseline?.metric}=${h.baseline?.value} | accept ${h.acceptance.direction}${h.acceptance.threshold} n≥${h.acceptance.minSample}${h.result ? ` | result ${h.result.metric}=${h.result.value} n=${h.result.n} (${h.result.method})` : ''}`);
  push();

  push(`## Store quality counters`);
  push('```json'); push(JSON.stringify(store.counters(), null, 1)); push('```');
  push(`_All figures shadow/public-data. net=estimated unless trace-verified. Nothing live, nothing armed._`);
  return L.join('\n');
}
