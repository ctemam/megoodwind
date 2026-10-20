import { ethers } from 'ethers';
import { RpcPool } from '../providers/rpcPool.js';
import { multicall } from '../providers/multicall.js';
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
