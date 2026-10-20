import { ethers } from 'ethers';
import { cfg } from '../config/index.js';
import { RpcPool } from './rpcPool.js';

/**
 * Multicall3 `aggregate3` — collapses N view eth_calls into ONE RPC request
 * through the canonical deployment 0xcA11bde05977b3631167028862bE2a173976CA11
 * (present on all 10 configured chains — verified deployments list).
 *
 * Why: free-tier quotas bind per REQUEST. A 200-call aggregate3 is one
 * HTTP request that executes 200 subcalls on the node — ~200× request-rate
 * reduction on the discovery matrix and the sim refresh path. This is a
 * contract-level aggregation, unaffected by JSON-RPC envelope batch caps
 * (dRPC's 3-item batch limit does not apply).
 *
 * allowFailure=true per subcall — a reverting slot returns (false, 0x)
 * instead of poisoning the chunk, mirroring Promise.allSettled semantics.
 */

export const MULTICALL3 = process.env.MULTICALL3_ADDR
  ?? '0xcA11bde05977b3631167028862bE2a173976CA11';

const MC3_ABI = new ethers.Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] aggregate3Return)',
]);

export interface MCall { to: string; data: string }

/** One aggregate3 request for the whole `calls` array.
 *  Returns returnData per call — '0x' when the subcall failed. */
export async function aggregate3(rpc: RpcPool, calls: MCall[]): Promise<string[]> {
  const encoded = MC3_ABI.encodeFunctionData('aggregate3', [
    calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.data })),
  ]);
  const raw = await rpc.callContract(MULTICALL3, encoded);
  const [results] = MC3_ABI.decodeFunctionResult('aggregate3', raw);
  return (results as { success: boolean; returnData: string }[]).map((r) =>
    r.success ? r.returnData : '0x',
  );
}

/** Chunked aggregate3 — `chunkSize` subcalls per RPC request. Falls back to
 *  individual calls ONLY if the aggregate request itself errors (e.g. the
 *  contract is absent on an exotic chain) so the pipeline never wedges. */
export async function multicall(
  rpc: RpcPool,
  calls: MCall[],
  chunkSize = cfg.DISCOVERY_BATCH_SIZE,
  onFailure?: () => void,
): Promise<string[]> {
  const out = new Array<string>(calls.length).fill('0x');
  for (let i = 0; i < calls.length; i += chunkSize) {
    const chunk = calls.slice(i, i + chunkSize);
    try {
      const res = await aggregate3(rpc, chunk);
      for (let k = 0; k < res.length; k++) out[i + k] = res[k];
    } catch {
      // aggregate path broken (contract missing / payload too large) —
      // degrade to per-call, still parallel-bounded
      const res = await Promise.allSettled(chunk.map((c) => rpc.callContract(c.to, c.data)));
      for (let k = 0; k < res.length; k++) {
        const r = res[k];
        out[i + k] = r.status === 'fulfilled' ? r.value : '0x';
        if (r.status === 'rejected') onFailure?.();
      }
    }
  }
  return out;
}
