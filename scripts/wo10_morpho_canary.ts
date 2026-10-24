/**
 * WO-10 Morpho Blue liquidation canary (eth fork):
 *  1. discover a Morpho market (WETH collateral / USDC loan) from
 *     CreateMarket logs — no manual market list.
 *  2. whale supplies collateral + borrows at ~80% LLTV.
 *  3. anvil_setCode market oracle -> MockAggregator price drop -> HF<1.
 *  4. executor.liquidate(protocolKind=1) -> Morpho liquidate with
 *     repaidShares -> sell collat -> LiquidationSettled.
 * Run: FORK_RPC_URL=<keyed eth> npx tsx scripts/wo10_morpho_canary.ts
 */
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { ethers } from 'ethers';

const FORK_URL = process.env.FORK_RPC_URL;
if (!FORK_URL) { console.error('FORK_RPC_URL required'); process.exit(1); }
const DROP_PCT = Number(process.env.LIQ_DROP_PCT ?? '30');
const PORT = 8571;

const SMART = '0x663050be401f590e8e2c3f01f05536948275015b';
const BALANCER = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const PAIR = '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc';

const rpc = (m: string, p: unknown[]) =>
  fetch(`http://127.0.0.1:${PORT}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }).then((r) => r.json());

const CREATE_TOPIC = '0x' + ethers.id('CreateMarket(bytes32,(address,address,address,address,uint256))').slice(2);
const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--chain-id', '31337', '--port', String(PORT), '--silent']);
for (let i = 0; i < 60; i++) { try { const c = await rpc('eth_chainId', []); if (c.result) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`);
const head = await provider.getBlockNumber();

// 1. discover WETH-collateral USDC-loan market from CreateMarket logs
const logs = (await rpc('eth_getLogs', [{ address: MORPHO, topics: [CREATE_TOPIC], fromBlock: '0x' + (head - 300_000).toString(16), toBlock: '0x' + head.toString(16) }])).result ?? [];
const coder = ethers.AbiCoder.defaultAbiCoder();
const morphoI = new ethers.Interface([
  'function supply((address,address,address,address,uint256), uint256, uint256, address, bytes)',
  'function supplyCollateral((address,address,address,address,uint256), uint256, address, bytes)',
  'function borrow((address,address,address,address,uint256), uint256, uint256, address, address)',
  'function position(bytes32,address) view returns (uint256,uint128,uint128)',
  'function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)',
]);
let mp: { id: string; loan: string; collat: string; oracle: string; irm: string; lltv: bigint; depth: bigint } | null = null;
const readMorpho = new ethers.Contract(MORPHO, morphoI, provider);
for (const l of logs) {
  const d = coder.decode(['tuple(address,address,address,address,uint256)'], l.data)[0];
  const [loan, collat, oracle, irm, lltv] = d;
  // WETH-collateral/USDC-loan only: WETH has a real UniV2 sell path
  if (loan.toLowerCase() !== USDC.toLowerCase() || collat.toLowerCase() !== WETH.toLowerCase()) continue;
  const m = await readMorpho.market(l.topics[1]);
  const depth = BigInt(m[0]) - BigInt(m[2]);
  if (!mp || depth > mp.depth) mp = { id: l.topics[1], loan, collat, oracle, irm, lltv: BigInt(lltv), depth };
}
if (!mp) { console.log('[morpho-canary] no WETH/USDC market found in range — pick another pair'); anvil.kill(); process.exit(1); }
console.log('[morpho-canary] market', mp.id.slice(0, 18), 'lltv', (Number(mp.lltv) / 1e16).toFixed(1) + '%', 'depth', ethers.formatUnits(mp.depth, 6), 'USDC', 'oracle', mp.oracle.slice(0, 10));

