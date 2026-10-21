import { ethers } from 'ethers';
import { multicall } from '../providers/multicall.js';
import { RpcPool } from '../providers/rpcPool.js';
import { PoolState, registry } from '../pools/registry.js';
import { SLOT0_ABI } from '../math/univ3.js';
import { logger } from '../config/logger.js';

/**
 * Latency discipline: CPU-eval ALL candidates first, then ONE merged
 * refresh round-trip batching every touched pool, then the submit loop.
 * Never serialize per-item RPC on the hot path.
 */

const V2_ABI = new ethers.Interface([
  'function getReserves() view returns (uint112,uint112,uint32)',
]);

interface RefreshJob {
  key: string;
  pool: PoolState;
  calls: { to: string; data: string }[];
}

export async function refreshPools(rpc: RpcPool, pools: PoolState[]): Promise<void> {
  const jobs: RefreshJob[] = pools.map((p) => {
    const key = `${p.chain}:${p.address.toLowerCase()}`;
    if (p.kind === 'v2') {
      return { key, pool: p, calls: [{ to: p.address, data: V2_ABI.encodeFunctionData('getReserves') }] };
    }
    return {
      key,
      pool: p,
      calls: [
        { to: p.address, data: SLOT0_ABI.encodeFunctionData('slot0') },
        { to: p.address, data: SLOT0_ABI.encodeFunctionData('liquidity') },
      ],
    };
  });

  const flat = jobs.flatMap((j) => j.calls.map((c, i) => ({ j, c, i })));
  // Multicall3 — every touched pool state in ONE aggregate3 request
  // (the single merged round-trip the hot path is allowed).
  const results = await multicall(rpc, flat.map(({ c }) => c));

  let ok = 0, fail = 0;
  flat.forEach(({ j, i }, idx) => {
    const value = results[idx];
    if (typeof value !== 'string' || value === '0x') {
      fail++;
      return;
    }
    try {
      if (j.pool.kind === 'v2') {
        const [r0, r1] = V2_ABI.decodeFunctionResult('getReserves', value);
        registry.updateState(j.key, { reserve0: r0, reserve1: r1 });
      } else if (i === 0) {
        const [sqrtPriceX96, tick] = SLOT0_ABI.decodeFunctionResult('slot0', value);
        registry.updateState(j.key, { sqrtPriceX96, tick: Number(tick) });
      } else {
        const [liq] = SLOT0_ABI.decodeFunctionResult('liquidity', value);
        registry.updateState(j.key, { liquidity: liq });
      }
      ok++;
    } catch (e) {
      fail++;
      logger('refresh').debug(`decode fail ${j.key}`, e);
    }
  });
  logger('refresh').debug(`${rpc.chain.key}: refreshed ${ok} slots, ${fail} failed`);
}

const DECIMALS_ABI = new ethers.Interface(['function decimals() view returns (uint8)']);

/**
 * On-chain decimals authority — DexScreener/feed metadata is untrusted:
 * missing or wrong decimals poison spot prices by powers of ten and
 * convict legitimate pools. ONE aggregate3 call covers every unique
 * token0/token1 across the tracked set; pools whose tokens fail the
 * call keep their existing decimals.
 */
const resolvedDecimals = new Set<string>(); // `${chain}:${token}` — immutable on-chain

export async function resolveTokenDecimals(rpc: RpcPool, pools: PoolState[]): Promise<number> {
  const chainKey = rpc.chain.key;
  const tokens = [...new Set(pools.flatMap((p) => [p.token0.toLowerCase(), p.token1.toLowerCase()]))]
    .filter((t) => !resolvedDecimals.has(`${chainKey}:${t}`));
  if (!tokens.length) return 0;
  const toChecksum = new Map<string, string>();
  for (const p of pools) {
    if (!toChecksum.has(p.token0.toLowerCase())) toChecksum.set(p.token0.toLowerCase(), p.token0);
    if (!toChecksum.has(p.token1.toLowerCase())) toChecksum.set(p.token1.toLowerCase(), p.token1);
  }
  const results = await multicall(rpc, tokens.map((t) => ({
    to: toChecksum.get(t)!, data: DECIMALS_ABI.encodeFunctionData('decimals'),
  })));
  const dec = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const r = results[i];
    if (!r || r === '0x') continue;
    try {
      const d = Number(DECIMALS_ABI.decodeFunctionResult('decimals', r)[0]);
      if (d >= 0 && d <= 255) {
        dec.set(tokens[i], d);
        resolvedDecimals.add(`${chainKey}:${tokens[i]}`);
      }
    } catch { /* decode fail — keep existing */ }
  }
  for (const p of pools) {
    const d0 = dec.get(p.token0.toLowerCase());
    const d1 = dec.get(p.token1.toLowerCase());
    if (d0 === undefined && d1 === undefined) continue;
    registry.updateState(`${rpc.chain.key}:${p.address.toLowerCase()}`, {
      ...(d0 !== undefined ? { dec0: d0 } : {}),
      ...(d1 !== undefined ? { dec1: d1 } : {}),
    });
  }
  logger('refresh').info(`${rpc.chain.key}: decimals resolved on-chain for ${dec.size}/${tokens.length} tokens`);
  return dec.size;
}
