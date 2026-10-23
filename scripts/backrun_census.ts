/** WO-7 step 3 — post-swap dislocation census (read-only, no sends).
 *  v2+v3 coverage: v3 pools enter the peer map via slot0/sqrtPrice so
 *  the market that actually carries eth flow is measured. Optimal-size
 *  gross is computed only for V2<->V2 pairs (constant-product closed
 *  form); any pair touching a v3 leg reports gapBps + null gross.
 *  Coverage counters distinguish "no dislocations" from "no coverage".
 *  Usage: MINUTES=60 npx tsx scripts/backrun_census.ts <chain1,chain2> */
import { ethers } from 'ethers';
import { cfg, chainConfig, activeChainConfigs } from '../src/config/index.js';
import { registry, PoolState } from '../src/pools/registry.js';
import { poolFor } from '../src/providers/rpcPool.js';
import { Discovery } from '../src/discovery/discovery.js';
import { breaker } from '../src/forensics/baitPool.js';
import { v2AmountOut } from '../src/math/univ2.js';
import { v3SpotPrice } from '../src/math/univ3.js';
import { routeGasUnits } from '../src/exec/gasModel.js';
import { isOpStack, l1DataFeeWei } from '../src/providers/l1Fee.js';
import { logger } from '../src/config/logger.js';

const log = logger('backrun');
const MINUTES = Number(process.env.MINUTES ?? 60);
const GAP_FLOOR_BPS = Number(process.env.GAP_BPS ?? 10); // WO-8 step 6: re-run at 1/2/5/10bps
const PERSIST = process.env.PERSIST === '1'; // WO-8 step 5: raw swap rows to disk
import { appendFileSync, mkdirSync } from 'node:fs';
mkdirSync('data', { recursive: true });
const SWAP_V2 = ethers.id('Swap(address,uint256,uint256,uint256,uint256)');
const SWAP_V3 = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const RES_ABI = new ethers.Interface(['function getReserves() view returns (uint112,uint112,uint32)']);
const SLOT0_ABI = new ethers.Interface(['function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)']);

const TOKEN_USD: Record<string, number> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': cfg.NATIVE_USD,
  '0x4200000000000000000000000000000000000006': cfg.NATIVE_USD,
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 1,
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 1,
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 1,
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 1,
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 1,
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 1,
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 1,
};
const pxOf = (t: string) => TOKEN_USD[t.toLowerCase()];

interface Row { chain: string; block: number; txHash: string; pool: string; pair: string; gapBps: number; gross15: number | null; gross50: number | null; gasUsd: number; contested: boolean; v3touched: boolean }
const rows: Row[] = [];
let swapsSeen = 0, swapsOnPeerPools = 0, dislocations = 0, contestedN = 0;

function grossMax(rInP: bigint, rOutP: bigint, rInQ: bigint, rOutQ: bigint, feeBps: number, capIn: bigint): number {
  const g = (x: bigint) => {
    const o1 = v2AmountOut(x, { reserveIn: rInP, reserveOut: rOutP }, feeBps);
    if (o1 <= 0n) return -Infinity;
    const o2 = v2AmountOut(o1, { reserveIn: rInQ, reserveOut: rOutQ }, feeBps);
    return o2 > x ? Number(o2 - x) : -Infinity;
  };
  let lo = 1, hi = Number(capIn);
  const INV = 0.6180339887498949;
  let x1 = hi - (hi - lo) * INV, x2 = lo + (hi - lo) * INV;
  for (let i = 0; i < 50 && hi - lo > 8; i++) {
    if (g(BigInt(Math.floor(x1))) < g(BigInt(Math.floor(x2)))) { lo = x1; x1 = x2; x2 = lo + (hi - lo) * INV; }
    else { hi = x2; x2 = x1; x1 = hi - (hi - lo) * INV; }
  }
  let best = -Infinity;
  for (const s of [lo, x1, x2, hi]) { const gg = g(BigInt(Math.max(1, Math.floor(s)))); if (gg > best) best = gg; }
  return best;
}
const slipCapIn = (vIn: number, kbps: number) => { const b = kbps / 2 / 10_000; return Math.floor(vIn * b / (1 - b)); };

/** price of token1 in token0 units, decimal-normalized */
async function priceOf(rpc: ReturnType<typeof poolFor>, p: PoolState, block: number): Promise<number | null> {
  if (p.kind === 'v2') {
    const raw = await rpc.callContract(p.address, RES_ABI.encodeFunctionData('getReserves'), block).catch(() => '0x');
    if (raw.length < 66) return null;
    const [r0, r1] = RES_ABI.decodeFunctionResult('getReserves', raw) as unknown as [bigint, bigint];
    if (!r0 || !r1) return null;
    return (Number(r1) / 10 ** p.dec1) / (Number(r0) / 10 ** p.dec0);
  }
  const raw = await rpc.callContract(p.address, SLOT0_ABI.encodeFunctionData('slot0'), block).catch(() => '0x');
  if (raw.length < 66) return null;
  const [sqrtP] = SLOT0_ABI.decodeFunctionResult('slot0', raw) as unknown as [bigint];
  if (!sqrtP) return null;
  return v3SpotPrice(sqrtP, p.dec0, p.dec1); // token1 per token0
}

