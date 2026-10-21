import { chainConfig, cfg } from '../src/config/index.js';
import { logger } from '../src/config/logger.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { fork_live_chain_state } from '../test/anvil/forkSim.js';
import { VariantScheduler } from '../src/engine/predictiveEngine.js';
import { solve } from '../src/strategies/solver.js';
import { refreshPools, resolveTokenDecimals } from '../src/feed/refresh.js';
import { topPools, poolsForTokens } from '../src/feed/dexscreener.js';
import { registry } from '../src/pools/registry.js';
import { breaker } from '../src/forensics/baitPool.js';
import { classifyMarketRegime } from '../src/engine/marketRegime.js';
import { nextVariant } from '../src/engine/strategyRouter.js';
import { emitSignal } from '../src/telemetry/signalSink.js';
import { metrics } from '../src/telemetry/metrics.js';
import { buildPlan } from '../src/exec/planBuilder.js';
import { pickFlashSource, flashPremium } from '../src/exec/flashVenues.js';
import { execute_fork_dry_run } from '../test/anvil/forkSim.js';
import { writeFileSync, mkdirSync } from 'node:fs';

/**
 * fork_window_sim — 5-minute live-state profit window (Item #15 feed).
 *
 * 1. Anvil fork pinned to live Alchemy state (upstream-capped CU/s —
 *    fork reads bill at the node layer, never hot-loops the key).
 * 2. Real discovered pool universe ingested, refreshed ON THE FORK —
 *    every reserve/quote is real chain state at the pinned block.
 * 3. Solver cycles for WINDOW_SECS; each profitable candidate's
 *    solver-net (already net of gas units × baseFee + flash premium)
 *    accrues. Zero transactions ever leave the fork.
 * 4. Extrapolator:
 *      simPerHourUsd  = accruedNet × (3600 / elapsedSecs)
 *      prodPerHourUsd = simPerHourUsd × LAND_RATE × SLIPPAGE_FACTOR
 *    LAND_RATE 0.30 — Flashbots bundle competition: honest share of
 *    sim-positive cycles that actually land on-chain.
 *    SLIPPAGE_FACTOR 0.85 — real-mempool execution decay vs. pinned
 *    fork-state quotes (price moves between observe and bundle).
 * 5. Writes data/projections.json every cycle — metricsServer merges it
 *    into /api/metrics so the dashboard renders both run-rates live.
 */

const log = logger('forkwin');

const WINDOW_SECS = Number(process.env.FORK_WINDOW_SECS ?? 300);
const LAND_RATE = 0.30;        // competitive bundle landing share
const SLIPPAGE_FACTOR = 0.85;  // production decay vs pinned-state quotes

const MAJORS: Record<string, string[]> = {
  eth: [
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
    '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
    '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
    '0x514910771AF9Ca656af840dff83E8264EcF986CA', // LINK
  ],
  bsc: [
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
    '0x55d398326f99059fF775485246999027B3197955', // USDT
    '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', // BTCB
    '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // ETH
    '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', // CAKE
  ],
  poly: [
    '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WPOL/WMATIC
    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC (native)
    '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e
    '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT
    '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
    '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', // WBTC
  ],
};

const TOKEN_USD: Record<string, number> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': cfg.NATIVE_USD,
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 1,
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 1,
  '0x6b175474e89094c44da98b954eedeac495271d0f': 1,
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 67_000,  // WBTC
  '0x514910771af9ca656af840dff83e8264ecf986ca': 12,      // LINK
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 600,     // WBNB
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 1,       // USDC.bsc
  '0x55d398326f99059ff775485246999027b3197955': 1,       // USDT.bsc
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 67_000, // BTCB
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': cfg.NATIVE_USD, // ETH.bsc
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': 2,       // CAKE
  '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 0.30,    // WPOL
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 1,       // USDC.poly
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 1,       // USDC.e
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 1,       // USDT.poly
  '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': cfg.NATIVE_USD, // WETH.poly
  '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': 67_000,  // WBTC.poly
};

/** Wrapped-native per chain — gas is priced in THIS chain's native USD. */
const WNATIVE: Record<string, string> = {
  eth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  bsc: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  poly: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  arb: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  op: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  base: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  linea: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  scroll: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  blast: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  avax: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
};
const nativeUsdFor = (key: string): number =>
  (WNATIVE[key] && TOKEN_USD[WNATIVE[key]]) || cfg.NATIVE_USD;
const topPoolQuery = (key: string) => (key === 'bsc' ? 'WBNB' : key === 'poly' ? 'WMATIC' : 'WETH');

