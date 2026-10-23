/** WO-7S step 5b — replay the base probe_pass candidate at detection
 *  block + {0,1,2,5,10}. Read-only eth_call at pinned blockTags.
 *  Path: 0x21594b99… (aerodrome V1 v2) > 0x9c087e… (UniV3 fee=500),
 *  pair 0x0b3e3284../WETH, borrow 0.3559 units. Both directions tried. */
import { ethers } from 'ethers';
import { cfg, chainConfig } from '../../src/config/index.js';
import { poolFor } from '../../src/providers/rpcPool.js';
import { v2AmountOut } from '../../src/math/univ2.js';
import { inputVirtualReserveRaw } from '../../src/math/profit.js';
import { routeGasUnits } from '../../src/exec/gasModel.js';
import { l1DataFeeWei, isOpStack } from '../../src/providers/l1Fee.js';

const P0 = '0x21594b992f68495dd28d605834b58889d0a727c7';
const P1 = '0x9c087eb773291e50cf6c6a90ef0f4500e349b903';
const BORROW = 355939609935191488n;
const DETECT_TS = Date.parse('2026-10-23T08:36:40.007Z') / 1000;
const FLOOR_USD = 2.5;
const FEE_P0 = 30; // aerodrome V1 volatile 0.3% (getPool volatile slot)
const FEE_P1 = 5;  // UniV3 fee=500 -> 5bps (verified on-chain)

const chain = chainConfig('base');
const rpc = poolFor(chain);
const V2 = new ethers.Interface(['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)', 'function token1() view returns (address)']);
const V3 = new ethers.Interface(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns (uint128)']);
const ERC = new ethers.Interface(['function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
const H = (n: number) => '0x' + n.toString(16);

interface M { pool: string; t0: string; t1: string; dec0: number; dec1: number; kind: 'v2' | 'v3'; feeBps: number }
async function meta(pool: string, feeBps: number): Promise<M> {
  const t0 = `0x${(await rpc.callContract(pool, V2.encodeFunctionData('token0'), 'latest')).slice(-40)}`;
  const t1 = `0x${(await rpc.callContract(pool, V2.encodeFunctionData('token1'), 'latest')).slice(-40)}`;
  const dec0 = Number(BigInt(await rpc.callContract(t0, ERC.encodeFunctionData('decimals'), 'latest')));
  const dec1 = Number(BigInt(await rpc.callContract(t1, ERC.encodeFunctionData('decimals'), 'latest')));
  const r = await rpc.callContract(pool, V2.encodeFunctionData('getReserves'), 'latest').catch(() => '0x');
  return { pool, t0, t1, dec0, dec1, kind: r.length < 66 ? 'v3' : 'v2', feeBps };
}

async function legOut(m: M, tokenIn: string, amt: bigint, block: number): Promise<bigint> {
  const zeroForOne = tokenIn.toLowerCase() === m.t0.toLowerCase();
  if (m.kind === 'v2') {
    const raw = await rpc.callContract(m.pool, V2.encodeFunctionData('getReserves'), H(block));
    const [r0, r1] = V2.decodeFunctionResult('getReserves', raw) as unknown as [bigint, bigint];
    return v2AmountOut(amt, { reserveIn: zeroForOne ? r0 : r1, reserveOut: zeroForOne ? r1 : r0 }, m.feeBps);
  }
  const [sRaw, lRaw] = await Promise.all([
    rpc.callContract(m.pool, V3.encodeFunctionData('slot0'), H(block)),
    rpc.callContract(m.pool, V3.encodeFunctionData('liquidity'), H(block)),
  ]);
  const [sqrtP] = V3.decodeFunctionResult('slot0', sRaw) as unknown as [bigint];
  const [liq] = V3.decodeFunctionResult('liquidity', lRaw) as unknown as [bigint];
  const fake = { kind: 'v3', token0: m.t0, sqrtPriceX96: sqrtP, liquidity: liq };
  const vIn = inputVirtualReserveRaw(fake, tokenIn);
  const vOut = inputVirtualReserveRaw(fake, zeroForOne ? m.t1 : m.t0);
  return v2AmountOut(amt, { reserveIn: BigInt(Math.floor(vIn)), reserveOut: BigInt(Math.floor(vOut)) }, m.feeBps);
}

async function blockAt(ts: number): Promise<number> {
  let lo = await rpc.blockNumber() - 200_000, hi = await rpc.blockNumber();
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [H(mid), false]);
    if (Number(BigInt(b.timestamp)) < ts) lo = mid; else hi = mid;
  }
  return hi;
}

const m0 = await meta(P0, FEE_P0), m1 = await meta(P1, FEE_P1);
console.log('p0:', JSON.stringify(m0), '\np1:', JSON.stringify(m1));
const B = await blockAt(DETECT_TS);
console.log(`detection block B=${B} ts=${DETECT_TS}\noffset | dir | grossUsd | netUsd | floorPass | raw`);
for (const dir of ['t1->t0->t1', 't0->t1->t0'] as const) {
  const borrowToken = dir === 't1->t0->t1' ? m0.t1 : m0.t0;
  const midToken = dir === 't1->t0->t1' ? m0.t0 : m0.t1;
  const decB = dir === 't1->t0->t1' ? m0.dec1 : m0.dec0;
  const pxB = dir === 't1->t0->t1' ? cfg.NATIVE_USD : NaN; // t1=WETH priced; t0 unpriced
  for (const off of [0, 1, 2, 5, 10]) {
    const b = B + off;
    try {
      const o1 = await legOut(m0, borrowToken, BORROW, b);
      const o2 = await legOut(m1, midToken, o1, b);
      const gross = o2 - BORROW;
      const grossUsd = Number(gross) / 10 ** decB * pxB;
      const blk = await rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', [H(b), false]);
      const prio = await rpc.call<string>('eth_maxPriorityFeePerGas', []).then(BigInt).catch(() => 0n);
      const l1 = isOpStack('base') ? await l1DataFeeWei(rpc, 1_536).catch(() => 0n) : 0n;
      const gasUsd = Number(routeGasUnits([{ pool: { kind: 'v2' } }, { pool: { kind: 'v3' } }]) * (BigInt(blk?.baseFeePerGas ?? 0) + prio) + l1) / 1e18 * cfg.NATIVE_USD;
      const net = grossUsd - gasUsd;
      console.log(`B+${off} | ${dir} | ${Number.isFinite(grossUsd) ? '$' + grossUsd.toFixed(4) : 'raw ' + gross.toString()} | ${Number.isFinite(net) ? '$' + net.toFixed(4) : 'n/a'} | ${net >= FLOOR_USD ? 'y' : 'n'} | o1=${o1} o2=${o2}`);
    } catch (e) { console.log(`B+${off} | ${dir} | ERR ${String(e).slice(0, 90)}`); }
  }
}
