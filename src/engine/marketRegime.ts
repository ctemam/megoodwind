import { ChainKey } from '../config/index.js';
import { registry, PoolState } from '../pools/registry.js';

/**
 * Market Regime Classifier — the conditioning layer the strategy router
 * consumes BEFORE any variant evaluation.
 *
 * Signals are computed from live registry state, never hardcoded:
 *   volBps       — median |Δ price bps| across sampled pools between calls
 *   trendScore   — directional consistency: Σsign(Δ)|Δ| / Σ|Δ|
 *                  (~1 = trending, ~0 = mean-reverting chop)
 *   illiquidFrac — share of pools with stale/missing state or zero depth
 *
 * Price probe: v3 = sqrtPriceX96 ratio, v2 = reserve0/reserve1 ratio —
 * both normalized to a unitless per-pool price series (ring buffer).
 */

export type MarketRegime =
  | 'HIGH_VOL_TRENDING'
  | 'LOW_VOL_MEAN_REVERTING'
  | 'ILLIQUID_CRASH'
  | 'BALANCED';

export interface RegimeSnapshot {
  chain: ChainKey;
  regime: MarketRegime;
  volBps: number;
  trendScore: number;      // -1..1
  illiquidFrac: number;    // 0..1
  poolsSampled: number;
  at: number;
}

// thresholds — conservative bounds on 8–12s sampling cadence
const VOL_HIGH_BPS = 25;      // median move/cycle above this = high-vol tape
const VOL_LOW_BPS = 3;        // below = dead tape, mean-reversion dominates
const TREND_MIN = 0.35;       // directional consistency to call a trend
const ILLIQUID_FRAC = 0.5;    // half the universe stale = crisis regime
const HISTORY = 32;           // per-pool price ring depth
const STALE_MS = 120_000;     // pool state older than this counts illiquid

const history = new Map<string, number[]>(); // chain:pool -> price ring

/** memWatch sampler — total retained ring entries across all pools. */
export function regimeHistorySize(): number {
  let n = 0;
  for (const r of history.values()) n += r.length;
  return n;
}

function spotPrice(p: PoolState): number | null {
  if (p.kind === 'v3') {
    if (!p.sqrtPriceX96 || p.sqrtPriceX96 === 0n) return null;
    // (sqrt/2^96)^2 — unitless; only deltas matter, decimals cancel.
    // Guard Infinity/NaN — extreme-price pairs would otherwise poison
    // the median (observed as trendScore:null in signal JSON)
    const x = Number(p.sqrtPriceX96) / 2 ** 96;
    const px = x * x;
    return Number.isFinite(px) && px > 0 ? px : null;
  }
  if (!p.reserve0 || !p.reserve1 || p.reserve0 === 0n) return null;
  // normalize reserves by decimals so cross-pool series are comparable
  const px = (Number(p.reserve1) / 10 ** p.dec1) / (Number(p.reserve0) / 10 ** p.dec0);
  return Number.isFinite(px) && px > 0 ? px : null;
}

const median = (xs: number[]) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;

/** classify_market_regime — snapshot the regime from current pool state.
 *  Call once per solver cycle AFTER refreshPools so deltas are fresh. */
export function classifyMarketRegime(chain: ChainKey): RegimeSnapshot {
  const pools = registry.all(chain);
  const deltas: number[] = [];   // signed bps moves per pool
  const absMoves: number[] = [];
  let stale = 0;
  const now = Date.now();

  for (const p of pools) {
    const key = `${chain}:${p.address.toLowerCase()}`;
    const px = spotPrice(p);
    const fresh = px !== null && now - p.updatedAt < STALE_MS;
    if (!fresh) { stale++; continue; }

    const ring = history.get(key) ?? [];
    if (ring.length) {
      const prev = ring[ring.length - 1];
      if (prev > 0 && px! > 0) {
        const d = ((px! - prev) / prev) * 10_000; // bps
        if (Number.isFinite(d)) {
          deltas.push(d);
          absMoves.push(Math.abs(d));
        }
      }
    }
    ring.push(px!);
    if (ring.length > HISTORY) ring.shift();
    history.set(key, ring);
  }

  const rawVol = median(absMoves);
  const rawTrend = absMoves.length
    ? Math.abs(deltas.reduce((s, d) => s + Math.sign(d) * Math.abs(d), 0)) / absMoves.reduce((s, d) => s + d, 0)
    : 0;
  // finite guards — a NaN/Inf signal must degrade to 0, never serialize
  // as null or silently skew the regime branch
  const volBps = Number.isFinite(rawVol) ? rawVol : 0;
  const trendScore = Number.isFinite(rawTrend) ? rawTrend : 0;
  const illiquidFrac = pools.length ? stale / pools.length : 1;

  let regime: MarketRegime = 'BALANCED';
  if (illiquidFrac > ILLIQUID_FRAC) regime = 'ILLIQUID_CRASH';
  else if (volBps >= VOL_HIGH_BPS && trendScore >= TREND_MIN) regime = 'HIGH_VOL_TRENDING';
  else if (volBps <= VOL_LOW_BPS) regime = 'LOW_VOL_MEAN_REVERTING';

  return { chain, regime, volBps, trendScore, illiquidFrac, poolsSampled: deltas.length, at: now };
}
