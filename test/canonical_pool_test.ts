/**
 * Canonical orientation assertion — Uniswap V2 WETH/USDC.
 *   pair: 0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc (token0=WETH/18, token1=USDC/6)
 * Resolves decimals ON-CHAIN (never feed metadata) and asserts the
 * decimal-normalized spot price lands in a plausible band — a raw-reserve
 * comparison here would be off by 10^12.
 *   Run: npx tsx test/canonical_pool_test.ts
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { v2SpotPrice } from '../src/math/univ2.js';

const PAIR = '0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const rpc = process.env.ALCHEMY_API_KEY
  ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : process.env.ETH_RPC_URLS?.split(',')[0];
if (!rpc) { console.error('no keyed eth RPC in env'); process.exit(1); }

const provider = new ethers.JsonRpcProvider(rpc);
const pair = new ethers.Contract(PAIR, [
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
], provider);
const erc20 = new ethers.Interface(['function decimals() view returns (uint8)']);
const decOf = async (a: string) =>
  Number(erc20.decodeFunctionResult('decimals', await provider.call({ to: a, data: erc20.encodeFunctionData('decimals') }))[0]);

const [t0, t1, [r0, r1]] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
const [d0, d1] = await Promise.all([decOf(t0), decOf(t1)]);

console.log(`token0=${t0} token1=${t1}`);
console.log(`reserves: r0=${r0} r1=${r1}  decimals: d0=${d0} d1=${d1}`);

// orientation — this pair is USDC(6)/WETH(18): token0=USDC, token1=WETH
if (t0.toLowerCase() !== USDC || t1.toLowerCase() !== WETH) {
  console.error('orientation mismatch — expected USDC/WETH'); process.exit(1);
}
if (d0 !== 6 || d1 !== 18) { console.error(`decimals wrong: ${d0}/${d1} expected 6/18`); process.exit(1); }

const price = v2SpotPrice({ reserveIn: r1, reserveOut: r0 }, d1, d0); // USDC per WETH
const rawPrice = Number(r0) / Number(r1); // raw-unit comparison — the BUG path
console.log(`normalized spot: ${price.toFixed(2)} USDC/WETH   (raw-unit would say ${rawPrice.toFixed(4)})`);

// plausible band for ETH price — failure means decimal/orientation regression
if (!(price > 500 && price < 50_000)) {
  console.error(`FAIL: spot ${price} outside 500–50000 band`); process.exit(1);
}
// raw comparison must NOT pass — proves the bug path is excluded
if (rawPrice > 500 && rawPrice < 50_000) {
  console.error('FAIL: raw-unit ratio accidentally plausible'); process.exit(1);
}
console.log('PASS: canonical WETH/USDC spot price is decimal-correct');
