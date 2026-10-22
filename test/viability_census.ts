/** WO-6 step 3 — viability census analyzer. Reads data/diag_*.jsonl from
 *  the 30-min DIAG_ONLY run and produces per-chain tables:
 *   - candidates by rejection stage (raw rows + unique paths)
 *   - achievable-gross distribution at slip 15/50/100 + uncapped
 *   - counts clearing K*gas for K in {1.0, 1.5}
 *   - top-5 candidates by netUsd with pool addresses + depth
 *  Usage: npx tsx test/viability_census.ts [dataDir] */
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const dir = process.argv[2] ?? 'data';
const files = readdirSync(dir).filter((f) => f.startsWith('diag_') && f.endsWith('.jsonl'));

type Row = Record<string, any> & { stage: string; chain?: string };
const rows: Row[] = [];
for (const f of files) {
  const stage = f.slice(5, -6);
  for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push({ ...JSON.parse(line), stage }); } catch { /* partial tail */ }
  }
}
console.log(`[census] ${rows.length} diag rows from ${files.length} stage files`);

const chains = [...new Set(rows.map((r) => r.chain).filter(Boolean))] as string[];
const pct = (xs: number[], p: number) => xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null;
const EMIT_STAGES = new Set(['probe_pass', 'below_gas_multiple', 'min_profit_floor', 'no_spread', 'price_impact', 'gap_above_ceiling']);

for (const chain of chains) {
  const cr = rows.filter((r) => r.chain === chain);
  console.log(`\n========== ${chain} ==========`);

  // by stage (raw rows / unique paths)
  const byStage = new Map<string, { rows: number; paths: Set<string> }>();
  for (const r of cr) {
    const e = byStage.get(r.stage) ?? { rows: 0, paths: new Set<string>() };
    e.rows++; e.paths.add(r.path ?? r.pool ?? '');
    byStage.set(r.stage, e);
  }
  console.log('candidates by stage:');
  for (const [s, e] of [...byStage.entries()].sort()) console.log(`  ${s}: ${e.rows} rows / ${e.paths.size} unique paths`);

  // achievable-gross distribution per slip (emit-stage rows only, unique path+borrowToken)
  const seen = new Set<string>();
  const emit = cr.filter((r) => EMIT_STAGES.has(r.stage) && r.achievable && r.achievable.uncapped != null)
    .filter((r) => { const k = `${r.path}|${r.borrowToken}`; if (seen.has(k)) return false; seen.add(k); return true; });
  console.log(`unique emit-stage paths with achievable data: ${emit.length}`);

  for (const key of ['slip15', 'slip50', 'slip100', 'uncapped'] as const) {
    const g = emit.map((r) => r.achievable[key]).filter((x): x is number => typeof x === 'number');
    console.log(`  achievable gross ${key}: n=${g.length} p50=$${pct(g, 0.5)?.toFixed(2)} p90=$${pct(g, 0.9)?.toFixed(2)} max=$${g.length ? Math.max(...g).toFixed(2) : 'n/a'}`);
  }

  // clears K*gas — gasUsd per row is the model gas for that route shape;
  // achievable gross vs K*gas, best-of-slips.
  for (const K of [1.0, 1.5]) {
    const gasRows = emit.filter((r) => typeof r.gasUsd === 'number' && r.gasUsd > 0);
    const clears = (key: string) => gasRows.filter((r) => r.achievable[key] >= K * r.gasUsd).length;
    const best = gasRows.filter((r) => Math.max(r.achievable.slip15 ?? -1, r.achievable.slip50 ?? -1, r.achievable.slip100 ?? -1, r.achievable.uncapped ?? -1) >= K * r.gasUsd).length;
    console.log(`  clears K=${K}*gas: slip15=${clears('slip15')} slip50=${clears('slip50')} slip100=${clears('slip100')} uncapped=${clears('uncapped')} bestAnySlip=${best} (of ${gasRows.length} gas-priced paths)`);
  }

  // top-5 by achievable net (uncapped gross - gas) with addresses+depth
  const top = emit.filter((r) => typeof r.gasUsd === 'number')
    .map((r) => ({ ...r, netAch: (r.achievable.uncapped ?? 0) - r.gasUsd } as Row & { netAch: number }))
    .sort((a, b) => b.netAch - a.netAch).slice(0, 5);
  console.log('  top-5 by achievable net:');
  for (const r of top) console.log(`    net~$${r.netAch.toFixed(2)} gross~$${r.achievable.uncapped.toFixed(2)} gas~$${(r as Row).gasUsd.toFixed(2)} stage=${r.stage} path=${r.path} borrow=${r.borrowAmount}`);
}

// also: emit-stage row distribution of CURRENT-run gross/net (bound-mode economics)
console.log('\n[census] emit-stage rows with gross/net (all rows, incl duplicates):');
for (const chain of chains) {
  const cr = rows.filter((r) => r.chain === chain && typeof r.grossUsd === 'number');
  console.log(`  ${chain}: n=${cr.length} p50gross=$${pct(cr.map((r) => r.grossUsd), 0.5)?.toFixed(2)} p90=$${pct(cr.map((r) => r.grossUsd), 0.9)?.toFixed(2)} max=$${cr.length ? Math.max(...cr.map((r) => r.grossUsd)).toFixed(2) : 'n/a'}`);
}
