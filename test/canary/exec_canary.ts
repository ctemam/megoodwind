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
const USDT = ethers.getAddress('0xdac17f958d2ee523a2206206994597c13d831ec7');
// canonical real pairs on this fork's mainnet — PAIR_EXISTS means the
// factories already route them; we skew liquidity, not the venue.
const PAIR_WETH_USDC_UNI = ethers.getAddress('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc');
const PAIR_WETH_USDC_SUSHI = ethers.getAddress('0x397FF1542f962076d0BFE58eA045FfA2d347ACa0');
const PAIR_USDC_USDT_UNI = ethers.getAddress('0x3041CbD36888bECc7bbCBc0045E3B1f144466f5f');
const PAIR_WETH_USDT_UNI = ethers.getAddress('0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852');
const TRI_MODE = process.argv.includes('--tri');

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
process.env.STRATEGIES = process.env.CANARY_STRATEGIES ?? 'P01';
process.env.DIAG_ONLY = process.env.DIAG_ONLY ?? '0'; // shell may pass 1 for diag runs
process.env.PRIORITY_FEE_GWEI = process.env.CANARY_PRIORITY_GWEI ?? '1'; // realistic tip, not the 5 gwei default
// WO-6 study knobs — never defaults: slip-column override for the
// *harness env only* and a variant whitelist to choose which guardrail binds.
if (process.env.CANARY_SLIP) {
  process.env.SLIPPAGE_BPS = process.env.CANARY_SLIP;
  process.env.SLIPPAGE_BASELINE_BPS = process.env.CANARY_SLIP;
  process.env.SLIPPAGE_LOW_VOL_BPS = process.env.CANARY_SLIP;
  process.env.SLIPPAGE_CEILING_BPS = String(Math.max(200, Number(process.env.CANARY_SLIP)));
}
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

// ARM check applies to the EXEC phase — DIAG_ONLY runs solve+diag rows
// then stops before executeCandidate (armedFor is correctly false then).
if (!armedFor(chain.chainId) && !cfg.DIAG_ONLY) throw new Error('canary chain not armed — abort');
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
// $25M per side default: the dynamic slippage bound (10bps at BALANCED)
// clips borrow to ~vIn×5e-4 — $600k pools cap borrow near $300 (gross <
// gas, the same starvation seen live). Study runs vary CANARY_DEPTH_USD.
const USD_SIDE = Number(process.env.CANARY_DEPTH_USD ?? 25_000_000);

// generic balance-write helpers — discover each token's balances-mapping
// slot by probing against balanceOf on the throwaway, then write exact
// pool balances + sync() so reserves are deterministic.
const ercIface = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
const tokBalOf = (token: string, a: string) =>
  provider.call({ to: token, data: ercIface.encodeFunctionData('balanceOf', [a]) }).then((r) => (r && r !== '0x' ? BigInt(r) : 0n));
const decOfTok = (token: string) =>
  provider.call({ to: token, data: ercIface.encodeFunctionData('decimals', []) }).then((r) => Number(BigInt(r)));
const setBal = async (token: string, slot: number, acct: string, amt: bigint) => {
  const sl = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [acct, slot]));
  await rpc('anvil_setStorageAt', [token, sl, ethers.zeroPadValue(ethers.toBeHex(amt), 32)]);
};
const findSlot = async (token: string, amt: bigint) => {
  for (let s = 0; s < 60; s++) {
    await setBal(token, s, eoa, amt);
    if ((await tokBalOf(token, eoa)) === amt) return s;
  }
  throw new Error(`${token} balances slot not found`);
};

const usdAmt = (BigInt(Math.floor(USD_SIDE)) * 10n ** 6n);
const wethFair = ethers.parseUnits((USD_SIDE / NATIVE_USD).toFixed(8), 18);
const wethSkew = ethers.parseUnits((USD_SIDE / (NATIVE_USD * (1 + SPREAD_PCT / 100))).toFixed(8), 18);

