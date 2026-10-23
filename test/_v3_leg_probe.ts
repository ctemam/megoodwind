/** isolate leg-2: impersonate X holder -> approve -> exactInputSingle(X->WETH,500) */
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
const FORK_URL = process.env.FORK_RPC_URL!;
const ANVIL = 'http://127.0.0.1:8545';
const P0 = '0x21594b992f68495dd28d605834b58889d0a727c7';
const P1 = '0x9c087eb773291e50cf6c6a90ef0f4500e349b903';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const WETH = '0x4200000000000000000000000000000000000006';
const X = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';

const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--chain-id', '31337', '--port', '8545', '--fork-block-number', '52977627'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 8000));
const provider = new ethers.JsonRpcProvider(ANVIL);
const rpc = (m: string, p: unknown[]) => provider.send(m, p);
const eoa = (await provider.listAccounts())[0];

// impersonate the pool, send X to eoa
const Xc = new ethers.Contract(X, ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)'], provider);
await rpc('anvil_impersonateAccount', [P1]);
await rpc('anvil_setBalance', [P1, '0x' + ethers.parseEther('1').toString(16)]);
const xFromPool = Xc.connect(await provider.getSigner(P1));
const amt = 1286860000000000000000n; // ~ leg-1 output
await (await xFromPool.getFunction('transfer')(await eoa.getAddress(), amt)).wait();
const bal = await Xc.balanceOf(await eoa.getAddress());
console.log('X balance:', bal);

// approve router
const xSigner = Xc.connect(eoa);
const ap = await xSigner.getFunction('approve')(ROUTER, amt).then(async (t) => 'ok').catch((e) => 'REV: ' + String(e).slice(0, 90));
console.log('approve:', ap);

// exactInputSingle
const R = new ethers.Contract(ROUTER, ['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)'], eoa);
const res = await R.exactInputSingle([X, WETH, 500, await eoa.getAddress(), amt, 0n, 0n])
  .then(async (t) => `ok tx=${(await t.wait()).hash}`).catch((e) => 'REV: ' + String(e).slice(0, 140));
console.log('exactInputSingle:', res);
anvil.kill();
