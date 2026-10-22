/**
 * WO-4 exec-path canary — proves one candidate travels
 *   detect → solve → sim → probe → executeCandidate → flash loan → repay → profit
 * on a local Anvil mainnet fork (chainId 31337). NOTHING reaches mainnet:
 * all RPC is loopback, the key is throwaway, ARM_LIVE lives only in this
 * process's env.
 *
 * Synthetic market: two REAL UniV2-family pairs (Uniswap factory +
 * Sushiswap factory, WETH/USDC) seeded at a known spread — the pipeline
 * sees honest reserves via normal getReserves refresh.
 *
 * Run: FORK_RPC_URL=<keyed eth rpc> tsx test/canary/exec_canary.ts --spread 1.5
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { assertLocalRpc, assertNotMainnet, assertThrowawayKey, _selfTest } from './canaryGuard.js';
import { startLocalBundler } from './localBundler.js';

// ---------------------------------------------------------------- fork env
const FORK_URL = process.env.FORK_RPC_URL;
if (!FORK_URL) { console.error('FORK_RPC_URL (keyed eth rpc) required'); process.exit(1); }
const SPREAD_PCT = Number(process.env.CANARY_SPREAD_PCT ?? process.argv[process.argv.indexOf('--spread') + 1] ?? '1.5');
const PIN_BLOCK = process.env.CANARY_BLOCK ? Number(process.env.CANARY_BLOCK) : undefined;
const ANVIL = 'http://127.0.0.1:8545';
const BUNDLER = 'http://127.0.0.1:8546';

// -------------------------------------------------------- hard safety gate
assertLocalRpc(ANVIL);
assertLocalRpc(BUNDLER);
_selfTest();

const WETH = ethers.getAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
// this environment's mainnet USDC — matches TOKEN_USD/MAJORS in arbRunner
const USDC = ethers.getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
const UNIV2_FACTORY = ethers.getAddress('0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f');
const SUSHIV2_FACTORY = ethers.getAddress('0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac');
const SMART = ethers.getAddress('0x663050be401f590e8e2c3f01f05536948275015b');
// deployed executor at 0x6614… is STALE bytecode (venue getters revert) —
// the canary deploys the current build instead (see EXECUTOR_DEPLOYED).
const ECDSA_VALIDATOR = ethers.getAddress('0x845adb2c711129d4f3966735ed98a9f09fc4ce57');
const EP07 = ethers.getAddress('0x0000000071727de22e5e9d8baf0edac6f37da032');
// canonical real pairs on this fork's mainnet — PAIR_EXISTS means the
// factories already route them; we skew liquidity, not the venue.

const THROWAWAY = ethers.Wallet.createRandom().privateKey;
assertThrowawayKey(THROWAWAY, [SMART]);
const eoa = ethers.computeAddress(THROWAWAY);
console.log(`[canary] throwaway EOA ${eoa} (fork-only funds)`);

// --------------------------------------------------------------- anvil up
const args = ['--fork-url', FORK_URL, '--chain-id', '31337', '--port', '8545'];
if (PIN_BLOCK) args.push('--fork-block-number', String(PIN_BLOCK));
console.log(`[canary] anvil ${PIN_BLOCK ? `block ${PIN_BLOCK}` : 'latest'} | spread ${SPREAD_PCT}%`);
const anvil = spawn('anvil', args, { stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('anvil boot timeout')), 45_000);
  const iv = setInterval(async () => {
    try {
      await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      clearInterval(iv); clearTimeout(t); res(0);
    } catch { /* still booting */ }
  }, 500);
});
const chainId = await assertNotMainnet(ANVIL);
if (chainId !== 31337) throw new Error(`CANARY_ABORT: expected chainId 31337 got ${chainId}`);

// Deploy the CURRENT executor build on the fork — the already-deployed
// 0x6614… executor is stale bytecode (venue getters revert → probe dies).
// Deployer is the throwaway EOA; ownership transfers to the smart account
// so UserOps keep the strict_4337 identity.
const artifact = JSON.parse(readFileSync('out/AllBrightExecutor.sol/AllBrightExecutor.json', 'utf8'));
const provider0 = new ethers.JsonRpcProvider(ANVIL);
const wallet0 = new ethers.Wallet(THROWAWAY, provider0);
await provider0.send('anvil_setBalance', [eoa, '0x' + ethers.parseEther('1000').toString(16)]);
const exFactory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet0);
const ex = await exFactory.deploy(
  '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer V2 Vault
  '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // Aave V3 Pool (eth)
);
await ex.waitForDeployment();
const EXECUTOR_DEPLOYED = await ex.getAddress();
const exC = ex as unknown as ethers.Contract;
await (await exC.getFunction('setZeroFeeVenues')('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', ethers.ZeroAddress)).wait();
await (await exC.getFunction('transferOwnership')(SMART)).wait();
console.log(`[canary] executor deployed ${EXECUTOR_DEPLOYED} owner->SMART`);

