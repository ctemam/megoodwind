import { ethers } from 'ethers';
import { ChainKey } from '../config/index.js';
import { RpcPool } from './rpcPool.js';
import { multicall } from './multicall.js';
import { logger } from '../config/logger.js';

/**
 * OP-Stack L1 data-fee oracle — the dual-gas layer (Item #1 addendum).
 * Canonical predeploy on every OP-Stack chain (Base 8453, Optimism,
 * Blast, Mode, Zora…):
 *
 *   0x420000000000000000000000000000000000000F
 *
 * L2 tx cost = gasUnits × (l2BaseFee + priorityFee)            [execution]
 *            + getL1Fee(calldata)                              [data availability]
 *
 * Post-Ecotone the L1 fee blends baseFeeScalar × l1BaseFee and
 * blobBaseFeeScalar × blobBaseFee — volatile blob spikes are exactly
 * what this oracle shields against: we never gate profit on L2 fee alone.
 */

export const L1_GAS_ORACLE = '0x420000000000000000000000000000000000000F';

/** OP-Stack chains in our matrix — only these carry the predeploy. */
export const OP_STACK: ReadonlySet<string> = new Set(['base', 'op', 'blast']);

export const isOpStack = (chain: ChainKey | string): boolean => OP_STACK.has(chain);

const ORACLE_ABI = new ethers.Interface([
  'function getL1Fee(bytes data) view returns (uint256)',
  'function l1BaseFee() view returns (uint256)',
  'function blobBaseFee() view returns (uint256)',
  'function baseFeeScalar() view returns (uint32)',
  'function blobBaseFeeScalar() view returns (uint32)',
  'function decimals() view returns (uint256)',
]);

export interface L1Scalars {
  l1BaseFeeWei: bigint;
  blobBaseFeeWei: bigint;
  baseFeeScalar: number;
  blobBaseFeeScalar: number;
  at: number;
}

/** Live L1 fee scalars — ONE aggregate3 call for the whole panel. */
export async function l1FeeScalars(rpc: RpcPool): Promise<L1Scalars | null> {
  const calls = ['l1BaseFee', 'blobBaseFee', 'baseFeeScalar', 'blobBaseFeeScalar']
    .map((fn) => ({ to: L1_GAS_ORACLE, data: ORACLE_ABI.encodeFunctionData(fn) }));
  const res = await multicall(rpc, calls);
  if (res.some((r) => r === '0x')) return null;
  try {
    return {
      l1BaseFeeWei: BigInt(ORACLE_ABI.decodeFunctionResult('l1BaseFee', res[0])[0]),
      blobBaseFeeWei: BigInt(ORACLE_ABI.decodeFunctionResult('blobBaseFee', res[1])[0]),
      baseFeeScalar: Number(ORACLE_ABI.decodeFunctionResult('baseFeeScalar', res[2])[0]),
      blobBaseFeeScalar: Number(ORACLE_ABI.decodeFunctionResult('blobBaseFeeScalar', res[3])[0]),
      at: Date.now(),
    };
  } catch (e) {
    logger('l1fee').debug('scalar decode failed', e);
    return null;
  }
}

/**
 * L1 data fee for a candidate's calldata footprint.
 * `calldataLen` = signed tx payload bytes; we assume worst-case all-
 * nonzero bytes (4× zero-byte pricing) so the barrier is conservative.
 * Returns 0n for non-OP chains or oracle failure (never blocks the path
 * on a transport fault — the profit floor still governs).
 */
export async function l1DataFeeWei(rpc: RpcPool, calldataLen: number): Promise<bigint> {
  if (!isOpStack(rpc.chain.key) || calldataLen <= 0) return 0n;
  const data = ORACLE_ABI.encodeFunctionData('getL1Fee', [`0x${'ff'.repeat(calldataLen)}`]);
  try {
    const raw = await rpc.callContract(L1_GAS_ORACLE, data);
    return BigInt(ORACLE_ABI.decodeFunctionResult('getL1Fee', raw)[0]);
  } catch (e) {
    logger('l1fee').debug(`${rpc.chain.key}: getL1Fee failed`, e);
    return 0n;
  }
}
