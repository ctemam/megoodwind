/** WO-8 step 5 — hourly report from persisted diag + shadow-probe rows.
 *  Usage: CHAIN=base npx tsx scripts/shadow_report.ts */
import { readFileSync, readdirSync } from 'node:fs';

const CHAIN = process.env.CHAIN ?? 'base';
const HOUR = 3_600_000;
const stages = ['depth', 'forensic_screen', 'no_spread', 'price_impact', 'gap_above_ceiling', 'below_gas_multiple', 'min_profit_floor', 'probe_pass'];

interface R { ts: string; stage?: string; chain?: string; path?: string; netUsd?: number; probe?: string; rss?: number; heapUsed?: number; uptimeSec?: number }
const rows: R[] = [];
for (const f of readdirSync('data').filter((f) => f.startsWith('diag_') && f.endsWith('.jsonl'))) {
  for (const line of readFileSync(`data/${f}`, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.chain === CHAIN) { r.stage = f.replace('diag_', '').replace('.jsonl', ''); rows.push(r); } } catch { }
  }
}
try {
  for (const line of readFileSync('data/shadow_candidates.jsonl', 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.chain === CHAIN) { r.stage = 'shadow_probe_' + r.probe; rows.push(r); } } catch { }
  }
} catch { }
const mem: R[] = [];
try {
  for (const line of readFileSync('data/mem_telemetry.jsonl', 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { mem.push(JSON.parse(line)); } catch { }
  }
} catch { }
if (!rows.length) { console.log('no rows yet'); process.exit(0); }
const t0 = Math.min(...rows.map((r) => Date.parse(r.ts)));
const hours = Math.ceil((Math.max(...rows.map((r) => Date.parse(r.ts))) - t0) / HOUR) || 1;
const pct = (xs: number[], p: number) => xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null;

console.log(`=== shadow report ${CHAIN} — ${hours}h of data ===\nhour | ` + stages.map((s) => s.slice(0, 6)).join(' | ') + ' | probeP | execP | net p50/p90/max | paths');
for (let h = 0; h < hours; h++) {
  const lo = new Date(t0 + h * HOUR).toISOString(), hi = new Date(t0 + (h + 1) * HOUR).toISOString();
  const w = rows.filter((r) => r.ts >= lo && r.ts < hi);
  const cnt = (s: string) => w.filter((r) => r.stage === s).length;
  const probes = w.filter((r) => r.stage === 'probe_pass');
  const execP = w.filter((r) => r.stage === 'shadow_probe_pass').length;
  const nets = probes.map((r) => r.netUsd ?? 0).filter(Number.isFinite);
  console.log(`+${h}h ${lo.slice(11, 19)} | ${stages.map(cnt).join(' | ')} | ${probes.length} | ${execP} | $${pct(nets, .5)?.toFixed(2) ?? '-'}/$${pct(nets, .9)?.toFixed(2) ?? '-'}/$${nets.length ? Math.max(...nets).toFixed(2) : '-'} | ${new Set(probes.map((r) => r.path)).size}`);
}
const execPasses = rows.filter((r) => r.stage === 'shadow_probe_pass');
console.log(`\nexec-probe passes: ${execPasses.length} | hypothetical total net (each once): $${execPasses.reduce((a, r) => a + (r.netUsd ?? 0), 0).toFixed(2)}`);
const reverts = rows.filter((r) => r.stage === 'shadow_probe_deterministic_revert');
console.log(`exec-probe reverts: ${reverts.length}`);
for (const r of reverts.slice(0, 10)) console.log(`  ${r.ts.slice(11, 19)} ${r.path?.slice(0, 42)} net=$${r.netUsd?.toFixed(3)} :: ${(r as { reason?: string }).reason?.slice(0, 80)}`);
if (mem.length) {
  const last = mem[mem.length - 1], first = mem[0];
  console.log(`\nmem: rss ${(first.rss! / 1e6).toFixed(0)}→${(last.rss! / 1e6).toFixed(0)}MB postGC-heap ${(last.heapUsed! / 1e6).toFixed(0)}MB uptime=${last.uptimeSec}s`);
}