// ------------------------------------------ canary env BEFORE config load
process.env.ACTIVE_CHAINS = 'canary';
process.env.CHAIN_ID_CANARY = '31337';
process.env.CANARY_RPC_URLS = ANVIL;
process.env.ALLBRIGHT_EXECUTOR_CANARY = EXECUTOR_DEPLOYED;
process.env.AUTO_EXECUTE = 'true';
process.env.ARM_LIVE = '31337';
process.env.BUNDLER_URL = BUNDLER;
process.env.CANARY_SELF_PAY = '1';
process.env.PRIVATE_KEY = THROWAWAY;
process.env.SMART_ACCOUNT_ADDRESS = SMART;
process.env.PIMLICO_API_KEY = 'canary';
process.env.STRATEGIES = 'P01';
process.env.DIAG_ONLY = '0';
process.env.PROFIT_WALLET = eoa;

const { cfg, chainConfig, armedFor } = await import('../../src/config/index.js');
const { registry } = await import('../../src/pools/registry.js');
const { poolFor } = await import('../../src/providers/rpcPool.js');
const { solve } = await import('../../src/strategies/solver.js');
const { VARIANTS, VariantScheduler } = await import('../../src/engine/predictiveEngine.js');
const { refreshPools } = await import('../../src/feed/refresh.js');
const { executeCandidate } = await import('../../src/exec/executor.js');
const { metrics } = await import('../../src/telemetry/metrics.js');

const chain = chainConfig('canary');
console.log(`[canary] chain ${chain.key} id=${chain.chainId} executor=${chain.executor} rpc=${chain.rpcUrls[0]}`);
console.log(`[canary] armedFor(31337)=${armedFor(31337)} armedFor(1)=${armedFor(1)}`);

if (!armedFor(chain.chainId)) throw new Error('canary chain not armed — abort');
if (armedFor(1)) throw new Error('CANARY_ABORT: mainnet chainId is armed — refusing');

const bundler = startLocalBundler({ anvilUrl: ANVIL, bundlerPort: 8546, beneficiaryKey: THROWAWAY });
const provider = new ethers.JsonRpcProvider(ANVIL);
const wallet = new ethers.Wallet(THROWAWAY, provider);
const rpc = async (method: string, params: unknown[] = []) =>
  provider.send(method, params);

// ----------------------------------------------------------- fork surgery
await rpc('anvil_setBalance', [eoa, '0x' + ethers.parseEther('1000').toString(16)]);

// smart-account owner swap on the ECDSA validator (Kernel root validator):
// read the live owner, prove the slot, write the throwaway.
const validator = new ethers.Contract(ECDSA_VALIDATOR, ['function ecdsaValidatorStorage(address) view returns (address)'], provider);
const ownerBefore = await validator.ecdsaValidatorStorage(SMART);
const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [SMART, 0]));
await rpc('anvil_setStorageAt', [ECDSA_VALIDATOR, slot, ethers.zeroPadValue(eoa, 32)]);
const ownerAfter = await validator.ecdsaValidatorStorage(SMART);
console.log(`[canary] validator owner ${ownerBefore} -> ${ownerAfter}`);
if (ownerAfter.toLowerCase() !== eoa.toLowerCase()) throw new Error('owner swap failed — wrong slot');

// fund the smart account's EntryPoint deposit (self-pay UserOps)
const ep = new ethers.Contract(EP07, ['function depositTo(address) payable', 'function balanceOf(address) view returns (uint256)'], wallet);
await (await ep.depositTo(SMART, { value: ethers.parseEther('0.5') })).wait();
console.log(`[canary] entrypoint deposit ${ethers.formatEther(await ep.balanceOf(SMART))} ETH`);

// ------------------------------------------------------- synthetic market
const NATIVE_USD = cfg.NATIVE_USD;
// $25M per side: the dynamic slippage bound (10bps at BALANCED) clips
// borrow to ~vIn×5e-4 — $600k pools cap borrow near $300 (gross < gas,
// the same min_profit_floor starvation seen live). $25M lets the honest
// $10k FLASH_BORROW_USD size pass every gate untouched.
const USD_SIDE = 25_000_000;
const mkpair = async (factory: string, usd: number, wethUsd: number) => {
  const f = new ethers.Contract(factory, ['function createPair(address,address) returns (address)', 'function getPair(address,address) view returns (address)'], wallet);
  try { await (await f.createPair(USDC, WETH)).wait(); } catch { /* pair may exist */ }
  return f.getPair(USDC, WETH) as Promise<string>;
};
const pairA = await mkpair(UNIV2_FACTORY, USD_SIDE, USD_SIDE);
const pairB = await mkpair(SUSHIV2_FACTORY, USD_SIDE, USD_SIDE * (1 + SPREAD_PCT / 100));
console.log(`[canary] pairs A(uni)=${pairA} B(sushi)=${pairB}`);

