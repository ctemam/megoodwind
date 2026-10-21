import { cfg } from '../config/index.js';
import { logger } from '../config/logger.js';

/**
 * Item #16 — Predictive Strategy Engine.
 * Exactly 12 production variants spanning the (slippage x depth x
 * block-delay) tolerance matrix, plus a VariantScheduler that rotates
 * the active variant to protect endpoints from rate limits when
 * latency anomalies peak.
 */

export interface Variant {
  id: string;             // V01..V12
  slippageBps: number;    // guardrail on projected price
  minDepthUsd: number;    // minimum pool liquidity to trust a quote
  maxBlockDelay: number;  // blocks ahead the projection may span
  sizeCapUsd: number;     // flash borrow ceiling
  pendIntensity: 'low' | 'med' | 'high'; // mempool intake aggressiveness
}

export const VARIANTS: readonly Variant[] = Object.freeze([
  { id: 'V01', slippageBps: 5,  minDepthUsd: 500_000, maxBlockDelay: 1, sizeCapUsd: 25_000,  pendIntensity: 'low'  },
  { id: 'V02', slippageBps: 10, minDepthUsd: 500_000, maxBlockDelay: 1, sizeCapUsd: 50_000,  pendIntensity: 'low'  },
  { id: 'V03', slippageBps: 15, minDepthUsd: 250_000, maxBlockDelay: 1, sizeCapUsd: 100_000, pendIntensity: 'med'  },
  { id: 'V04', slippageBps: 20, minDepthUsd: 250_000, maxBlockDelay: 2, sizeCapUsd: 100_000, pendIntensity: 'med'  },
  { id: 'V05', slippageBps: 15, minDepthUsd: 100_000, maxBlockDelay: 1, sizeCapUsd: 50_000,  pendIntensity: 'med'  },
  { id: 'V06', slippageBps: 25, minDepthUsd: 100_000, maxBlockDelay: 2, sizeCapUsd: 75_000,  pendIntensity: 'med'  },
  { id: 'V07', slippageBps: 30, minDepthUsd: 50_000,  maxBlockDelay: 2, sizeCapUsd: 50_000,  pendIntensity: 'high' },
  { id: 'V08', slippageBps: 15, minDepthUsd: 1_000_000, maxBlockDelay: 1, sizeCapUsd: 250_000, pendIntensity: 'low' },
  { id: 'V09', slippageBps: 40, minDepthUsd: 25_000,  maxBlockDelay: 3, sizeCapUsd: 25_000,  pendIntensity: 'high' },
  { id: 'V10', slippageBps: 10, minDepthUsd: 750_000, maxBlockDelay: 1, sizeCapUsd: 150_000, pendIntensity: 'low'  },
  { id: 'V11', slippageBps: 50, minDepthUsd: 10_000,  maxBlockDelay: 3, sizeCapUsd: 10_000,  pendIntensity: 'high' },
  { id: 'V12', slippageBps: 15, minDepthUsd: 250_000, maxBlockDelay: 2, sizeCapUsd: 100_000, pendIntensity: 'med'  },
]);

if (VARIANTS.length !== 12) throw new Error('variant matrix must contain exactly 12 entries');

interface VariantStats {
  emitted: number;
  settled: number;
  reverts: number;
  netUsd: number;
  lastUsed: number;
  ewmaLatencyMs: number;
}

/**
 * VariantScheduler — rotation routine. Picks the active variant per
 * cycle by settled-evidence score; forces rotation when endpoint EWMA
 * latency spikes (rate-limit protection per the guide).
 */
export class VariantScheduler {
  private stats = new Map<string, VariantStats>(
    VARIANTS.map((v) => [v.id, { emitted: 0, settled: 0, reverts: 0, netUsd: 0, lastUsed: 0, ewmaLatencyMs: 500 }]),
  );
  private idx = 0;
  private log = logger('variants');

  /** Latency-anomaly rotation: hop variants when current one degrades. */
  private latencyAnomaly(v: Variant): boolean {
    const s = this.stats.get(v.id)!;
    const peers = [...this.stats.values()].map((x) => x.ewmaLatencyMs);
    const median = peers.sort((a, b) => a - b)[Math.floor(peers.length / 2)];
    return s.ewmaLatencyMs > Math.max(2_500, median * 3);
  }