const eoa = ethers.Wallet.createRandom(provider);
await rpc('anvil_setBalance', [eoa.address, '0x21e19e0c9bab2400000']);
const ex = await new ethers.ContractFactory(
  JSON.parse(readFileSync('out/AllBrightExecutor.sol/AllBrightExecutor.json', 'utf8')).abi,
  JSON.parse(readFileSync('out/AllBrightExecutor.sol/AllBrightExecutor.json', 'utf8')).bytecode.object,
  eoa,
).deploy(BALANCER, AAVE_POOL);
await ex.waitForDeployment();
const EXEC = await ex.getAddress();
await (await ex.transferOwnership(SMART)).wait();
console.log('[morpho-canary] executor', EXEC);

// 2a. market has zero depth — a USDC whale supplies liquidity first
const USDC_WHALE = '0x28C6c06298d514Db089934071355E5743bf21d60';
// USDC FiatTokenV2: balances map at slot 9 — set the whale's balance directly
const usdcSlot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [USDC_WHALE, 9]));
await rpc('anvil_setStorageAt', [USDC, usdcSlot, '0x' + ethers.parseUnits('5000000', 6).toString(16).padStart(64, '0')]);
await rpc('anvil_impersonateAccount', [USDC_WHALE]);
await rpc('anvil_setBalance', [USDC_WHALE, '0xde0b6b3a7640000']);
const lender = await provider.getSigner(USDC_WHALE);
const mpt = [USDC, WETH, mp.oracle, mp.irm, mp.lltv];
const usdcC = new ethers.Contract(USDC, ['function approve(address,uint256)', 'function balanceOf(address) view returns (uint256)'], lender);
const lendAmt = ethers.parseUnits('400000', 6);
await (await usdcC.approve(MORPHO, lendAmt)).wait();
await (await new ethers.Contract(MORPHO, morphoI, lender).supply(mpt, lendAmt, 0, USDC_WHALE, '0x')).wait();
console.log('[morpho-canary] lender supplied', ethers.formatUnits(lendAmt, 6), 'USDC');

// 2b. whale supplies 100 WETH collateral, borrows ~80% LLTV of USDC
const WHALE = '0xF04a5cC80B1E94C69B48f5ee68a08CD2F09A7c3E';
await rpc('anvil_impersonateAccount', [WHALE]);
await rpc('anvil_setBalance', [WHALE, '0x3635c9adc5dea00000']);
const whale = await provider.getSigner(WHALE);
const morpho = new ethers.Contract(MORPHO, morphoI, whale);
const wc = new ethers.Contract(WETH, ['function deposit() payable', 'function approve(address,uint256)'], whale);
await (await wc.deposit({ value: ethers.parseEther('100') })).wait();
await (await wc.approve(MORPHO, ethers.parseEther('100'))).wait();
await (await morpho.supplyCollateral(mpt, ethers.parseEther('100'), WHALE, '0x')).wait();
const px = BigInt(await provider.call({ to: mp.oracle, data: '0xa035b1fe' }));
// oracle px scale is market-specific — size the borrow off the V2 pair's
// implied price instead: collatValue_usdc = 100 WETH * (usdc/weth ratio)
const [r0, r1] = await new ethers.Contract(PAIR, ['function getReserves() view returns (uint112,uint112,uint32)'], provider).getReserves();
const [wethR, usdcR] = WETH.toLowerCase() < USDC.toLowerCase() ? [r0, r1] : [r1, r0];
const ethUsd = Number(usdcR) / 1e6 / (Number(wethR) / 1e18);
const collatUsd = 100 * ethUsd;
const mkt = await morpho.market(mp.id); // tuple: [supplyAssets, supplyShares, borrowAssets, borrowShares, lastUpdate, fee]
const available = BigInt(mkt[0]) - BigInt(mkt[2]);
let borrowAssets = BigInt(Math.floor(collatUsd * 0.80)) * 10n ** 6n;
if (borrowAssets > available / 2n) borrowAssets = available / 4n; // stay inside liquidity
console.log('[morpho-canary] oracle px', px.toString(), 'ethUsd', ethUsd.toFixed(0), 'borrow', ethers.formatUnits(borrowAssets, 6), 'USDC avail', ethers.formatUnits(available, 6));
await (await morpho.borrow(mpt, borrowAssets, 0, WHALE, WHALE)).wait();
const pos0 = await morpho.position(mp.id, WHALE);
console.log('[morpho-canary] pos: collat', ethers.formatEther(pos0[2]), 'WETH borrowShares', pos0[1].toString());

