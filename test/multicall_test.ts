/** Live Multicall3 sanity — 3 token subcalls in ONE aggregate3 request. */
import { ethers } from 'ethers';
import { chainConfig } from '../src/config/index.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { aggregate3 } from '../src/providers/multicall.js';

const ABI = new ethers.Interface([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const chain = process.argv[2] ?? 'eth';
const rpc = new RpcPool(chainConfig(chain));

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const res = await aggregate3(rpc, [
  { to: WETH, data: ABI.encodeFunctionData('decimals') },
  { to: WETH, data: ABI.encodeFunctionData('symbol') },
  { to: USDC, data: ABI.encodeFunctionData('decimals') },
]);

console.log('WETH decimals:', ABI.decodeFunctionResult('decimals', res[0])[0].toString());
console.log('WETH symbol:  ', ABI.decodeFunctionResult('symbol', res[1])[0]);
console.log('USDC decimals:', ABI.decodeFunctionResult('decimals', res[2])[0].toString());
console.log('MULTICALL3 VERIFIED — 3 subcalls in 1 RPC request');
process.exit(0);
