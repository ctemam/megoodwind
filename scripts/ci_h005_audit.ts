/** H-005 — root-cause classify the 88 covered-factory candidates.
 * For each: fetch token0/token1 → check membership in our token-list universe.
 * Categories: token_missing | pair_not_in_feed_and_outside_top12 | unresolved.
 */
import { ethers } from 'ethers';
import { chainConfig, ChainKey } from '../src/config/index.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { multicall } from '../src/providers/multicall.js';
import { CiStore } from '../src/ci/store.js';
import { registry } from '../src/pools/registry.js';
import { factoriesFor } from '../src/discovery/factories.js';
import { tokensForChain } from '../src/discovery/tokenLists.js';

const KEY = (process.argv[2] ?? 'eth') as ChainKey;
const chain = chainConfig(KEY);
const rpc = new RpcPool(chain);
const tokensArr = await tokensForChain(chain, rpc);
const tokenUniverse = new Set(tokensArr.map((t) => t.address.toLowerCase()));
console.log(`token universe: ${tokenUniverse.size}`);

try { const { Discovery } = await import('../src/discovery/discovery.js'); await Promise.race([new Discovery(chain, rpc).boot(), new Promise((r) => setTimeout(r, 60_000))]); } catch {}
const baseline = new Set(registry.all(KEY).map((p: any) => p.address.toLowerCase()));
const store = new CiStore();
const recs = store.trusted().filter((r) => r.chain === KEY && r.kind === 'arb' && r.receiptVerified);
const candidates = [...new Set(recs.flatMap((r) => (r.pools ?? []).filter((p) => !baseline.has(p.toLowerCase()))))];
const ours = new Set(factoriesFor(KEY).map((f) => f.address.toLowerCase()));

const F = new ethers.Interface(['function factory() view returns (address)', 'function token0() view returns (address)', 'function token1() view returns (address)']);
const calls = candidates.flatMap((p) => [
  { to: p, data: F.encodeFunctionData('factory'), ci: 0 },
  { to: p, data: F.encodeFunctionData('token0'), ci: 1 },
  { to: p, data: F.encodeFunctionData('token1'), ci: 2 },
]);
const res = await multicall(rpc, calls, calls.length).catch(() => [] as string[]);
const cats: Record<string, number> = { covered_token_missing: 0, covered_pair_not_enumerated: 0, venue_gap: 0, unresolved: 0 };
const missingTokens = new Map<string, number>();
for (const [i, p] of candidates.entries()) {
  try {
    const f = F.decodeFunctionResult('factory', res[i * 3])[0].toLowerCase();
    const t0 = F.decodeFunctionResult('token0', res[i * 3 + 1])[0].toLowerCase();
    const t1 = F.decodeFunctionResult('token1', res[i * 3 + 2])[0].toLowerCase();
    if (!ours.has(f)) { cats.venue_gap++; continue; }
    const t0In = tokenUniverse.has(t0), t1In = tokenUniverse.has(t1);
    if (!t0In || !t1In) { cats.covered_token_missing++; if (!t0In) missingTokens.set(t0, (missingTokens.get(t0) ?? 0) + 1); if (!t1In) missingTokens.set(t1, (missingTokens.get(t1) ?? 0) + 1); }
    else cats.covered_pair_not_enumerated++; // both tokens known → matrix/feed missed the pair
  } catch { cats.unresolved++; }
}
console.log(`root causes (109 candidates): ${Object.entries(cats).map(([k, n]) => `${k}=${n}`).join(' | ')}`);
console.log(`missing tokens (top10): ${[...missingTokens.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([t,n])=>`${t.slice(0,10)}×${n}`).join(', ')}`);
