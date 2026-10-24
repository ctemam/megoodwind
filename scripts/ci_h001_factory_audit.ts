/**
 * H-001 circularity fix — can our DISCOVERY MECHANISM find the 109 candidates?
 * Look up each candidate pool's factory() on-chain; compare against the
 * factory registry discovery already queries. Discoverable ≠ added-by-hand.
 */
import { ethers } from 'ethers';
import { chainConfig, ChainKey } from '../src/config/index.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { multicall } from '../src/providers/multicall.js';
import { CiStore } from '../src/ci/store.js';
import { registry } from '../src/pools/registry.js';
import { factoriesFor } from '../src/discovery/factories.js';

const KEY = (process.argv[2] ?? 'eth') as ChainKey;
const rpc = new RpcPool(chainConfig(KEY));
try {
  const { Discovery } = await import('../src/discovery/discovery.js');
  await Promise.race([new Discovery(chainConfig(KEY), rpc).boot(), new Promise((r) => setTimeout(r, 60_000))]);
} catch {}
const baseline = new Set(registry.all(KEY).map((p: any) => p.address.toLowerCase()));
const store = new CiStore();
const recs = store.trusted().filter((r) => r.chain === KEY && r.kind === 'arb' && r.receiptVerified);
const candidates = [...new Set(recs.flatMap((r) => (r.pools ?? []).filter((p) => !baseline.has(p.toLowerCase()))))];

const F = new ethers.Interface(['function factory() view returns (address)']);
const calls = candidates.map((p) => ({ to: p, data: F.encodeFunctionData('factory'), ci: 0 }));
const res = await multicall(rpc, calls, calls.length).catch(() => [] as string[]);
const byFactory = new Map<string, number>();
const noFactory: string[] = [];
for (const [i, p] of candidates.entries()) {
  try { const f = F.decodeFunctionResult('factory', res[i])[0].toLowerCase(); byFactory.set(f, (byFactory.get(f) ?? 0) + 1); }
  catch { noFactory.push(p); }
}
// our registered factories for this chain
const ours = new Set<string>();
try { for (const f of factoriesFor(KEY)) ours.add(f.address.toLowerCase()); } catch {}
console.log(`our registered factories for ${KEY}: ${ours.size}`);
console.log(`candidate pools: ${candidates.length} | unique factories: ${byFactory.size} | no-factory(): ${noFactory.length}`);
const covered = [...byFactory.entries()].filter(([f]) => ours.has(f));
const uncovered = [...byFactory.entries()].filter(([f]) => !ours.has(f));
console.log(`factories WE already query (coverage-defect, not venue-gap):`);
for (const [f, n] of covered) console.log(`  ${f.slice(0, 10)}... ${n} pools`);
console.log(`factories we do NOT query (true venue-gap):`);
for (const [f, n] of uncovered.sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${f.slice(0, 10)}... ${n} pools`);
const discoverable = covered.reduce((a, [, n]) => a + n, 0);
console.log(`HONEST TREATMENT BOUND: ${discoverable}/${candidates.length} candidates discoverable via existing factory coverage → max vis-failure ≈ ${(((83 - discoverable) / 95) * 100).toFixed(1)}%`);

// corrected per-record treatment: baseline + covered-factory candidates only
const coveredPools = new Set<string>();
for (const [i, p] of candidates.entries()) {
  try { const f = F.decodeFunctionResult('factory', res[i])[0].toLowerCase(); if (ours.has(f)) coveredPools.add(p); } catch {}
}
const treat2 = new Set([...baseline, ...coveredPools]);
let vis2 = 0, fully = 0;
for (const r of recs) {
  const missing = (r.pools ?? []).filter((p: string) => !treat2.has(p.toLowerCase()));
  if (missing.length > 0) vis2++; else if ((r.pools ?? []).some((p: string) => !baseline.has(p.toLowerCase()))) fully++;
}
console.log(`CORRECTED treatment (covered-factory pools only): vis_failure=${vis2}/${recs.length} = ${((vis2 / recs.length) * 100).toFixed(1)}% | routes fully recovered=${fully}`);
console.log(`note: "discoverable"=factory queried; actual discovery also needs token pair in token-list universe — upper bound, not guarantee`);