// fund EXACT balances via storage writes on BOTH tokens (WETH balanceOf
// is mapping slot 3 on mainnet WETH9). Writing token balances then sync()
// makes the pair reserves deterministic — real pre-existing liquidity on
// these canonical pairs distorted the skew when we only added on top.
const wethIface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const usdcIface = new ethers.Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const setBal = async (token: string, slot: number, acct: string, amt: bigint) => {
  const sl = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [acct, slot]));
  await rpc('anvil_setStorageAt', [token, sl, ethers.zeroPadValue(ethers.toBeHex(amt), 32)]);
};
// pool A: WETH priced at NATIVE_USD. pool B: WETH priced ×(1+spread) —
// i.e. fewer WETH per USDC. Arb: buy WETH on A, sell on B.
const wethResA = ethers.parseUnits((USD_SIDE / NATIVE_USD).toFixed(8), 18);
const wethResB = ethers.parseUnits((USD_SIDE / (NATIVE_USD * (1 + SPREAD_PCT / 100))).toFixed(8), 18);

// USDC funding via direct storage write: discover the balances-mapping
// slot by probing candidate slots against balanceOf, then write the two
// pair balances + sync. (No whale large enough exists on this fork's USDC.)
const usdcBalOf = (a: string) =>
  provider.call({ to: USDC, data: usdcIface.encodeFunctionData('balanceOf', [a]) }).then((r) => (r && r !== '0x' ? BigInt(r) : 0n));
let balSlot = -1;
const probeAddr = eoa; // write into throwaway, verify via balanceOf
const target = BigInt(USD_SIDE) * 10n ** 6n;
for (let s = 0; s < 40 && balSlot < 0; s++) {
  const sl = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [probeAddr, s]));
  await rpc('anvil_setStorageAt', [USDC, sl, ethers.zeroPadValue(ethers.toBeHex(target), 32)]);
  if ((await usdcBalOf(probeAddr)) === target) balSlot = s;
}
if (balSlot < 0) throw new Error('USDC balances slot not found in 40 slots');
console.log(`[canary] usdc balances slot = ${balSlot}`);
for (const [pair, wethRes] of [[pairA, wethResA], [pairB, wethResB]] as const) {
  await setBal(USDC, balSlot, pair, target);
  await setBal(WETH, 3, pair, wethRes); // WETH9 balanceOf mapping slot 3
}
const pairAbi = ['function sync()', 'function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)', 'function token1() view returns (address)'];
for (const p of [pairA, pairB]) await (await new ethers.Contract(p, pairAbi, wallet).sync()).wait();
// report the realized price spread (existing liquidity may shift it)
const pa = new ethers.Contract(pairA, pairAbi, provider);
const pb = new ethers.Contract(pairB, pairAbi, provider);
const [ra0, ra1] = await pa.getReserves(); const [rb0, rb1] = await pb.getReserves();
const px = (u: bigint, w: bigint) => (Number(u) / 1e6) / (Number(w) / 1e18);
const pA = px(ra0, ra1), pB = px(rb0, rb1);
const realSpread = (Math.max(pA, pB) / Math.min(pA, pB) - 1) * 100;
console.log(`[canary] realized prices: A=$${pA.toFixed(2)}/WETH B=$${pB.toFixed(2)}/WETH spread=${realSpread.toFixed(2)}%`);

// ------------------------------------------------------- registry + solve
const rpcPool = poolFor(chain);
const state = (p: string, dexId: string) =>
  registry.upsert({ address: p, chain: 'canary', dexId, kind: 'v2', token0: USDC, token1: WETH, symbol0: 'USDC', symbol1: 'WETH', dec0: 6, dec1: 18, feeBps: 30, liquidityUsd: USD_SIDE * 2 });
const pools = [state(pairA, 'uniswap'), state(pairB, 'sushiswap')];
await refreshPools(rpcPool, pools);
for (const p of pools) console.log(`[canary] ${p.dexId} ${p.address} r0=${p.reserve0} r1=${p.reserve1}`);

