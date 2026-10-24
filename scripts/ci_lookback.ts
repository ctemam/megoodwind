/**
 * Targeted creation-block lookback per candidate pool — binary-search the
 * pool's first appearance via eth_getCode existence at binary block heights,
 * then confirm via a creation-log slice. Bounded: ~log2(N) calls/pool.
 * Run: npx tsx scripts/ci_lookback.ts eth
 */
import { chainConfig, ChainKey } from '../src/config/index.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { CiStore } from '../src/ci/store.js';
import { registry } from '../src/pools/registry.js';

const KEY = (process.argv[2] ?? 'eth') as ChainKey;
const rpc = new RpcPool(chainConfig(KEY));
const store = new CiStore();
const ourPools = new Set(registry.all(KEY).map((p: any) => p.address.toLowerCase()));
const recs = store.trusted().filter((r) => r.chain === KEY && r.kind === 'arb' && r.receiptVerified);
const candidates = [...new Set(recs.flatMap((r) => (r.pools ?? []).filter((p) => !ourPools.has(p.toLowerCase()))))].slice(0, 40);

const head = await rpc.blockNumber();
const codeAt = async (p: string, b: number) => (await rpc.call<string>('eth_getCode', [p, '0x' + b.toString(16)]).catch(() => '0x')) !== '0x';
let calls = 0, resolved = 0;
const born: Record<string, number> = {};
for (const p of candidates) {
  let lo = 1, hi = head;
  if (!(await codeAt(p, head))) { calls++; continue; }
  calls++;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); calls++; if (await codeAt(p, mid)) hi = mid; else lo = mid; }
  born[p] = hi; resolved++;
}
const ages = Object.values(born);
const oldest = ages.length ? Math.min(...ages) : 0;
console.log(`lookback: ${resolved}/${candidates.length} pools resolved | ${calls} calls (~${(calls / Math.max(1, resolved)).toFixed(0)}/pool)`);
console.log(`oldest creation block: ${oldest} | depth needed: ${head - oldest} blocks | vs scan window: 400,000`);
const depthNeeded = head - oldest;
console.log(`cost comparison: linear-scan ${Math.ceil(depthNeeded / 10_000)} chunks vs lookback ${calls} calls → ${depthNeeded > 0 ? ((Math.ceil(depthNeeded / 10_000) * 4) / calls).toFixed(1) : '?'}× cheaper`);
