import { activeChainConfigs, cfg, ChainConfig } from '../config/index.js';
import { logger } from '../config/logger.js';
import { poolFor, RpcPool } from '../providers/rpcPool.js';
import { ScoutListener } from '../scout/scoutListener.js';
import { WhaleTracker } from '../services/whaleTracker.js';
import { VariantScheduler } from '../engine/predictiveEngine.js';
import { solve } from '../strategies/solver.js';
import { executeCandidate } from '../exec/executor.js';
import { refreshPools, resolveTokenDecimals } from '../feed/refresh.js';
import { topPools, poolsForTokens } from '../feed/dexscreener.js';
import { registry } from '../pools/registry.js';
import { breaker } from '../forensics/baitPool.js';
import { metrics } from '../telemetry/metrics.js';
import { startMetricsServer } from '../telemetry/metricsServer.js';
import { Discovery } from '../discovery/discovery.js';
import { classifyMarketRegime } from '../engine/marketRegime.js';
import { nextVariant, routeWhaleAlphaSignal } from '../engine/strategyRouter.js';
import { emitSignal } from '../telemetry/signalSink.js';
import { isOpStack, l1DataFeeWei, l1FeeScalars } from '../providers/l1Fee.js';
import { writeFileSync, mkdirSync } from 'node:fs';

/**
 * arb-runner — primary orchestration loop.
 * Per cycle per chain:
 *   ingest leaders (DexScreener batch) -> CPU-eval ALL candidates ->
 *   ONE merged refresh -> solve -> verify -> submit loop.
 * Whale pipe feeds targeted refreshes into the same loop.
 */

const log = logger('runner');

// deterministic borrow sizing per asset class (borrowToken -> units)
const SIZE_TABLE: Record<string, bigint> = {
  default: 10n ** 18n, // 1 whole token — net check does the real gating
};

const MAJORS: Record<string, string[]> = {
  eth: [
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
    '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
  ],
  bsc: [
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
    '0x55d398326f99059fF775485246999027B3197955', // USDT
  ],
  poly: [
    '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC
    '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT
  ],
};

const TOKEN_USD: Record<string, number> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': cfg.NATIVE_USD,
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 600,
  '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 0.30,
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 1,
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 1,
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 1,
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 1,
  '0x55d398326f99059ff775485246999027b3197955': 1,
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 1,
  '0x6b175474e89094c44da98b954eedeac495271d0f': 1,
};

async function ingest(chain: ChainConfig) {
  // leader scan: batched token->pairs on the majors (1 call / 30 addrs)
  const majors = MAJORS[chain.key] ?? [];
  if (majors.length) {
    for (const ref of await poolsForTokens(chain.key, majors)) {
      if (!breaker.isConvicted(chain.key, ref.address)) registry.upsert(ref);
    }
  }
  // top pools — one query per chain
  for (const ref of await topPools(chain.key, chain.key === 'bsc' ? 'WBNB' : 'WETH')) {
    if (!breaker.isConvicted(chain.key, ref.address)) registry.upsert(ref);
  }
}