const PROJ_FILE = 'data/projections.json';
function writeProjection(p: object) {
  mkdirSync('data', { recursive: true });
  writeFileSync(PROJ_FILE, JSON.stringify(p, null, 2));
}

async function main() {
  const chainKey = process.env.FORK_CHAIN ?? 'eth';
  const chain = chainConfig(chainKey);

  log.info(`fork_window_sim: ${chainKey} — ${WINDOW_SECS}s window starting`);
  const fork = await fork_live_chain_state({ chain: chainKey, upstreamCups: Number(process.env.FORK_CUPS ?? 60) });

  // pool bound to the LOCAL fork — RpcPool never applies the keyed-URL
  // gate (that lives in config collect()); anvil serves only "/" so the
  // URL stays bare localhost
  const forkChain = { ...chain, rpcUrls: [`http://127.0.0.1:8546`], fallbackRpcUrl: undefined, wssUrls: [] };
  const rpc = new RpcPool(forkChain);

  breaker.load(chainKey);
  const scheduler = new VariantScheduler();

  // two-hop discovered ingest — majors' pools expose counterparty tokens,
  // the top-liquidity counterparties expand the universe. Nothing is
  // hand-registered; every pool arrives via the feed.
  const majors = MAJORS[chainKey] ?? [];
  const hop1 = await poolsForTokens(chainKey, majors);
  for (const ref of hop1) if (!breaker.isConvicted(chainKey, ref.address)) registry.upsert(ref);
  const counterparties = new Map<string, number>(); // token -> best liq
  for (const p of hop1) {
    for (const t of [p.token0, p.token1]) {
      if (majors.includes(t)) continue;
      counterparties.set(t, Math.max(counterparties.get(t) ?? 0, p.liquidityUsd ?? 0));
    }
  }
  const crawlTokens = [...counterparties.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => t);
  log.info(`2-hop crawl: ${hop1.length} hop1 pools -> ${crawlTokens.length} counterparty tokens`);
  for (const ref of await poolsForTokens(chainKey, crawlTokens)) {
    if (!breaker.isConvicted(chainKey, ref.address)) registry.upsert(ref);
  }
  for (const ref of await topPools(chainKey, topPoolQuery(chainKey))) {
    if (!breaker.isConvicted(chainKey, ref.address)) registry.upsert(ref);
  }
  let tracked = registry.all(chainKey);
  log.info(`registry: ${tracked.length} discovered pools loaded for fork eval`);

  // decimals authority: resolve token0/token1 decimals ON-CHAIN before any
  // price math — feed metadata omits decimals => wrong 10^k scales corrupt
  // spot prices and convict legitimate pools (WETH=18 vs USDC=6)
  await resolveTokenDecimals(rpc, tracked).catch((e) => log.warn('decimals resolve', e));

  // first refresh on the fork — prune pools with no readable on-chain
  // state (aggregators/routers DexScreener lists that never expose
  // getReserves/slot0) so the solver only sees evaluable venues.
  // Two passes: the cold pass under the upstream CU throttle loses
  // transient subcalls; the retry hits anvil's cache + only fetches
  // missing slots, recovering pools that failed transport, not state.
  await refreshPools(rpc, tracked).catch((e) => log.warn('initial refresh', e));
  const stale = tracked.filter((p) => p.reserve0 === undefined && p.sqrtPriceX96 === undefined);
  if (stale.length) {
    await refreshPools(rpc, stale).catch((e) => log.warn('refresh retry', e));
  }
  // prune from the REGISTRY not just the tracked list — the regime
  // classifier reads registry.all(); pools left registered-but-stateless
  // count as 'stale' forever and pin illiquidFrac > 0.5 → ILLIQUID_CRASH
  // for the entire window regardless of the real tape.
  for (const p of tracked) {
    if (p.reserve0 === undefined && p.sqrtPriceX96 === undefined) {
      registry.remove(`${chainKey}:${p.address.toLowerCase()}`);
    }
  }
  tracked = registry.all(chainKey).filter((p) => p.reserve0 !== undefined || p.sqrtPriceX96 !== undefined);
  log.info(`post-refresh: ${tracked.length} evaluable pools on fork state`);

  const startedAt = Date.now();
  // per-run gate deltas — counters persist across runs in
  // metrics_counters.json, so snapshot at boot and report deltas only
  const gateBase = {
    detected: metrics.counterSum('total_detected_opportunities'),
    bait: metrics.counterSum('rejected_by_forensic_bait'),
    margin: metrics.counterSum('rejected_by_profit_margin'),
    probe: metrics.counterSum('passed_to_simulation_probe'),
  };
  const gateDeltas = () => ({
    total_detected_opportunities: metrics.counterSum('total_detected_opportunities') - gateBase.detected,
    rejected_by_forensic_bait: metrics.counterSum('rejected_by_forensic_bait') - gateBase.bait,
    rejected_by_profit_margin: metrics.counterSum('rejected_by_profit_margin') - gateBase.margin,
    passed_to_simulation_probe: metrics.counterSum('passed_to_simulation_probe') - gateBase.probe,
  });
  let cycles = 0, profitable = 0, accruedNetUsd = 0;
  const variantHits = new Map<string, number>();
  const variantNet = new Map<string, number>();
  const strategyHits = new Map<string, number>();
  const strategyNet = new Map<string, number>();
  // predictive = variant-scheduled solver lane; whale = whale-alert lane
  // (fork state has no live mempool — whale count is an honest zero)
  const laneCounts = { predictive: 0, whale: 0 };
  // execution truth gate: top winners go through a REAL exec() dry-run on
  // the fork — impersonated owner, live Balancer/flash state, minOut and
  // minProfit enforced by the contract. PASS = execution-ready, proven.
  let execAttempts = 0, execReady = 0;
  const execGate: Record<string, number> = {};

  const tick = async () => {
    cycles++;
    try {
      await refreshPools(rpc, tracked);
      const snap = classifyMarketRegime(chainKey);
      emitSignal(forkChain, { kind: 'regime', ...snap });
      const variant = nextVariant(scheduler, snap);

      const baseFeeWei = (await rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false])
        .then((b) => (b?.baseFeePerGas ? BigInt(b.baseFeePerGas) : 0n)).catch(() => 0n)) ?? 0n;
      const livePrio = await rpc.call<string>('eth_maxPriorityFeePerGas', [])
        .then((h) => BigInt(h)).catch(() => 0n);

      const candidates = solve(forkChain, variant, {
        gasUnits: 450_000n,
        baseFeeWei,
        regime: snap.regime,
        volBps: snap.volBps,
        tokenUsd: new Map(Object.entries(TOKEN_USD)),
        // USD-target sizing in the token's own decimals (1e18 raw units of
        // a 6-dec borrow = $1e12 notional — auto-dead at the impact gate)
        sizeOf: (token: string, dec: number) => {
          const px = TOKEN_USD[token.toLowerCase()] ?? 1;
          return (BigInt(Math.floor((cfg.FLASH_BORROW_USD / px) * 1e6)) * 10n ** BigInt(dec)) / 10n ** 6n;
        },
        nativeUsd: nativeUsdFor(chainKey),
        priorityFeeWei: livePrio > 0n ? livePrio : BigInt(Math.floor(cfg.PRIORITY_FEE_GWEI * 1e9)),
      });

      const winners = candidates.filter((c) => c.netUsd > 0);
      for (const c of winners) {
        profitable++;
        accruedNetUsd += c.netUsd;
        variantHits.set(c.variant.id, (variantHits.get(c.variant.id) ?? 0) + 1);
        variantNet.set(c.variant.id, (variantNet.get(c.variant.id) ?? 0) + c.netUsd);
        strategyHits.set(c.strategy, (strategyHits.get(c.strategy) ?? 0) + 1);
        strategyNet.set(c.strategy, (strategyNet.get(c.strategy) ?? 0) + c.netUsd);
        laneCounts.predictive++;
        emitSignal(forkChain, {
          kind: 'candidate', strategy: c.strategy, variant: c.variant.id,
          netUsd: c.netUsd, spreadPct: c.spreadPct, legs: c.legs.length,
          is_simulation: true, regime: snap.regime,
        });
      }

      // EXECUTION TRUTH GATE — top-3 winners run the real exec() payload
      // on the fork: impersonated smart-account owner -> executor contract
      // -> live flash venue + pools at the pinned block. PASS means the
      // candidate is execution-READY (proven, not asserted). All fork-local.
      for (const c of winners.slice(0, 3)) {
        if (!chain.executor) break;
        execAttempts++;
        const source = pickFlashSource(chainKey, c.borrowToken);
        const { execData } = buildPlan(c, {
          source, premium: flashPremium(source, c.borrowAmount), minProfit: c.minProfitToken,
        });
        const res = await execute_fork_dry_run(fork, {
          impersonate: cfg.SMART_ACCOUNT_ADDRESS, to: chain.executor, data: execData,
        });
        execGate[res.status] = (execGate[res.status] ?? 0) + 1;
        if (res.revertReason) {
          const rk = `${res.status}:${res.revertReason.slice(0, 60)}`;
          execGate[rk] = (execGate[rk] ?? 0) + 1;
        }
        if (res.status === 'PASS') {
          execReady++;
          log.info(`EXEC-READY ${c.strategy} ${c.variant.id} net=$${c.netUsd.toFixed(2)} gas=${res.gasUsed}`);
        } else {
          log.warn(`exec-gate ${res.status} ${c.strategy} ${c.variant.id} net=$${c.netUsd.toFixed(2)} reason=${res.revertReason ?? 'n/a'}`);
        }
      }

      const elapsed = (Date.now() - startedAt) / 1000;
      const simPerHourUsd = elapsed > 0 ? accruedNetUsd * (3600 / elapsed) : 0;
      const prodPerHourUsd = simPerHourUsd * LAND_RATE * SLIPPAGE_FACTOR;
      writeProjection({
        chain: chainKey, forkBlock: fork.block, windowSec: Math.round(elapsed),
        cycles, profitableCandidates: profitable, accruedNetUsd,
        simPerHourUsd, prodPerHourUsd, landRate: LAND_RATE, slippageFactor: SLIPPAGE_FACTOR,
        regime: snap.regime, pools: tracked.length, activeVariant: variant.id, ts: Date.now(),
        strategyHits: Object.fromEntries(strategyHits),
        strategyNetUsd: Object.fromEntries([...strategyNet].map(([k, v]) => [k, Number(v.toFixed(4))])),
        variantHits: Object.fromEntries(variantHits),
        variantNetUsd: Object.fromEntries([...variantNet].map(([k, v]) => [k, Number(v.toFixed(4))])),
        lanes: { ...laneCounts },
        execGate: { attempts: execAttempts, ready: execReady, ...execGate },
        forensicGates: gateDeltas(),
      });
      if (cycles % 5 === 0 || winners.length) {
        log.info(`cycle ${cycles} · ${tracked.length} pools · regime=${snap.regime} · winners=${winners.length} · net=$${accruedNetUsd.toFixed(2)} · sim/hr=$${simPerHourUsd.toFixed(2)} · prod/hr=$${prodPerHourUsd.toFixed(2)}`);
      }
    } catch (e) { log.warn('cycle fault', e); }
  };

  const timer = setInterval(tick, cfg.SCAN_INTERVAL_SECS * 1000);
  await tick();

  await new Promise((r) => setTimeout(r, WINDOW_SECS * 1000));
  clearInterval(timer);
  fork.kill();

  const elapsed = (Date.now() - startedAt) / 1000;
  const simPerHourUsd = accruedNetUsd * (3600 / elapsed);
  const prodPerHourUsd = simPerHourUsd * LAND_RATE * SLIPPAGE_FACTOR;

  console.log('\n════════ FORK WINDOW REPORT ════════');
  console.log(`chain: ${chainKey}   fork block: ${fork.block}   window: ${(elapsed / 60).toFixed(1)} min`);
  console.log(`cycles: ${cycles}   pools evaluated: ${tracked.length}   profitable candidates: ${profitable}`);
  console.log(`accrued sim net: $${accruedNetUsd.toFixed(4)}`);
  console.log(`Projected Per-Hour Profit (Simulation Mode): $${simPerHourUsd.toFixed(2)}`);
  console.log(`Projected Per-Hour Profit (Production Mode): $${prodPerHourUsd.toFixed(2)}  (land ${LAND_RATE} × slip ${SLIPPAGE_FACTOR})`);
  console.log('variant hits:', Object.fromEntries(variantHits));
  console.log('variant net $:', Object.fromEntries([...variantNet].map(([k, v]) => [k, v.toFixed(4)])));
  console.log('strategy hits:', Object.fromEntries(strategyHits));
  console.log('strategy net $:', Object.fromEntries([...strategyNet].map(([k, v]) => [k, v.toFixed(4)])));
  console.log('lanes — predictive:', laneCounts.predictive, ' whale:', laneCounts.whale, '(fork has no live mempool)');
  console.log('exec gate — attempts:', execAttempts, ' READY(PASS):', execReady, ' breakdown:', execGate);
  console.log('forensic gates (this run):', gateDeltas());
  console.log('════════════════════════════════════');
  process.exit(0);
}

main().catch((e) => { log.error('fork window failed', e); process.exit(1); });