// market spec: token-balance writes per pair (fair side + skewed side).
// P01 lane: two WETH/USDC pools, B skewed. TRI lane: USDC/USDT 1:1 +
// WETH/USDT fair + WETH/USDC skewed → a P02 triangle exists.
const MARKET: { pair: string; writes: [string, bigint][] }[] = TRI_MODE
  ? [
      { pair: PAIR_USDC_USDT_UNI, writes: [[USDC, usdAmt], [USDT, usdAmt]] },
      { pair: PAIR_WETH_USDT_UNI, writes: [[USDT, usdAmt], [WETH, wethFair]] },
      { pair: PAIR_WETH_USDC_UNI, writes: [[USDC, usdAmt], [WETH, wethSkew]] },
    ]
  : [
      { pair: PAIR_WETH_USDC_UNI, writes: [[USDC, usdAmt], [WETH, wethFair]] },
      { pair: PAIR_WETH_USDC_SUSHI, writes: [[USDC, usdAmt], [WETH, wethSkew]] },
    ];

const slots = new Map<string, number>();
for (const t of [USDC, USDT]) {
  if (MARKET.some((m) => m.writes.some(([tk]) => tk === t))) {
    const s = await findSlot(t, usdAmt);
    slots.set(t, s);
    console.log(`[canary] ${t.slice(0, 8)}… balances slot = ${s}`);
  }
}
slots.set(WETH, 3); // WETH9 balanceOf mapping slot
for (const m of MARKET) for (const [tk, amt] of m.writes) await setBal(tk, slots.get(tk)!, m.pair, amt);

const pairAbi = ['function sync()', 'function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)', 'function token1() view returns (address)'];
const poolDefs: { pair: string; dexId: string; token0: string; token1: string; dec0: number; dec1: number; r0: bigint; r1: bigint }[] = [];
for (const m of MARKET) {
  const pc = new ethers.Contract(m.pair, pairAbi, wallet);
  await (await pc.sync()).wait();
  const [token0, token1, [r0, r1]] = await Promise.all([pc.token0(), pc.token1(), pc.getReserves()]);
  poolDefs.push({ pair: m.pair, dexId: 'univ2', token0, token1, dec0: await decOfTok(token0), dec1: await decOfTok(token1), r0, r1 });
  console.log(`[canary] ${m.pair} t0=${token0.slice(0, 10)} t1=${token1.slice(0, 10)} r0=${r0} r1=${r1}`);
}
// realized WETH price from the skewed pair vs the fair WETH/USDT leg
const pxW = (rUsd: bigint, rW: bigint, ud: number) => (Number(rUsd) / 10 ** ud) / (Number(rW) / 1e18);
console.log(`[canary] market wired (${TRI_MODE ? 'P02 triangle' : 'P01 pair'}), spread target ${SPREAD_PCT}%`);

// ------------------------------------------------------- registry + solve
const rpcPool = poolFor(chain);
const symOf = (t: string) => (t.toLowerCase() === WETH.toLowerCase() ? 'WETH' : t.toLowerCase() === USDT.toLowerCase() ? 'USDT' : 'USDC');
const pools = poolDefs.map((d) =>
  registry.upsert({ address: d.pair, chain: 'canary', dexId: d.dexId, kind: 'v2', token0: d.token0, token1: d.token1, symbol0: symOf(d.token0), symbol1: symOf(d.token1), dec0: d.dec0, dec1: d.dec1, feeBps: 30, liquidityUsd: USD_SIDE * 2 }));
await refreshPools(rpcPool, pools);
for (const p of pools) console.log(`[canary] ${p.dexId} ${p.address} r0=${p.reserve0} r1=${p.reserve1}`);