async function cycle(
  chain: ChainConfig,
  rpc: RpcPool,
  scheduler: VariantScheduler,
  discovery: Discovery,
): Promise<void> {
  // Discovery phase: pull newly deployed pools (bounded, skips same-block)
  await discovery.scanNewPools().catch((e) => log.debug(`${chain.key} scanNewPools`, e));

  // ONE merged refresh across ALL tracked pools — graph edges need live
  // state before CPU-eval (latency discipline: never per-item RPC).
  const tracked = registry.all(chain.key);
  if (!tracked.length) return;

  // decimals authority: feed metadata omits decimals => 10^k scale
  // corruption convicts legitimate pools; resolve ON-CHAIN (incremental —
  // already-resolved tokens skip the multicall entirely)
  await resolveTokenDecimals(rpc, tracked).catch((e) => log.debug(`${chain.key} decimals`, e));

  await refreshPools(rpc, tracked);

  // Conditioning layer: the regime snapshot gates variant eligibility
  // BEFORE the scheduler picks — suppressed families never evaluate.
  const snap = classifyMarketRegime(chain.key);
  emitSignal(chain, { kind: 'regime', ...snap });
  const variant = nextVariant(scheduler, snap);

  const baseFeeWei = (await rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false])
    .then((b) => (b?.baseFeePerGas ? BigInt(b.baseFeePerGas) : 0n))
    .catch(() => 0n)) ?? 0n;

  // OP-Stack dual-gas: L2 execution + L1 data availability (blob market).
  // Executor calldata is ~1.5KB worst-case; the oracle charges per nonzero
  // byte so this estimate is conservative. Scalars publish to the cockpit.
  let l1Fee = 0n;
  if (isOpStack(chain.key)) {
    l1Fee = await l1DataFeeWei(rpc, 1_536).catch(() => 0n);
    const sc = await l1FeeScalars(rpc).catch(() => null);
    if (sc) {
      try {
        mkdirSync('data', { recursive: true });
        writeFileSync(`data/l1_oracle_${chain.key}.json`, JSON.stringify({
          l1BaseFeeWei: sc.l1BaseFeeWei.toString(),
          blobBaseFeeWei: sc.blobBaseFeeWei.toString(),
          baseFeeScalar: sc.baseFeeScalar,
          blobBaseFeeScalar: sc.blobBaseFeeScalar,
          l1DataFeeWei: l1Fee.toString(),
          at: sc.at,
        }, null, 2));
      } catch { /* telemetry best-effort */ }
    }
  }

  const candidates = solve(chain, variant, {
    gasUnits: 450_000n,
    baseFeeWei,
    l1DataFeeWei: l1Fee,
    tokenUsd: new Map(Object.entries(TOKEN_USD)),
    sizeOf: () => SIZE_TABLE.default,
  });
  if (!candidates.length) return;

  // submit loop — best candidate first, probe gates each
  for (const cand of candidates.slice(0, 3)) {
    await executeCandidate(chain, rpc, cand, scheduler);
  }
}

async function main() {
  const chains = activeChainConfigs();
  for (const c of chains) breaker.load(c.key);

  const rpcs = new Map<string, RpcPool>(chains.map((c) => [c.key, poolFor(c)]));
  const scheduler = new VariantScheduler();

  const scout = new ScoutListener(chains, rpcs);
  const lastWhaleUsd = new Map<string, number>(); // chain:token -> usd size of latest alert
  const whale = new WhaleTracker(chains, rpcs, (chain, tokenAddr, usd) => {
    log.info(`whale transfer $${usd.toFixed(0)} on ${chain.key} -> targeted refresh`, { tokenAddr });
    lastWhaleUsd.set(`${chain.key}:${tokenAddr.toLowerCase()}`, usd);
    scout.requestTargetedRefresh(chain, tokenAddr);
    metrics.inc('whale_hits_total', { chain: chain.key });
  });
  scout.on('whale', async (chain: ChainConfig, _token: string) => {
    // whale alpha routing: direct pools + cross-pair correlation venues
    // (same pair, other DEX/fee tier) — the arb lives in the gap.
    const usd = lastWhaleUsd.get(`${chain.key}:${_token.toLowerCase()}`) ?? 0;
    const { direct, correlation } = routeWhaleAlphaSignal(chain, _token, usd);
    const refreshSet = [...direct, ...correlation];
    if (refreshSet.length) await refreshPools(rpcs.get(chain.key)!, refreshSet);
  });

  await scout.start();
  await whale.start();
  startMetricsServer(() => scheduler.snapshot());

  // Discovery phase — on-chain factory matrix + token lists per chain
  const discoveries = new Map<string, Discovery>(
    chains.map((c) => [c.key, new Discovery(c, rpcs.get(c.key)!)]),
  );
  for (const c of chains) {
    const d = discoveries.get(c.key)!;
    await d.boot().catch((e) => log.warn(`${c.key} discovery boot`, e));
    d.startLoop();
  }

  // DexScreener enrichment (liquidity/price metadata — NOT pool discovery)
  for (const c of chains) await ingest(c).catch((e) => log.warn(`${c.key} ingest`, e));
  log.info(`registry: ${chains.map((c) => `${c.key}=${registry.all(c.key).length}`).join(' ')}`);

  const running = new Set<string>();
  const tick = async (c: ChainConfig) => {
    if (running.has(c.key)) return;
    running.add(c.key);
    try { await cycle(c, rpcs.get(c.key)!, scheduler, discoveries.get(c.key)!); }
    catch (e) { log.error(`${c.key} cycle`, e); }
    finally { running.delete(c.key); }
  };

  for (const c of chains) {
    setInterval(() => void tick(c), cfg.SCAN_INTERVAL_SECS * 1000);
  }
  scout.on('head', (c: ChainConfig) => void tick(c));

  const shutdown = async () => {
    for (const d of discoveries.values()) d.stop();
    await scout.stop();
    whale.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error('fatal', e);
  process.exit(1);
});
