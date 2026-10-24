/** WO-14 — stage-loss funnel from persisted store. Run: npx tsx scripts/ci_diagnostics.ts <chain> */
import { CiStore } from '../src/ci/store.js';
import { computeFunnel, stageRates } from '../src/ci/diagnostics.js';
import { registry } from '../src/pools/registry.js';
import { chainConfig, ChainKey } from '../src/config/index.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { writeFileSync } from 'fs';
const KEY = (process.argv[2] ?? 'eth') as ChainKey;
try {
  const { Discovery } = await import('../src/discovery/discovery.js');
  await Promise.race([new Discovery(chainConfig(KEY), new RpcPool(chainConfig(KEY))).boot(), new Promise((r) => setTimeout(r, 60_000))]);
} catch {}
const ourPools = new Set(registry.all(KEY).map((p: any) => p.address.toLowerCase()));
const store = new CiStore();
const recs = store.trusted().filter((r) => r.chain === KEY && r.tx.startsWith('0x') && r.kind === 'arb');
const f = computeFunnel(recs, { ourPools, ourMinProfitUsd: 2.5 });
const rates = stageRates(f);
const L: string[] = [`# WO-14 stage-loss funnel — ${KEY}`, `eligible=${f.eligible} unresolved=${f.unresolved} registry=${ourPools.size}`, ''];
L.push('| # | stage | entered | lost | lossRate | top reasons |');
L.push('|---|---|---|---|---|---|');
for (const r of rates)
  L.push(`| ${r.stage} | ${r.name} | ${r.entered} | ${r.lost} | ${r.lossRate !== undefined ? (r.lossRate * 100).toFixed(1) + '%' : 'n/a'} | ${r.topReasons.map(([k, n]) => `${k.split(':')[0]}×${n}`).join('; ') || '—'} |`);
const out = L.join('\n');
writeFileSync(`docs/ci_funnel_${KEY}.md`, out);
console.log(out);