const sizeOf = (token: string, dec: number): bigint => {
  const px = token.toLowerCase() === WETH.toLowerCase() ? NATIVE_USD : 1;
  return (BigInt(Math.floor((cfg.FLASH_BORROW_USD / px) * 1e6)) * 10n ** BigInt(dec)) / 10n ** 6n;
};
const tokenUsd = new Map([[USDC.toLowerCase(), 1], [USDT.toLowerCase(), 1], [WETH.toLowerCase(), NATIVE_USD]]);
const block = await provider.getBlock('latest');
// flash-liquidity cap input for SIZING_MODE=optimal — the Balancer
// vault's real borrow-side balance on the fork (non-binding here but
// the cap path is exercised).
const BALANCER_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const balIface2 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const flashLiquidityRaw = BigInt(await provider.call({ to: WETH, data: balIface2.encodeFunctionData('balanceOf', [BALANCER_VAULT]) }));
console.log(`[canary] balancer vault WETH balance ${ethers.formatEther(flashLiquidityRaw)}`);
// WO-6: same live-priority logic as arbRunner — eth_maxPriorityFeePerGas,
// else CANARY_PRIORITY_GWEI (default 1 gwei, not the 5 gwei schema default).
const livePrio = await rpc('eth_maxPriorityFeePerGas', []).then(BigInt).catch(() => 0n);
const prioWei = livePrio > 0n ? livePrio : BigInt(Math.floor(Number(process.env.CANARY_PRIORITY_GWEI ?? 1) * 1e9));
console.log(`[canary] priorityFee=${(Number(prioWei) / 1e9).toFixed(2)} gwei (live=${livePrio > 0n})`);
const opts = {
  gasUnits: 450_000n, baseFeeWei: block!.baseFeePerGas ?? 10n ** 9n, l1DataFeeWei: 0n,
  lane: 'predictive' as const, tokenUsd, sizeOf, nativeUsd: NATIVE_USD,
  priorityFeeWei: prioWei,
  flashLiquidityRaw,
};

const scheduler = new VariantScheduler();
const snap0 = (metrics.snapshot() as { counters?: Record<string, number> }).counters ?? {};
const vPick = (process.env.CANARY_VARIANTS ?? '').split(',').filter(Boolean);
const variants = vPick.length ? VARIANTS.filter((v) => vPick.includes(v.id)) : VARIANTS;
console.log(`[canary] variants: ${variants.map((v) => v.id).join(',')} slipEnv=${process.env.CANARY_SLIP ?? 'default'}`);
let cand: import('../../src/strategies/solver.js').Candidate | null = null;
for (const v of variants) {
  const c = solve(chain, v, opts);
  if (c.length) {
    const top = c.sort((a, b) => b.netUsd - a.netUsd)[0];
    if (!cand || top.netUsd > cand.netUsd) cand = top;
    console.log(`[canary] ${v.id}: ${c.length} cand(s), best net $${top.netUsd.toFixed(2)}`);
  } else console.log(`[canary] ${v.id}: no candidate`);
}
if (cand) {
  const bd = cand.legs[0].pool.token0.toLowerCase() === cand.borrowToken.toLowerCase() ? cand.legs[0].pool.dec0 : cand.legs[0].pool.dec1;
  console.log(`[canary] candidate via ${cand.variant.id}: net $${cand.netUsd.toFixed(2)} gross $${cand.grossUsd.toFixed(2)} gas $${cand.gasUsd.toFixed(2)} spread ${cand.spreadPct.toFixed(2)}% impact ${cand.impactBps.toFixed(1)}bps borrow ${ethers.formatUnits(cand.borrowAmount, bd)} ${cand.borrowToken === WETH ? 'WETH' : 'USDC'} (mode=${cfg.SIZING_MODE})`);
}
if (!cand) {
  const snapR = (metrics.snapshot() as { counters?: Record<string, number> }).counters ?? {};
  const deltaR = Object.entries(snapR).map(([k, v]) => `${k}=${v - (snap0[k] ?? 0)}`).join(' ');
  console.log('[canary] RESULT: no candidate — gate rejection. counters (this run): ' + deltaR);
  process.exit(2);
}

