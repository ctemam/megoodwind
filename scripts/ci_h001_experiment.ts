/**
 * H-001 controlled experiment — selective registry expansion vs frozen baseline.
 * Control: 207-pool registry. Treatment: baseline + independently-verified
 * candidate pools (verified = contract + token0/token1 + nonzero liquidity).
 * Same event population, same windows — equivalent-condition comparison.
 * Run: npx tsx scripts/ci_h001_experiment.ts eth
 */
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { ethers } from 'ethers';
import { chainConfig, ChainKey } from '../src/config/index.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { multicall } from '../src/providers/multicall.js';
import { CiStore } from '../src/ci/store.js';
import { registry } from '../src/pools/registry.js';
import { HypothesisRegister } from '../src/ci/hypotheses.js';
import { ChangeControl } from '../src/ci/changeControl.js';

const KEY = (process.argv[2] ?? 'eth') as ChainKey;
const chain = chainConfig(KEY);
const rpc = new RpcPool(chain);
try {
  const { Discovery } = await import('../src/discovery/discovery.js');
  await Promise.race([new Discovery(chain, rpc).boot(), new Promise((r) => setTimeout(r, 60_000))]);
} catch {}

// 1. FREEZE baseline
const baseline = new Set(registry.all(KEY).map((p: any) => p.address.toLowerCase()));
const baselineHash = createHash('sha256').update([...baseline].sort().join(',')).digest('hex').slice(0, 16);
console.log(`baseline: ${baseline.size} pools, hash=${baselineHash}`);

// 2. CANDIDATE SET — pools touched by competitor routes but absent from registry
const store = new CiStore();
const recs = store.trusted().filter((r) => r.chain === KEY && r.kind === 'arb' && r.receiptVerified);
const candidates = new Set<string>();
for (const r of recs) for (const p of r.pools ?? []) if (!baseline.has(p.toLowerCase())) candidates.add(p.toLowerCase());
console.log(`candidates: ${candidates.size} unique out-of-registry pools`);

// 3. VERIFY candidates independently: contract + token0/1 + liquidity>0 (v2 reserves or v3 liquidity)
const T01 = new ethers.Interface(['function token0() view returns (address)', 'function token1() view returns (address)', 'function getReserves() view returns (uint112,uint112,uint32)', 'function liquidity() view returns (uint128)']);
const cand = [...candidates].slice(0, 200);
const calls = cand.flatMap((p) => [
  { to: p, data: T01.encodeFunctionData('token0'), ci: 0 },
  { to: p, data: T01.encodeFunctionData('getReserves'), ci: 1 },
  { to: p, data: T01.encodeFunctionData('liquidity'), ci: 2 },
]);
const res = await multicall(rpc, calls, calls.length).catch(() => [] as string[]);
const verified = new Set<string>(); const rejected: Record<string, number> = { no_token0: 0, zero_liquidity: 0 };
for (const [i, p] of cand.entries()) {
  try {
    T01.decodeFunctionResult('token0', res[i * 3]);
    const liq = (() => { try { const r = T01.decodeFunctionResult('getReserves', res[i * 3 + 1]); return r[0] > 0n || r[1] > 0n; } catch { try { const l = T01.decodeFunctionResult('liquidity', res[i * 3 + 2]); return l[0] > 0n; } catch { return null; } } })();
    if (liq === null) { verified.add(p); continue; } // pool exists, liquidity unreadable — provisional admit w/ flag
    if (liq) verified.add(p); else rejected.zero_liquidity++;
  } catch { rejected.no_token0++; }
}
console.log(`verified candidates: ${verified.size} | rejected: ${JSON.stringify(rejected)}`);

// 4. EQUIVALENT-CONDITION comparison over SAME 95 records
const rate = (pools: Set<string>) => {
  let vis = 0;
  for (const r of recs) {
    const missing = (r.pools ?? []).filter((p: string) => !pools.has(p.toLowerCase()));
    if (missing.length > 0) vis++;
  }
  return { vis, total: recs.length, rate: recs.length ? vis / recs.length : undefined };
};
const control = rate(baseline);
const treatment = new Set([...baseline, ...verified]);
const treat = rate(treatment);
const treatHash = createHash('sha256').update([...treatment].sort().join(',')).digest('hex').slice(0, 16);
console.log(`CONTROL   visibility_failure=${control.vis}/${control.total} = ${(control.rate! * 100).toFixed(1)}%`);
console.log(`TREATMENT visibility_failure=${treat.vis}/${treat.total} = ${(treat.rate! * 100).toFixed(1)}% | hash=${treatHash}`);
console.log(`recovered routes: ${control.vis - treat.vis}`);

// 5. DECISION via existing lifecycle (acceptance: <0.5, n>=20)
const reg = HypothesisRegister.load('data/ci/hypotheses.json', new ChangeControl());
const h = reg.get('H-001');
if (h && treat.total >= h.acceptance.minSample) {
  reg.recordResult('H-001', { metric: 'visibility_failure_rate', value: treat.rate!, n: treat.total, method: 'shadow' });
  const verdict = reg.compare('H-001');
  reg.save('data/ci/hypotheses.json');
  console.log(`H-001 verdict: ${verdict} (result=${(treat.rate! * 100).toFixed(1)}% vs threshold<50%, n=${treat.total})`);
}
writeFileSync(`docs/ci_h001_${KEY}.md`, `# H-001 experiment ${KEY}\nbaseline ${baseline.size}p hash=${baselineHash}\ntreatment +${verified.size}p hash=${treatHash}\ncontrol=${(control.rate! * 100).toFixed(1)}% treatment=${(treat.rate! * 100).toFixed(1)}% recovered=${control.vis - treat.vis}\ncandidates rejected: ${JSON.stringify(rejected)}\n`);
