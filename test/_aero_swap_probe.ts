/** isolate the aerodrome leg-0 revert: transfer WETH in, call swap() directly */
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';

const FORK_URL = process.env.FORK_RPC_URL!;
const ANVIL = 'http://127.0.0.1:8545';
const P = '0x21594b992f68495dd28d605834b58889d0a727c7';
const WETH = '0x4200000000000000000000000000000000000006';
const X = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const AMT = 355939609935191488n;

const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--chain-id', '31337', '--port', '8545', '--fork-block-number', '52977627'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 8000));
const provider = new ethers.JsonRpcProvider(ANVIL);
const me = (await provider.listAccounts())[0];
const rpc = (m: string, p: unknown[]) => provider.send(m, p);

const abi = new ethers.Interface([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function swap(uint256,uint256,address,bytes)', 'function stable() view returns (bool)',
  'function metadata() view returns (uint256,uint256,uint256,uint256,bool,uint8)',
  'function getAmountOut(uint256,address) view returns (uint256)',
]);
const weth = new ethers.Contract(WETH, ['function deposit() payable', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], me);

// stable() + metadata
console.log('stable():', await provider.call({ to: P, data: abi.encodeFunctionData('stable') }));
console.log('metadata:', await provider.call({ to: P, data: abi.encodeFunctionData('metadata') }));
const out = BigInt(await provider.call({ to: P, data: abi.encodeFunctionData('getAmountOut', [AMT, WETH]) }));
console.log('pool getAmountOut:', out / 10n ** 18n);

// fund + transfer in + swap
await (await weth.deposit({ value: ethers.parseEther('10') })).wait();
await (await weth.transfer(P, AMT)).wait();
const bal0 = await provider.call({ to: X, data: new ethers.Interface(['function balanceOf(address) view returns (uint256)']).encodeFunctionData('balanceOf', [await me.getAddress()]) });
for (const req of [out, out - 1n, out / 2n]) {
  const r = await provider.call({ to: P, from: await me.getAddress(), data: abi.encodeFunctionData('swap', [req, 0n, await me.getAddress(), '0x']) })
    .then(() => `ok @req=${req}`).catch((e) => `rev @req=${req}: ${String(e).slice(0, 80)}`);
  console.log(r);
}
anvil.kill();
