import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import v8 from 'node:v8';
import { cfg } from '../config/index.js';
import { logger } from '../config/logger.js';
import { registry } from '../pools/registry.js';
import { breaker } from '../forensics/baitPool.js';
import { metrics } from './metrics.js';
import { regimeHistorySize } from '../engine/marketRegime.js';
import { pendingSetSizes } from '../scout/scoutListener.js';
import { rpcPoolStats } from '../providers/rpcPool.js';
import { wssLiveProviders } from '../providers/wss.js';
import { lastCycleMs, lastStageMs } from '../runner/arbRunner.js';

/**
 * WO-1 memory telemetry — the OOM evidence file.
 *
 * Every 30s appends one JSONL row to data/mem_telemetry.jsonl:
 *   process.memoryUsage() + the size of every module-level Map/Set/array
 *   known to grow (registry, breaker caches, metrics counters, regime
 *   rings, WSS dedupe sets, rpcPool state) + in-flight RPC count.
 *
 * Heap snapshots: --heapsnapshot-signal=SIGUSR2 does not exist on
 * Windows (SIGUSR* signals are POSIX-only), so snapshots are taken
 * programmatically via v8.writeHeapSnapshot at HEAP_SNAP_MINUTES marks
 * (default 5,15,25) — same artifact for dominator-tree analysis.
 */

const log = logger('memWatch');
const FILE = join(process.cwd(), 'data', 'mem_telemetry.jsonl');
const SNAP_DIR = join(process.cwd(), 'data', 'heapsnaps');

let started = false;

export function startMemWatch(): void {
  if (started || !cfg.MEM_WATCH) return;
  started = true;
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  mkdirSync(SNAP_DIR, { recursive: true });

  const t0 = Date.now();
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) log.warn('gc() not exposed — launch with --expose-gc for post-GC heap readings');
  const timer = setInterval(() => {
    // WO-1b: sample AFTER a forced GC — separates retained (leak) from
    // in-flight allocation churn that makes pre-GC heapUsed oscillate.
    try { gc?.(); } catch { /* flag absent */ }
    const mu = process.memoryUsage();
    const rpc = rpcPoolStats();
    const row = {
      ts: new Date().toISOString(),
      uptimeSec: Math.floor((Date.now() - t0) / 1000),
      rss: mu.rss,
      heapUsed: mu.heapUsed,
      heapTotal: mu.heapTotal,
      external: mu.external,
      arrayBuffers: mu.arrayBuffers,
      activeHandles: (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.().length ?? -1,
      sizes: {
        registryPools: registry.size,
        breakerPoolStats: breaker.poolStats.size,
        breakerConvicted: breaker.convictionCount(),
        breakerRepCache: breaker.repCacheSize(),
        breakerVolChecked: breaker.volCheckedSize(),
        metricsCounters: metrics.counterCount(),
        regimeHistory: regimeHistorySize(),
        wssPendingSets: pendingSetSizes(),
        wssLiveProviders: wssLiveProviders(),
        rpcInFlight: rpc.inFlight,
        rpcMaxInFlight: rpc.maxInFlight,
        lastCycleMs: Object.fromEntries(lastCycleMs),
        stageMs: Object.fromEntries(lastStageMs),
      },
    };
    try { appendFileSync(FILE, JSON.stringify(row) + '\n'); } catch { /* telemetry never wedges */ }
  }, 30_000);
  timer.unref();

  for (const m of cfg.HEAP_SNAP_MINUTES.split(',').map(Number).filter((n) => n > 0)) {
    setTimeout(() => {
      try {
        const f = v8.writeHeapSnapshot(join(SNAP_DIR, `heap_${m}min_${Date.now()}.heapsnapshot`));
        log.info(`heap snapshot written: ${f}`);
      } catch (e) {
        log.warn('heap snapshot failed', e);
      }
    }, m * 60_000).unref();
  }
  log.info(`memWatch on → ${FILE}; snaps @${cfg.HEAP_SNAP_MINUTES}min`);
}
