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
  ],
};

const TOKEN_USD: Record<string, number> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': cfg.NATIVE_USD,
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 1,
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 1,
  '0x6b175474e89094c44da98b954eedeac495271d0f': 1,
};

const PROJ_FILE = 'data/projections.json';
function writeProjection(p: object) {
  mkdirSync('data', { recursive: true });
  writeFileSync(PROJ_FILE, JSON.stringify(p, null, 2));
}

async function main() {
  const chainKey = (process.env.FORK_CHAIN ?? 'eth') as 'eth';
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
  for (const ref of await topPools(chainKey, 'WETH')) {
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
  // getReserves/slot0) so the solver only sees evaluable venues
  await refreshPools(rpc, tracked).catch((e) => log.warn('initial refresh', e));
  tracked = tracked.filter((p) => p.reserve0 !== undefined || p.sqrtPriceX96 !== undefined);
  log.info(`post-refresh: ${tracked.length} evaluable pools on fork state`);

  const startedAt = Date.now();
  let cycles = 0, profitable = 0, accruedNetUsd = 0;
  const variantHits = new Map<string, number>();

  const tick = async () => {
    cycles++;
    try {
      await refreshPools(rpc, tracked);
      const snap = classifyMarketRegime(chainKey);
      emitSignal(forkChain, { kind: 'regime', ...snap });
      const variant = nextVariant(scheduler, snap);

      const baseFeeWei = (await rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false])
        .then((b) => (b?.baseFeePerGas ? BigInt(b.baseFeePerGas) : 0n)).catch(() => 0n)) ?? 0n;

      const candidates = solve(forkChain, variant, {
        gasUnits: 450_000n,
        baseFeeWei,
        tokenUsd: new Map(Object.entries(TOKEN_USD)),
        sizeOf: () => 10n ** 18n,
      });

      const winners = candidates.filter((c) => c.netUsd > 0);
      for (const c of winners) {
        profitable++;
        accruedNetUsd += c.netUsd;
        variantHits.set(c.variant.id, (variantHits.get(c.variant.id) ?? 0) + 1);
        emitSignal(forkChain, {
          kind: 'candidate', strategy: c.strategy, variant: c.variant.id,
          netUsd: c.netUsd, spreadPct: c.spreadPct, legs: c.legs.length,
          is_simulation: true, regime: snap.regime,
        });
      }

      const elapsed = (Date.now() - startedAt) / 1000;
      const simPerHourUsd = elapsed > 0 ? accruedNetUsd * (3600 / elapsed) : 0;
      const prodPerHourUsd = simPerHourUsd * LAND_RATE * SLIPPAGE_FACTOR;
      writeProjection({
        chain: chainKey, forkBlock: fork.block, windowSec: Math.round(elapsed),
        cycles, profitableCandidates: profitable, accruedNetUsd,
        simPerHourUsd, prodPerHourUsd, landRate: LAND_RATE, slippageFactor: SLIPPAGE_FACTOR,
        regime: snap.regime, pools: tracked.length, ts: Date.now(),
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
  console.log('════════════════════════════════════');
  process.exit(0);
}

main().catch((e) => { log.error('fork window failed', e); process.exit(1); });