// ---- WO-6 step 2: cap decomposition (same math emit uses) + theoretical
// closed-form gross maximum on the same legs, slippage bound OFF.
{
  const { inputVirtualReserveRaw } = await import('../../src/math/profit.js');
  const { legOut: legOutFn } = await import('../../src/strategies/solver.js');
  const { effectiveGuards } = await import('../../src/engine/predictiveEngine.js');
  const leg0 = cand.legs[0];
  const decB = leg0.pool.token0.toLowerCase() === cand.borrowToken.toLowerCase() ? leg0.pool.dec0 : leg0.pool.dec1;
  const pxB = cand.borrowToken.toLowerCase() === WETH.toLowerCase() ? NATIVE_USD : 1;
  const vIn = inputVirtualReserveRaw(leg0.pool, cand.borrowToken);
  const b = cand.slipBoundBps / cand.legs.length / 10_000;
  const slipMaxIn = vIn > 0 ? (Number(vIn) * b) / (1 - b) / (1 - leg0.pool.feeBps / 10_000) : 0;
  const borrowUsd = (x: bigint) => (Number(x) / 10 ** decB) * pxB;
  const caps = {
    sizeOf_usd: borrowUsd(sizeOf(cand.borrowToken, decB)),
    slipBound_bps: cand.slipBoundBps,
    slipMaxIn_usd: slipMaxIn * pxB / 10 ** decB,
    sizeCapUsd: effectiveGuards(cand.variant).sizeCapUsd,
    reserveFrac_usd: cfg.SIZING_MODE === 'optimal' ? Number(vIn) * cfg.OPTIMAL_RESERVE_FRAC / 10 ** decB * pxB : Infinity,
    flashLiqUsd: cfg.SIZING_MODE === 'optimal' ? Number(flashLiquidityRaw) / 10 ** decB * pxB : Infinity,
    chosen_usd: borrowUsd(cand.borrowAmount),
  };
  const binder = Object.entries(caps).filter(([k]) => /_usd|sizeCapUsd/.test(k)).sort((a, c) => a[1] - c[1])[0];
  console.log('[canary] caps:', JSON.stringify({ ...caps, binding: binder[0] }));
  // theoretical argmax gross — golden-section on gross(x) over [1, vIn]
  const grossAt = (x: bigint): number => {
    let out = x;
    for (const leg of cand!.legs) { out = legOutFn(leg.pool, out, leg.tokenIn); if (out <= 0n) return -Infinity; }
    return Number(out - x) / 10 ** decB * pxB;
  };
  let lo = 1, hi = Number(vIn), gx = 1;
  const INVPHI = 0.6180339887498949;
  let x1 = Math.floor(hi - (hi - lo) * INVPHI), x2 = Math.floor(hi - (hi - lo) * INVPHI * INVPHI);
  for (let i = 0; i < 60 && hi - lo > 8; i++) {
    const f1 = grossAt(BigInt(x1)), f2 = grossAt(BigInt(x2));
    if (f1 < f2) { lo = x1; x1 = x2; x2 = lo + Math.floor((hi - lo) * INVPHI); }
    else { hi = x2; x2 = x1; x1 = hi - Math.floor((hi - lo) * INVPHI); }
  }
  let bestG = -Infinity, bestX = 1n;
  for (const s of [lo, x1, x2, hi]) { const g = grossAt(BigInt(Math.max(1, s))); if (g > bestG) { bestG = g; bestX = BigInt(Math.max(1, s)); } }
  console.log(`[canary] theoretical argmax: gross_max=$${bestG.toFixed(2)} at borrow $${borrowUsd(bestX).toFixed(0)} (slip bound OFF)`);
}

// --------------------------------------------- real execute path (armed)
// measure realized profit in the ACTUAL borrow token, plus decode
// ArbSettled + gas used from the carrier tx receipt.
const balIface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const balOf = async (token: string) => BigInt(await provider.call({ to: token, data: balIface.encodeFunctionData('balanceOf', [EXECUTOR_DEPLOYED]) }));
const borrowDec = cand.legs[0].pool.token0.toLowerCase() === cand.borrowToken.toLowerCase() ? cand.legs[0].pool.dec0 : cand.legs[0].pool.dec1;
const borrowIsWeth = cand.borrowToken.toLowerCase() === WETH.toLowerCase();
if (cfg.DIAG_ONLY) { console.log('[canary] DIAG_ONLY — stopping before executeCandidate'); process.exit(0); }
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
const delta = Object.entries(snap.counters ?? {}).filter(([k]) => /probe|settled|submit|shadow|revert|diag|passed/.test(k)).map(([k, v]) => `${k}=${v - (snap0[k] ?? 0)}`).join(' ');
console.log('[canary] counters (this run):', delta);
console.log('[canary] settled_records:', JSON.stringify(snap.settled_records ?? []));
bundler.close();
anvil.kill();
process.exit(0);
