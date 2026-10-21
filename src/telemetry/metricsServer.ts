import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { cfg, activeChainConfigs } from '../config/index.js';
import { metrics } from './metrics.js';
import { registry } from '../pools/registry.js';
import { breaker } from '../forensics/baitPool.js';
import { logger } from '../config/logger.js';

/**
 * Item #15 — local metrics Express API feeding the Banbot dashboard.
 * Exposes bot performance, tx latency and P/L — P/L is settled-only.
 */

export function startMetricsServer(schedulerSnapshot: () => unknown): void {
  const app = express();
  const log = logger('metricsApi');

  app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  app.get('/api/metrics', (_req, res) => {
    // fork-window projections live on disk — written by fork_window_sim,
    // merged here so the dashboard surfaces both run-rates live
    let projections = null;
    if (existsSync('data/projections.json')) {
      try { projections = JSON.parse(readFileSync('data/projections.json', 'utf8')); } catch { }
    }
    res.json({
      ...metrics.snapshot(),
      projections,
      pools: Object.fromEntries(
        activeChainConfigs().map((c) => [c.key, registry.all(c.key).length]),
      ),
      convicted: Object.fromEntries(
        activeChainConfigs().map((c) => [c.key, breaker.convictions(c.key).length]),
      ),
      variants: schedulerSnapshot(),
      config: {
        autoExecute: cfg.AUTO_EXECUTE,
        minProfitUsd: cfg.MIN_PROFIT_USD,
        scanIntervalSecs: cfg.SCAN_INTERVAL_SECS,
        strategies: cfg.strategies,
        predictiveChains: cfg.predictiveChains,
        backrunChains: cfg.backrunChains,
      },
    });
  });

  app.listen(cfg.PORT, () => log.info(`metrics API on :${cfg.PORT}`));
}
