/** WO-8 step 1 — base-candidate fork exec. Reconstructs the WO-7
 *  probe_pass candidate on an Anvil FORK of base (chainId 31337,
 *  throwaway key, loopback only) and runs executor.exec() through the
 *  CURRENT build (deployed 0x6614… is stale bytecode). Mirrors the WO-4
 *  safety assertions: assertLocalRpc, assertNotMainnet, assertThrowawayKey.
 *  Run: FORK_RPC_URL=<keyed base rpc> npx tsx test/canary/base_canary.ts */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { assertLocalRpc, assertNotMainnet, assertThrowawayKey, _selfTest } from './canaryGuard.js';

const FORK_URL = process.env.FORK_RPC_URL;
if (!FORK_URL) { console.error('FORK_RPC_URL (keyed base rpc) required'); process.exit(1); }
const ANVIL = 'http://127.0.0.1:8545';
const PIN_BLOCK = Number(process.env.CANARY_BLOCK ?? 52_977_627); // census detection block
assertLocalRpc(ANVIL); _selfTest();

const SMART = ethers.getAddress('0x663050be401f590e8e2c3f01f05536948275015b');
const WETH = ethers.getAddress('0x4200000000000000000000000000000000000006');
const TOKEN_X = ethers.getAddress('0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b');
const POOL_V2 = ethers.getAddress('0x21594b992f68495dd28d605834b58889d0a727c7'); // aerodrome V1
const POOL_V3 = ethers.getAddress('0x9c087eb773291e50cf6c6a90ef0f4500e349b903'); // UniV3 fee=500
const V3_ROUTER_BASE = ethers.getAddress('0x2626664c2603336E57B271c5C0b26F421741e481');
const BALANCER = ethers.getAddress('0xBA12222222228d8Ba445958a75a0704d566BF2C8');
const AAVE_BASE = ethers.getAddress('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5');
const MORPHO = ethers.getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb');
const BORROW = 355939609935191488n; // recorded probe_pass borrowAmount
const BALANCER_FEE = 0n;
const NATIVE_USD = Number(process.env.CANARY_NATIVE_USD ?? '2600');

const THROWAWAY = ethers.Wallet.createRandom().privateKey;
assertThrowawayKey(THROWAWAY, [SMART]);
const eoa = ethers.computeAddress(THROWAWAY);
console.log(`[base-canary] throwaway EOA ${eoa} | pin block ${PIN_BLOCK}`);

const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--chain-id', '31337', '--port', '8545', '--fork-block-number', String(PIN_BLOCK)], { stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('anvil boot timeout')), 60_000);
  const iv = setInterval(async () => {
    try { await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); clearInterval(iv); clearTimeout(t); res(0); } catch { }
  }, 500);
});
const chainId = await assertNotMainnet(ANVIL);
if (chainId !== 31337) throw new Error(`CANARY_ABORT: expected 31337 got ${chainId}`);

const provider = new ethers.JsonRpcProvider(ANVIL);
const wallet = new ethers.Wallet(THROWAWAY, provider);
const rpc = (m: string, p: unknown[]) => provider.send(m, p);
await rpc('anvil_setBalance', [eoa, '0x' + ethers.parseEther('1000').toString(16)]);

// ---- deploy CURRENT executor on the fork (deployed one is stale)
const artifact = JSON.parse(readFileSync('out/AllBrightExecutor.sol/AllBrightExecutor.json', 'utf8'));
const ex = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet).deploy(BALANCER, AAVE_BASE);
await ex.waitForDeployment();
const EXEC = await ex.getAddress();
await (await ex.getFunction('setZeroFeeVenues')(MORPHO, ethers.ZeroAddress)).wait();
await (await ex.getFunction('transferOwnership')(SMART)).wait();
console.log(`[base-canary] executor ${EXEC} owner->SMART`);

