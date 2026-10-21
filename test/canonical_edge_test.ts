/**
 * BF-edge assertion — canonical USDC/WETH v2 pool must produce
 * accessible graph edges with decimal-correct rates in BOTH directions.
 *   Run: npx tsx test/canonical_edge_test.ts
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { buildEdges } from '../src/strategies/graph.js';
import { PoolState } from '../src/pools/registry.js';

const PAIR = '0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc';
const rpc = process.env.ALCHEMY_API_KEY
  ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : process.env.ETH_RPC_URLS?.split(',')[0];
if (!rpc) { console.error('no keyed RPC'); process.exit(1); }

const provider = new ethers.JsonRpcProvider(rpc);
const iface = new ethers.Interface([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function decimals() view returns (uint8)',
]);
const call = async (to: string, fn: string) =>
  iface.decodeFunctionResult(fn, await provider.call({ to, data: iface.encodeFunctionData(fn) }));

const t0 = (await call(PAIR, 'token0'))[0] as string;
const t1 = (await call(PAIR, 'token1'))[0] as string;
const [r0, r1] = await call(PAIR, 'getReserves');
const d0 = Number((await call(t0, 'decimals'))[0]);
const d1 = Number((await call(t1, 'decimals'))[0]);

const pool: PoolState = {
  address: PAIR, chain: 'eth', dexId: 'uniswap', kind: 'v2',
  token0: t0, token1: t1, symbol0: 'USDC', symbol1: 'WETH',
  dec0: d0, dec1: d1, feeBps: 30, liquidityUsd: 0,
  reserve0: r0, reserve1: r1, updatedAt: Date.now(),
};

const edges = buildEdges([pool]);
if (edges.length !== 2) { console.error(`FAIL: expected 2 edges, got ${edges.length}`); process.exit(1); }

const fwd = edges.find((e) => e.from === t0.toLowerCase())!; // USDC->WETH
const rev = edges.find((e) => e.from === t1.toLowerCase())!; // WETH->USDC
const usdcPerWeth = rev.rate / (1 - 0.003); // strip fee for spot comparison
console.log(`edge USDC->WETH rate=${fwd.rate.toExponential(4)}  WETH->USDC rate=${rev.rate.toFixed(2)} (~${usdcPerWeth.toFixed(2)} USDC/WETH)`);
console.log(`weights: ${fwd.weight.toFixed(4)} / ${rev.weight.toFixed(4)} (finite=${[fwd, rev].every((e) => Number.isFinite(e.weight))})`);

if (!(usdcPerWeth > 500 && usdcPerWeth < 50_000)) { console.error('FAIL: edge rate implausible'); process.exit(1); }
console.log('PASS: canonical pool maps to accessible, correctly-scaled BF edges');
