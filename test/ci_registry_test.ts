/** Metric registry tests — run: npx tsx test/ci_registry_test.ts */
import { METRIC_REGISTRY, defFor } from '../src/ci/metricRegistry.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };

// T1 every def has all 12 required fields populated
ok('T1 all defs complete', METRIC_REGISTRY.every((m) => m.id && m.name && m.family && m.priority && m.evidenceReq && m.sources.length && m.collection && m.formula && m.validation && m.dashboardField && m.governance));

// T2 unique ids + dashboard fields
ok('T2 unique ids+fields', new Set(METRIC_REGISTRY.map((m) => m.id)).size === METRIC_REGISTRY.length && new Set(METRIC_REGISTRY.map((m) => m.dashboardField)).size === METRIC_REGISTRY.length);

// T3 every def has ≥1 Tier-1 source (verifiability floor)
ok('T3 tier1 source floor', METRIC_REGISTRY.every((m) => m.sources.some((s) => s.tier === 1)));

// T4 scorecard fields resolvable
const FIELDS = ['verifiedNetUsd', 'estimatedNetUsd', 'gasCostUsd', 'competitiveScore', 'executionSuccessRate', 'profitableExecutionRate', 'firstObservedBlock', 'fingerprints', 'completeness'];
ok('T4 scorecard fields mapped', FIELDS.every((f) => defFor(f)));

// T5 win.exec_success honestly unmeasurable publicly
const w = defFor('executionSuccessRate')!;
ok('T5 exec success → unknowable den', w.formula.includes('unknowable'));

// T6 verified net gated on trace
const v = defFor('verifiedNetUsd')!;
ok('T6 verified requires trace', v.validation.includes('traceVerified'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
