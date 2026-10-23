/** quick check — does aggregate3 slot0/liquidity land on base v3 pools? */
import { chainConfig } from '../src/config/index.js';
import { poolFor } from '../src/providers/rpcPool.js';
import { multicall } from '../src/providers/multicall.js';
import { ethers } from 'ethers';

const chain = chainConfig('base');
const rpc = poolFor(chain);
const ABI = new ethers.Interface(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns (uint128)']);
const pools = ['0x6c561b446416e1a00e8e93e221854d6ea4171372', '0x4c36388bE6F416A29C8d8Eee81C771cE6bE14B18'];
const calls = pools.flatMap((p) => [
  { to: p, data: ABI.encodeFunctionData('slot0') },
  { to: p, data: ABI.encodeFunctionData('liquidity') },
]);
const res = await multicall(rpc, calls, calls.length, () => console.log('transportFail'));
console.log(JSON.stringify(res.map((r) => (r.length > 20 ? 'OK' : r))));