async function v2reserves(rpc: ReturnType<typeof poolFor>, p: PoolState, block: number): Promise<[bigint, bigint] | null> {
  const raw = await rpc.callContract(p.address, RES_ABI.encodeFunctionData('getReserves'), block).catch(() => '0x');
  if (raw.length < 66) return null;
  const [r0, r1] = RES_ABI.decodeFunctionResult('getReserves', raw) as unknown as [bigint, bigint];
  return [r0, r1];
}

async function run(chainKey: string): Promise<void> {
  const chain = chainConfig(chainKey);
  const rpc = poolFor(chain);
  await breaker.load(chain.key);
  const d = new Discovery(chain, rpc);
  await d.boot();
  const pools = registry.all(chain.key).filter((p) => !breaker.isConvicted(chain.key, p.address));
  const byAddr = new Map(pools.map((p) => [p.address.toLowerCase(), p]));
  const peers = new Map<string, PoolState[]>();
  for (const p of pools) {
    const sig = [p.token0, p.token1].map((t) => t.toLowerCase()).sort().join(':');
    if (!peers.has(sig)) peers.set(sig, []);
    peers.get(sig)!.push(p);
  }
  const addrs = pools.map((p) => p.address);
  const v2Groups = [...peers.values()].filter((g) => g.length > 1).length;
  log.info(`${chain.key}: ${pools.length} pools (${pools.filter((p) => p.kind === 'v3').length} v3), ${peers.size} pair groups, ${v2Groups} multi-pool groups`);

  const gasUsd = async (): Promise<number> => {
    const blk = await rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]).catch(() => null);
    const prio = await rpc.call<string>('eth_maxPriorityFeePerGas', []).then(BigInt).catch(() => 0n);
    const l1 = isOpStack(chain.key) ? await l1DataFeeWei(rpc, 1_536).catch(() => 0n) : 0n;
    const base = blk?.baseFeePerGas ? BigInt(blk.baseFeePerGas) : 0n;
    return (Number(routeGasUnits([{ pool: { kind: 'v2' } }, { pool: { kind: 'v2' } }]) * (base + prio) + l1) / 1e18) * cfg.NATIVE_USD;
  };

  const t0 = Date.now();
  let last = await rpc.blockNumber();
  const seen = new Set<string>();
  while (Date.now() - t0 < MINUTES * 60_000) {
    const head = await rpc.blockNumber().catch(() => last);
    if (head <= last) { await new Promise((r) => setTimeout(r, 800)); continue; }
    const gUsd = await gasUsd();
    for (let b = last + 1; b <= head; b++) {
      for (let i = 0; i < addrs.length; i += 40) {
        const batch = addrs.slice(i, i + 40);
        const logs = await rpc.call<{ address: string; blockNumber: string; transactionHash: string; logIndex: string; topics: string[]; data: string }[]>('eth_getLogs', [{ fromBlock: '0x' + b.toString(16), toBlock: '0x' + b.toString(16), address: batch, topics: [[SWAP_V2, SWAP_V3]] }]).catch(() => []);
        if (!logs.length) continue;
        swapsSeen += logs.length;
        for (const l of logs) {
          const id = `${l.transactionHash}:${l.logIndex}`;
          if (seen.has(id)) continue; seen.add(id);
          const p = byAddr.get(l.address.toLowerCase());
          if (!p) continue;
          const sig = [p.token0, p.token1].map((t) => t.toLowerCase()).sort().join(':');
          const peerList = (peers.get(sig) ?? []).filter((q) => q.address !== p.address);
          if (!peerList.length) continue;
          swapsOnPeerPools++;
          const pp = await priceOf(rpc, p, b); // post-swap (block-end) price on P
          if (pp === null) continue;
          let bestGap = 0, bestQ: PoolState | null = null;
          for (const q of peerList.slice(0, 4)) {
            const pq = await priceOf(rpc, q, b - 1); // peer at block-start
            if (pq === null || pq === 0) continue;
            const gap = (pp / pq - 1) * 10_000;
            if (Math.abs(gap) > Math.abs(bestGap)) { bestGap = gap; bestQ = q; }
          }
          if (PERSIST) appendFileSync(`data/swap_rows_${chain.key}.jsonl`, JSON.stringify({ ts: new Date().toISOString(), block: b, tx: l.transactionHash, pool: p.address, pair: `${p.symbol0}/${p.symbol1}`, kind: p.kind, bestPeer: bestQ?.address ?? null, gapBps: bestGap }) + '\n');
          if (!bestQ || Math.abs(bestGap) < GAP_FLOOR_BPS) continue;
          dislocations++;
          const contested = logs.some((o) => o.address.toLowerCase() !== p.address.toLowerCase() && peerList.some((q) => q.address.toLowerCase() === o.address.toLowerCase()) && Number(o.logIndex) > Number(l.logIndex));
          if (contested) contestedN++;
          // optimal-size gross only for v2<->v2 pairs (constant-product closed form)
          let g15: number | null = null, g50: number | null = null;
          if (p.kind === 'v2' && bestQ.kind === 'v2') {
            const pr = await v2reserves(rpc, p, b);
            const qr = await v2reserves(rpc, bestQ, b - 1);
            if (pr && qr) {
              const inIs0 = bestGap < 0;
              const [rInP, rOutP] = inIs0 ? [pr[0], pr[1]] : [pr[1], pr[0]];
              const [rInQ, rOutQ] = inIs0 ? [qr[0], qr[1]] : [qr[1], qr[0]];
              const decIn = inIs0 ? p.dec0 : p.dec1;
              const pxIn = pxOf(inIs0 ? p.token0 : p.token1);
              const vIn = Number(rInP);
              const borrowCapRaw = pxIn ? (cfg.FLASH_BORROW_USD / pxIn) * 10 ** decIn : vIn * 0.02;
              const cap = Math.min(vIn * 0.3, borrowCapRaw);
              const scale = pxIn ? pxIn / 10 ** decIn : 1 / 10 ** decIn;
              g15 = grossMax(rInP, rOutP, rInQ, rOutQ, p.feeBps, BigInt(Math.min(cap, slipCapIn(vIn, 15)))) * scale;
              g50 = grossMax(rInP, rOutP, rInQ, rOutQ, p.feeBps, BigInt(Math.min(cap, slipCapIn(vIn, 50)))) * scale;
            }
          }
          rows.push({ chain: chain.key, block: b, txHash: l.transactionHash, pool: p.address, pair: `${p.symbol0}/${p.symbol1}`, gapBps: bestGap, gross15: g15, gross50: g50, gasUsd: gUsd, contested, v3touched: p.kind === 'v3' || bestQ.kind === 'v3' });
        }
      }
    }
    last = head;
    log.info(`${chain.key}: block ${head} swaps=${swapsSeen} onPeerPools=${swapsOnPeerPools} dislocations=${dislocations} contested=${contestedN} elapsed=${((Date.now() - t0) / 60_000).toFixed(1)}m`);
  }
}