// ---- token sanity: X must transfer normally (no fee/blacklist paths)
const X = new ethers.Contract(TOKEN_X, ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function symbol() view returns (string)'], provider);
console.log(`[base-canary] tokenX symbol=${await X.symbol().catch(() => '?')} code=${((await provider.getCode(TOKEN_X)).length - 2) / 2}B`);
await rpc('anvil_impersonateAccount', [POOL_V2]);
await rpc('anvil_setBalance', [POOL_V2, '0x' + ethers.parseEther('10').toString(16)]);
const xPool = X.connect(await provider.getSigner(POOL_V2));
const before = await X.balanceOf(eoa);
await (await xPool.getFunction('transfer')(eoa, 1_000_000n)).wait();
const delta = (await X.balanceOf(eoa)) - before;
console.log(`[base-canary] tokenX transfer probe: sent 1000000 received ${delta} (${BigInt(delta) === 1_000_000n ? 'no fee' : 'FEE/RESTRICTED'})`);
await rpc('anvil_stopImpersonatingAccount', [POOL_V2]);

// ---- read pool state at fork block for honest sim (solver-model numbers)
const V2 = new ethers.Interface(['function getReserves() view returns (uint112,uint112,uint32)']);
const V3 = new ethers.Interface(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns (uint128)']);
const [r0p, r1p] = V2.decodeFunctionResult('getReserves', await provider.call({ to: POOL_V2, data: V2.encodeFunctionData('getReserves') })) as unknown as [bigint, bigint];
const [sqrtP] = V3.decodeFunctionResult('slot0', await provider.call({ to: POOL_V3, data: V3.encodeFunctionData('slot0') })) as unknown as [bigint];
const [liqV3] = V3.decodeFunctionResult('liquidity', await provider.call({ to: POOL_V3, data: V3.encodeFunctionData('liquidity') })) as unknown as [bigint];
console.log(`[base-canary] p0 reserves t0=${r0p} weth=${r1p} | v3 sqrtP=${sqrtP} liq=${liqV3}`);

// predicted: v2 leg1 WETH->X, v3 leg2 X->WETH via virtual reserves
const out1 = (r0p * BORROW * 997n / 1000n) / (r1p + BORROW * 997n / 1000n);
const s = Number(sqrtP) / 2 ** 96;
const vInX = Number(liqV3) / s, vOutW = Number(liqV3) * s;
const out2 = BigInt(Math.floor((vOutW * Number(out1) * 0.9995) / (vInX + Number(out1) * 0.9995)));
const predGrossWeth = Number(out2 - BORROW) / 1e18;
console.log(`[base-canary] solver-model predicted: out1=${out1} out2=${out2} gross=${predGrossWeth.toFixed(6)} WETH (~$${(predGrossWeth * NATIVE_USD).toFixed(4)})`);

// ---- plan: borrow WETH via BALANCER, V2 hop then V3 hop
const PLAN_TUPLE = 'tuple(uint8 source, address borrowToken, uint256 borrowAmount, tuple(uint8 kind, address venue, address tokenIn, address tokenOut, uint24 fee, uint16 feeBps)[] hops, uint256 minOut, uint256 minProfit)';
const minProfitWei = BigInt(Math.floor((Number(process.env.CANARY_MIN_PROFIT_USD ?? '1') / NATIVE_USD) * 1e18));
const plan = {
  source: 0, borrowToken: WETH, borrowAmount: BORROW,
  hops: [
    { kind: 0, venue: POOL_V2, tokenIn: WETH, tokenOut: TOKEN_X, fee: 0, feeBps: 105 }, // real fee=100bps; engine's CP formula still over-demands ~0.4e18 X at 100 — 105 keeps requested out strictly below pool's getAmountOut (K() requires out < curve output)
    { kind: 1, venue: V3_ROUTER_BASE, tokenIn: TOKEN_X, tokenOut: WETH, fee: 500, feeBps: 0 },
  ],
  minOut: BORROW + BALANCER_FEE,
  minProfit: minProfitWei,
};
const execData = new ethers.Interface(['function exec(bytes)']).encodeFunctionData('exec', [ethers.AbiCoder.defaultAbiCoder().encode([PLAN_TUPLE], [plan])]);
console.log(`[base-canary] minProfit=${minProfitWei} ($${process.env.CANARY_MIN_PROFIT_USD ?? '1'}) minOut=${plan.minOut}`);

// ---- exec-probe (read-only eth_call from owner) then real exec
await rpc('anvil_impersonateAccount', [SMART]);
await rpc('anvil_setBalance', [SMART, '0x' + ethers.parseEther('1').toString(16)]);
const probe = await provider.call({ from: SMART, to: EXEC, data: execData }).then(() => 'PASS').catch((e) => `REVERT ${String(e).slice(0, 140)}`);
console.log(`[base-canary] execProbe: ${probe}`);

const signer = await provider.getSigner(SMART);
const exC = new ethers.Contract(EXEC, artifact.abi, signer);
const tx = await exC.getFunction('exec')(ethers.AbiCoder.defaultAbiCoder().encode([PLAN_TUPLE], [plan])).catch((e) => { console.log(`[base-canary] exec TX REVERTED: ${String(e).slice(0, 200)}`); return null; });
if (tx) {
  const rcpt = await tx.wait();
  const settled = rcpt.logs.map((l: ethers.Log) => { try { return exC.interface.parseLog(l); } catch { return null; } }).find((e: ethers.LogDescription | null) => e?.name === 'ArbSettled');
  const gasUsd = Number(rcpt.gasUsed * rcpt.gasPrice) / 1e18 * NATIVE_USD;
  console.log(`[base-canary] SETTLED tx=${rcpt.hash} gasUsed=${rcpt.gasUsed} gas~$${gasUsd.toFixed(4)}`);
  if (settled) console.log(`[base-canary] ArbSettled borrowed=${settled.args[1]} profit=${settled.args[2]} (~$${(Number(settled.args[2]) / 1e18 * NATIVE_USD).toFixed(4)})`);
  const bal = await new ethers.Contract(WETH, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(EXEC);
  console.log(`[base-canary] executor WETH balance post-exec: ${bal} (~$${(Number(bal) / 1e18 * NATIVE_USD).toFixed(4)})`);
}
anvil.kill();
console.log('[base-canary] done');
