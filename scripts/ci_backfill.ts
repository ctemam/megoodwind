/**
 * Historical factory-event backfill (SHADOW) — scans PoolCreated/PairCreated
 * over registered factories, populates the token registry, reconciles against
 * the 88 covered-factory H-005 candidates. Measures recovery + RPC cost.
 * Run: npx tsx scripts/ci_backfill.ts eth <maxBlocksBack>
 */
import { ethers } from 'ethers';
import { chainConfig, ChainKey } from '../src/config/index.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { multicall } from '../src/providers/multicall.js';
import { CiStore } from '../src/ci/store.js';
import { registry } from '../src/pools/registry.js';
import { factoriesFor } from '../src/discovery/factories.js';
import { TokenRegistry, CORE_TOKENS } from '../src/ci/tokenRegistry.js';

const KEY = (process.argv[2] ?? 'eth') as ChainKey;
const BACK = Number(process.argv[3] ?? 400_000); // ~2 months eth
const chain = chainConfig(KEY);
const rpc = new RpcPool(chain);

// seed core tokens
const treg = new TokenRegistry();
for (const t of CORE_TOKENS[KEY] ?? []) treg.upsert({ chain: KEY, address: t.addr.toLowerCase(), symbol: t.symbol, tier: 'A_core', provenance: 'core_seed', verified: true });

const PC_V3 = ethers.id('PoolCreated(address,address,uint24,int24,address)');
const PC_V2 = ethers.id('PairCreated(address,address,address,uint256)');
const factories = factoriesFor(KEY);
const head = await rpc.blockNumber();
const from = Math.max(head - BACK, 10_000_000); // UniV2 deployment floor — earlier blocks empty
console.log(`backfill: ${factories.length} factories, blocks ${from}-${head} (${BACK} blk)`);

// load H-005 candidate set for reconciliation
const store = new CiStore();
const recs = store.trusted().filter((r) => r.chain === KEY && r.kind === 'arb' && r.receiptVerified);
const ourPools = new Set(registry.all(KEY).map((p: any) => p.address.toLowerCase()));
const candidates = new Set(recs.flatMap((r) => (r.pools ?? []).filter((p) => !ourPools.has(p.toLowerCase()))));

// scan creation logs in bounded chunks — PROTECTED resumable checkpoint (Phase 1B)
const { saveCheckpoint, loadCheckpoint } = await import('../src/ci/checkpoint.js');
const CKPT = `data/ci/backfill_${KEY}.json`;
let startFrom = from;
const found = new Map<string, { t0: string; t1: string; block: number; factory: string }>();
const prev = loadCheckpoint<{ t0: string; t1: string; block: number; factory: string }>(CKPT);
if (prev.ok) {
  startFrom = prev.nextBlock;
  for (const [k, v] of Object.entries(prev.records)) found.set(k, v);
  console.log(`resuming from block ${startFrom} with ${found.size} pools (source=${prev.source}${prev.reason ? ', ' + prev.reason : ''})`);
} else if (prev.reason && prev.source !== 'none') console.log(`checkpoint rejected: ${prev.reason} — starting fresh`);
let rpcCalls = 0, chunks = 0, failed = 0;
const CHUNK = 10_000;
for (let b = startFrom; b < head && found.size < 200_000; b += CHUNK) {
  const end = Math.min(b + CHUNK - 1, head);
  for (const f of factories) {
    rpcCalls++;
    const logs = await rpc.call<ethers.Log[]>('eth_getLogs', [{ address: f.address, topics: [[PC_V3, PC_V2]], fromBlock: '0x' + b.toString(16), toBlock: '0x' + end.toString(16) }]).catch(() => { failed++; return null; });
    if (!logs) continue;
    for (const l of logs as ethers.Log[]) {
      const isV3 = l.topics[0] === PC_V3;
      const t0 = '0x' + l.topics[1].slice(-40), t1 = '0x' + l.topics[2].slice(-40);
      // V3: pool = last word of data; V2: pair = first word of data (non-indexed)
      const pool = isV3 ? '0x' + l.data.slice(-40) : '0x' + l.data.slice(26, 66);
      found.set(pool.toLowerCase(), { t0: t0.toLowerCase(), t1: t1.toLowerCase(), block: Number(l.blockNumber), factory: f.address.toLowerCase() });
    }
  }
  chunks++;
  if (chunks % 20 === 0) { saveCheckpoint(CKPT, 'bf-v1', b + CHUNK, Object.fromEntries(found)); console.log(`  ckpt @${b + CHUNK} pools=${found.size}`); }
}
console.log(`scanned ${chunks} chunks | ${rpcCalls} rpc calls | ${failed} failed | ${found.size} pools discovered from creation logs`);

// populate token registry from discovered pools' tokens
let newTokens = 0;
for (const [, p] of found) {
  for (const t of [p.t0, p.t1]) if (!treg.has(KEY, t)) { treg.upsert({ chain: KEY, address: t, tier: 'C_longtail', provenance: 'factory_event', firstSeenBlock: p.block, verified: false }); newTokens++; }
}
treg.flush();

// reconcile vs the 88 candidates
const recovered = [...candidates].filter((p) => found.has(p));
const recoveredRate = candidates.size ? recovered.length / candidates.size : 0;
let visRecovered = 0;
for (const r of recs) {
  const missing = (r.pools ?? []).filter((p) => !ourPools.has(p.toLowerCase()));
  if (missing.length && missing.every((p) => found.has(p.toLowerCase()))) visRecovered++;
}
console.log(`token registry: +${newTokens} tokens (${treg.size()} total) | tiers: ${JSON.stringify(treg.counts(KEY))}`);
console.log(`RECOVERY: ${recovered.length}/${candidates.size} candidates in window (${(recoveredRate * 100).toFixed(1)}%) | routes fully recovered: ${visRecovered}`);
console.log(`bounded window caveat: pools created before block ${from} invisible to this scan depth`);
