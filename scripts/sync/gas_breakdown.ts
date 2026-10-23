/** WO-7S step 5a — decompose base gasUsd into L2 execution fee vs
 *  OP-Stack L1 data fee, using the same code path the runner uses. */
import { ethers } from 'ethers';
import { cfg, chainConfig } from '../../src/config/index.js';
import { poolFor } from '../../src/providers/rpcPool.js';
import { isOpStack, l1DataFeeWei, l1FeeScalars } from '../../src/providers/l1Fee.js';
import { routeGasUnits } from '../../src/exec/gasModel.js';

const chain = chainConfig('base');
const rpc = poolFor(chain);
const blk = await rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]);
const prio = await rpc.call<string>('eth_maxPriorityFeePerGas', []).then(BigInt).catch(() => cfg.PRIORITY_FEE_GWEI ? BigInt(Math.floor(cfg.PRIORITY_FEE_GWEI * 1e9)) : 0n);
const base = blk?.baseFeePerGas ? BigInt(blk.baseFeePerGas) : 0n;
const units = routeGasUnits([{ pool: { kind: 'v2' } }, { pool: { kind: 'v2' } }]);
const l1 = isOpStack('base') ? await l1DataFeeWei(rpc, 1_536) : 0n;
const scalars = await l1FeeScalars(rpc).catch(() => null);

const l2Wei = units * (base + prio);
const l2Usd = Number(l2Wei) / 1e18 * cfg.NATIVE_USD;
const l1Usd = Number(l1) / 1e18 * cfg.NATIVE_USD;
console.log(JSON.stringify({
  chain: 'base', isOpStack: isOpStack('base'),
  gasUnits: units.toString(), baseFeeGwei: Number(base) / 1e9, prioGwei: Number(prio) / 1e9,
  l2FeeWei: l2Wei.toString(), l2Usd, l1DataFeeWei: l1.toString(), l1Usd,
  totalUsd: l2Usd + l1Usd,
  l1Scalars: scalars && { l1BaseFeeWei: scalars.l1BaseFeeWei.toString(), blobBaseFeeWei: scalars.blobBaseFeeWei.toString(), baseFeeScalar: scalars.baseFeeScalar, blobBaseFeeScalar: scalars.blobBaseFeeScalar },
}, null, 2));