// 3. oracle drop -> underwater
const mock = JSON.parse(readFileSync('out/MockAggregator.sol/MockAggregator.json', 'utf8'));
await rpc('anvil_setCode', [mp.oracle, mock.deployedBytecode.object]);
const pos = await morpho.position(mp.id, WHALE);
// liquidation bound: collat_raw * px * lltv < borrowed * 1e36
//   -> px < borrowed*1e36/(collat*lltv); set answer to 60% of the bound
const mB = await morpho.market(mp.id);
const borrowedAssets = (pos[1] * BigInt(mB[2])) / BigInt(mB[3]);
const pxBound = (borrowedAssets * 10n ** 36n) / (pos[2] * BigInt(mp.lltv) / 10n ** 18n);
const pxNew = (pxBound * 80n) / 100n; // 80% of bound = HF~0.8: liquidatable, seizure stays under 100 WETH
await rpc('anvil_setStorageAt', [mp.oracle, '0x' + (0).toString(16).padStart(64, '0'), '0x' + pxNew.toString(16).padStart(64, '0')]);
console.log('[morpho-canary] pxBound', pxBound.toString(), '-> px', pxNew.toString(), '(80% of bound)');
console.log('[morpho-canary] oracle -%s%% applied', DROP_PCT);

// 4. LiqPlan protocolKind=1: flash USDC -> Morpho liquidate(repaidShares=all) -> sell WETH
const marketData = coder.encode(['tuple(address,address,address,address,uint256)', 'uint256'], [mpt, pos[1] / 2n]); // repay half the shares
const LIQ_TUPLE = 'tuple(uint8 source, uint8 protocolKind, address protocol, address user, address collateralAsset, address debtAsset, uint256 debtToCover, bytes marketData, tuple(uint8 kind, address venue, address tokenIn, address tokenOut, uint24 fee, uint16 feeBps)[] hops, uint256 minProfit)';
// repaidAssets (borrow size) = shares * totalBorrow / totalBorrowShares, ceil
const mNow = await morpho.market(mp.id);
const cover = (pos[1] / 2n * BigInt(mNow[2])) / BigInt(mNow[3]) + 1n;
const liq = {
  source: 0, protocolKind: 1, protocol: MORPHO, user: WHALE,
  collateralAsset: WETH, debtAsset: USDC, debtToCover: cover,
  marketData,
  hops: [{ kind: 0, venue: PAIR, tokenIn: WETH, tokenOut: USDC, fee: 0, feeBps: 30 }],
  minProfit: ethers.parseUnits('50', 6),
};
const data = new ethers.Interface(['function liquidate(bytes)']).encodeFunctionData('liquidate', [coder.encode([LIQ_TUPLE], [liq])]);
await rpc('anvil_impersonateAccount', [SMART]);
await rpc('anvil_setBalance', [SMART, '0xde0b6b3a7640000']);
const probe = await provider.call({ from: SMART, to: EXEC, data }).then(() => 'PASS').catch((e) => {
  const d = e.data ?? '';
  if (d.startsWith('0x08c379a0')) { const len = parseInt(d.slice(74, 138), 16); return `REVERT "${Buffer.from(d.slice(138, 138 + len * 2), 'hex').toString()}"`; }
  return `REVERT ${d.slice(0, 80)}`;
});
console.log('[morpho-canary] execProbe:', probe);
if (probe === 'PASS') {
  const tx = await new ethers.Contract(EXEC, JSON.parse(readFileSync('out/AllBrightExecutor.sol/AllBrightExecutor.json', 'utf8')).abi, await provider.getSigner(SMART)).getFunction('liquidate')(coder.encode([LIQ_TUPLE], [liq]));
  const rcpt = await tx.wait();
  const ev = rcpt.logs.map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'LiquidationSettled');
  console.log('[morpho-canary] SETTLED gas=%s profit=%s', rcpt.gasUsed.toString(), ev ? ev.args[2].toString() : '?');
}
anvil.kill();