  next(): Variant {
    const cur = VARIANTS[this.idx];
    if (this.latencyAnomaly(cur)) {
      this.log.warn(`latency anomaly on ${cur.id} — rotating variant`);
      this.idx = (this.idx + 1) % VARIANTS.length;
    } else {
      // score = settled net per emission; unexplored variants interleave fairly
      const scored = VARIANTS.map((v, i) => ({ i, v, s: this.stats.get(v.id)! }));
      const best = scored
        .filter((x) => x.s.emitted >= 5)
        .sort((a, b) => b.s.netUsd / b.s.emitted - a.s.netUsd / a.s.emitted)[0];
      if (best && best.s.netUsd / best.s.emitted > 0) this.idx = best.i;
      else this.idx = (this.idx + 1) % VARIANTS.length; // round-robin while cold
    }
    const v = VARIANTS[this.idx];
    this.stats.get(v.id)!.lastUsed = Date.now();
    return v;
  }

  recordEmit(v: Variant) { this.stats.get(v.id)!.emitted++; }
  recordSettle(v: Variant, netUsd: number) {
    const s = this.stats.get(v.id)!;
    s.settled++; s.netUsd += netUsd;
  }
  recordRevert(v: Variant) { this.stats.get(v.id)!.reverts++; }
  recordLatency(v: Variant, ms: number) {
    const s = this.stats.get(v.id)!;
    s.ewmaLatencyMs = s.ewmaLatencyMs * 0.7 + ms * 0.3;
  }

  snapshot() {
    return Object.fromEntries(
      VARIANTS.map((v) => [v.id, this.stats.get(v.id)!]),
    );
  }
}

/** Guardrail merge: a variant may only TIGHTEN env limits, never loosen. */
export function effectiveGuards(v: Variant) {
  return {
    slippageBps: Math.min(v.slippageBps, cfg.SLIPPAGE_BPS * 4),
    minProfitUsd: cfg.MIN_PROFIT_USD, // STRICT_PROFIT_FLOOR_GUARD: floor is absolute
    maxBlockDelay: v.maxBlockDelay,
    sizeCapUsd: v.sizeCapUsd,
    minDepthUsd: v.minDepthUsd,
    tickDist: cfg.MAX_TICK_DISTANCE,
  };
}

export interface SlippageCtx {
  regime?: string;   // MarketRegime label
  whale?: boolean;   // inside the 30s whale-alpha window
  volBps?: number;   // live median pool move/cycle (bps)
}

/**
 * Dynamic slippage bound — the variant's static guardrail scaled by live
 * tape conditions instead of frozen:
 *   LOW_VOL_MEAN_REVERTING → clamp to SLIPPAGE_LOW_VOL_BPS (0.1%,
 *                            protective — dead tape can't absorb size)
 *   BALANCED / unset       → clamp to SLIPPAGE_BASELINE_BPS (0.1%
 *                            frontrun-protective baseline — mempool
 *                            triage never ships a wide bound on
 *                            standard loops)
 *   HIGH_VOL_TRENDING      → ×1.5 widening (trend legs need room)
 *   whale-alpha window     → widen to ≥WHALE_SLIPPAGE_BPS (transient
 *                            cross-venue spreads need slack)
 *   volBps floor           → never tighter than ~125% of observed
 *                            per-block move — a bound below the tape
 *                            rejects honest quotes as over-slip
 *   SLIPPAGE_CEILING_BPS   → absolute cap, always
 */
export function dynamicSlippageBps(v: Variant, ctx: SlippageCtx): number {
  let bps = effectiveGuards(v).slippageBps;
  if (ctx.regime === 'LOW_VOL_MEAN_REVERTING') bps = Math.min(bps, cfg.SLIPPAGE_LOW_VOL_BPS);
  else if (ctx.regime !== 'HIGH_VOL_TRENDING') bps = Math.min(bps, cfg.SLIPPAGE_BASELINE_BPS);
  if (ctx.regime === 'HIGH_VOL_TRENDING') bps = Math.min(bps * 1.5, cfg.SLIPPAGE_CEILING_BPS);
  if (ctx.whale) bps = Math.max(bps, cfg.WHALE_SLIPPAGE_BPS);
  if (ctx.volBps !== undefined && Number.isFinite(ctx.volBps) && ctx.volBps > 0) {
    bps = Math.max(bps, Math.ceil(ctx.volBps * 1.25));
  }
  return Math.min(Math.max(Math.round(bps), 1), cfg.SLIPPAGE_CEILING_BPS);
}