const sizeOf = (token: string, dec: number): bigint => {
  const px = token.toLowerCase() === WETH.toLowerCase() ? NATIVE_USD : 1;
  return (BigInt(Math.floor((cfg.FLASH_BORROW_USD / px) * 1e6)) * 10n ** BigInt(dec)) / 10n ** 6n;
};
const tokenUsd = new Map([[USDC.toLowerCase(), 1], [WETH.toLowerCase(), NATIVE_USD]]);
const block = await provider.getBlock('latest');
const opts = {
  gasUnits: 450_000n, baseFeeWei: block!.baseFeePerGas ?? 10n ** 9n, l1DataFeeWei: 0n,
  lane: 'predictive' as const, tokenUsd, sizeOf, nativeUsd: NATIVE_USD,
  priorityFeeWei: BigInt(Math.floor(cfg.PRIORITY_FEE_GWEI * 1e9)),
};

const scheduler = new VariantScheduler();
let cand: import('../../src/strategies/solver.js').Candidate | null = null;
for (const v of VARIANTS) {
  const c = solve(chain, v, opts);
  if (c.length) { cand = c.sort((a, b) => b.netUsd - a.netUsd)[0]; console.log(`[canary] candidate via ${v.id}: net $${cand.netUsd.toFixed(2)} spread ${cand.spreadPct.toFixed(2)}% borrow ${ethers.formatUnits(cand.borrowAmount, 6)} USDC`); break; }
  console.log(`[canary] ${v.id}: no candidate`);
}
if (!cand) { console.log('[canary] RESULT: no candidate — gate rejection (see counters)'); console.log(JSON.stringify(metrics.snapshot(), null, 1)); process.exit(2); }

// --------------------------------------------- real execute path (armed)
// measure realized profit in the ACTUAL borrow token, plus decode
// ArbSettled + gas used from the carrier tx receipt.
const balIface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const balOf = async (token: string) => BigInt(await provider.call({ to: token, data: balIface.encodeFunctionData('balanceOf', [EXECUTOR_DEPLOYED]) }));
const borrowDec = cand.legs[0].pool.token0.toLowerCase() === cand.borrowToken.toLowerCase() ? cand.legs[0].pool.dec0 : cand.legs[0].pool.dec1;
const borrowIsWeth = cand.borrowToken.toLowerCase() === WETH.toLowerCase();
const balBefore = await balOf(cand.borrowToken);
await executeCandidate(chain, rpcPool, cand, scheduler);
const balAfter = await balOf(cand.borrowToken);
const realizedToken = balAfter - balBefore;
const realizedUsd = (Number(realizedToken) / 10 ** borrowDec) * (borrowIsWeth ? NATIVE_USD : 1);
console.log(`[canary] executor ${borrowIsWeth ? 'WETH' : 'USDC'} delta: ${ethers.formatUnits(realizedToken, borrowDec)} = $${realizedUsd.toFixed(2)} (predicted net $${cand.netUsd.toFixed(2)})`);

const settled = ((metrics.snapshot() as { settled_records?: { txHash?: string }[] }).settled_records ?? []).at(-1);
if (settled?.txHash) {
  const rc = await provider.getTransactionReceipt(settled.txHash);
  const gasUsd = Number(rc!.gasUsed * (rc!.gasPrice ?? 0n)) / 1e18 * NATIVE_USD;
  console.log(`[canary] receipt ${settled.txHash} status=${rc!.status} gasUsed=${rc!.gasUsed} gasUsd~$${gasUsd.toFixed(2)}`);
  const arbEv = new ethers.Interface(['event ArbSettled(address indexed borrowToken, uint256 borrowed, uint256 profit)']);
  for (const l of rc!.logs) {
    try {
      const p = arbEv.parseLog(l as never);
      if (p) console.log(`[canary] ArbSettled: borrowed ${ethers.formatUnits(p.args.borrowed, borrowDec)} profit ${ethers.formatUnits(p.args.profit, borrowDec)} ${borrowIsWeth ? 'WETH' : 'USDC'} = $${(Number(p.args.profit) / 10 ** borrowDec * (borrowIsWeth ? NATIVE_USD : 1)).toFixed(2)}`);
    } catch { /* not ours */ }
  }
}

const snap = (metrics.snapshot() as { counters?: Record<string, number>; settled_records?: unknown[] });
console.log('[canary] counters:', Object.entries(snap.counters ?? {}).filter(([k]) => /probe|settled|submit|shadow|revert|diag/.test(k)).map(([k, v]) => `${k}=${v}`).join(' '));
console.log('[canary] settled_records:', JSON.stringify(snap.settled_records ?? []));
bundler.close();
anvil.kill();
process.exit(0);