const chains = (process.argv[2] ?? '').split(',').filter(Boolean).length
  ? (process.argv[2] ?? '').split(',').filter(Boolean)
  : activeChainConfigs().map((c) => c.key);
for (const c of chains) await run(c);

const pct = (xs: number[], p: number) => xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null;
console.log('\n========== BACKRUN CENSUS ==========');
console.log(`runtime: ${MINUTES} min | chains: ${chains.join(',')} | swapsSeen=${swapsSeen} onPeerPools=${swapsOnPeerPools}`);
for (const c of chains) {
  const cr = rows.filter((r) => r.chain === c);
  const open = cr.filter((r) => !r.contested);
  console.log(`\n--- ${c}: dislocations=${cr.length} contested=${cr.filter((r) => r.contested).length} (${cr.length ? (cr.filter((r) => r.contested).length / cr.length * 100).toFixed(0) : 0}%) open=${open.length} v3Touched=${cr.filter((r) => r.v3touched).length}`);
  for (const [label, key] of [['slip15', 'gross15'], ['slip50', 'gross50']] as const) {
    const g = open.map((r) => r[key]).filter((x): x is number => x != null);
    console.log(`  open gross ${label}: n=${g.length} p50=$${pct(g, 0.5)?.toFixed(4)} p90=$${pct(g, 0.9)?.toFixed(4)} max=$${g.length ? Math.max(...g).toFixed(4) : 'n/a'}`);
    for (const K of [1.0, 1.5]) console.log(`  clears K=${K}*gas (${label}): ${open.filter((r) => r[key] != null && r[key]! >= K * r.gasUsd).length}`);
  }
  console.log('  top-10 open:');
  for (const r of open.sort((a, b) => (b.gross50 ?? 0) - (a.gross50 ?? 0)).slice(0, 10)) {
    console.log(`    gross=${r.gross50 != null ? '$' + r.gross50.toFixed(4) : 'v3-n/a'} gap=${r.gapBps.toFixed(1)}bps ${r.pair} blk=${r.block} gas=$${r.gasUsd.toFixed(4)} tx=${r.txHash}`);
  }
}
