/**
 * WO-10 acceptance — liquidation lane on an eth fork:
 *  1. real Aave V3 eth pool; impersonate WETH whale, supply collateral,
 *     borrow USDC near max LTV.
 *  2. anvil_setCode the WETH/USD Chainlink feed -> MockAggregator at -30%
 *     => health factor drops below 1 (fork-local, real oracle surface).
 *  3. executor.liquidate(): Balancer flash USDC -> liquidationCall ->
 *     sell WETH collat via UniV2 -> repay -> LiquidationSettled event.
 * Run: FORK_RPC_URL=<keyed eth> npx tsx scripts/wo10_liq_canary.ts
 */
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { ethers } from 'ethers';

const FORK_URL = process.env.FORK_RPC_URL;
if (!FORK_URL) { console.error('FORK_RPC_URL required'); process.exit(1); }
const DROP_PCT = Number(process.env.LIQ_DROP_PCT ?? '30');   // oracle price drop
const PORT = 8569;

const SMART = '0x663050be401f590e8e2c3f01f05536948275015b';
const BALANCER = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const PAIR = '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc'; // UniV2 USDC/WETH
const PROVIDER = '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e';

const rpc = (m: string, p: unknown[]) =>
  fetch(`http://127.0.0.1:${PORT}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }).then((r) => r.json());

const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--chain-id', '31337', '--port', String(PORT), '--silent']);
for (let i = 0; i < 60; i++) { try { const c = await rpc('eth_chainId', []); if (c.result) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`);
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
console.log('[liq-canary] executor', EXEC);

const call = (to: string, data: string) => provider.call({ to, data });
// 1. find WETH feed via provider->priceOracle->getSourceOfAsset
const oracleAddr = '0x' + (await call(PROVIDER, '0x' + ethers.id('getPriceOracle()').slice(2, 10) + ''.padEnd(0, '0'))).slice(-40);
const srcData = '0x' + ethers.id('getSourceOfAsset(address)').slice(2, 10) + '0'.repeat(24) + WETH.slice(2);
const feed = '0x' + (await call(oracleAddr, srcData)).slice(-40);
console.log('[liq-canary] oracle', oracleAddr, 'weth feed', feed);

// 2. whale supplies WETH, borrows USDC ~85% LTV
const WHALE = '0xF04a5cC80B1E94C69B48f5ee68a08CD2F09A7c3E'; // big WETH holder
const IE = new ethers.Interface([
  'function deposit() payable',
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 ref)',
  'function borrow(address asset, uint256 amount, uint256 rateMode, uint16 ref, address onBehalfOf)',
  'function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
  'function approve(address,uint256) returns (bool)',
]);
await rpc('anvil_impersonateAccount', [WHALE]);
await rpc('anvil_setBalance', [WHALE, '0x3635c9adc5dea00000']);
const whale = await provider.getSigner(WHALE);
const wc = new ethers.Contract(WETH, IE, whale);
await (await wc.deposit({ value: ethers.parseEther('200') })).wait();
await (await wc.approve(AAVE_POOL, ethers.parseEther('200'))).wait();
const pool = new ethers.Contract(AAVE_POOL, IE, whale);
await (await pool.supply(WETH, ethers.parseEther('150'), WHALE, 0)).wait();
const before = await pool.getUserAccountData(WHALE);
console.log('[liq-canary] supplied 150 WETH, coll $%s ltv %s', (before[0] / 10n ** 8n).toString(), (before[4] / 10n ** 16n).toString() + '%');
const borrowUsd = (before[0] * 85n / 100n) - (before[0] * 79n / 100n); // to ~85% ltv from 79%-ish
const usdAmt = Number(before[0] / 10n ** 8n) * 0.75;
await (await pool.borrow(USDC, BigInt(Math.floor(usdAmt)) * 10n ** 6n, 2, 0, WHALE)).wait();
const mid = await pool.getUserAccountData(WHALE);
console.log('[liq-canary] borrowed $%s USDC | HF = %s', usdAmt.toFixed(0), (Number(mid[5]) / 1e18).toFixed(4));

// 3. oracle drop: read real price, set mock at -DROP_PCT
const feedIface = new ethers.Interface(['function latestAnswer() view returns (int256)']);
const realPx = await new ethers.Contract(feed, feedIface, provider).latestAnswer();
const mock = JSON.parse(readFileSync('out/MockAggregator.sol/MockAggregator.json', 'utf8'));
await rpc('anvil_setCode', [feed, mock.deployedBytecode.object]);
await rpc('anvil_setStorageAt', [feed, '0x' + (0).toString(16).padStart(64, '0'), '0x' + (realPx * BigInt(100 - DROP_PCT) / 100n).toString(16).padStart(64, '0')]);
const after = await pool.getUserAccountData(WHALE);
console.log('[liq-canary] oracle -%s%% -> HF = %s (liquidatable: %s)', DROP_PCT, (Number(after[5]) / 1e18).toFixed(4), after[5] < 10n ** 18n);

// 4. LiqPlan: flash USDC, liquidationCall, sell WETH collat on UniV2
const debtToCover = (after[1] / 2n) / 10n ** 2n * 10n ** 2n; // 50% of debt in USDC units (base=8dec -> 6)
const usdcDebt = after[1]; // base USD*1e8 ≈ USDC*1e8 — USDC has 6 dec: convert /100
const cover = usdcDebt / 2n / 100n;
const LIQ_TUPLE = 'tuple(uint8 source, address protocol, address user, address collateralAsset, address debtAsset, uint256 debtToCover, tuple(uint8 kind, address venue, address tokenIn, address tokenOut, uint24 fee, uint16 feeBps)[] hops, uint256 minProfit)';
const liq = {
  source: 0, protocol: AAVE_POOL, user: WHALE,
  collateralAsset: WETH, debtAsset: USDC, debtToCover: cover,
  hops: [{ kind: 0, venue: PAIR, tokenIn: WETH, tokenOut: USDC, fee: 0, feeBps: 30 }],
  minProfit: ethers.parseUnits('100', 6),
};
const data = new ethers.Interface(['function liquidate(bytes)']).encodeFunctionData('liquidate', [ethers.AbiCoder.defaultAbiCoder().encode([LIQ_TUPLE], [liq])]);
await rpc('anvil_impersonateAccount', [SMART]);
await rpc('anvil_setBalance', [SMART, '0xde0b6b3a7640000']);
const probe = await provider.call({ from: SMART, to: EXEC, data }).then(() => 'PASS').catch((e) => `REVERT ${e.data?.slice(0, 10) ?? String(e).slice(0, 120)}`);
console.log('[liq-canary] execProbe:', probe);
if (probe === 'PASS') {
  const tx = await new ethers.Contract(EXEC, JSON.parse(readFileSync('out/AllBrightExecutor.sol/AllBrightExecutor.json', 'utf8')).abi, await provider.getSigner(SMART)).getFunction('liquidate')(ethers.AbiCoder.defaultAbiCoder().encode([LIQ_TUPLE], [liq]));
  const rcpt = await tx.wait();
  const ev = rcpt.logs.map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'LiquidationSettled');
  console.log('[liq-canary] SETTLED gas=%s profit=%s', rcpt.gasUsed.toString(), ev ? ev.args[2].toString() : '?');
}
anvil.kill();
