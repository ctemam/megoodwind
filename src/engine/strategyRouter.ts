import { ChainConfig } from '../config/index.js';
import { registry, PoolState } from '../pools/registry.js';
import { Variant, VARIANTS, VariantScheduler } from './predictiveEngine.js';
import { RegimeSnapshot } from './marketRegime.js';
import { emitSignal } from '../telemetry/signalSink.js';

/**
 * Strategy Router — conditions the 12-variant matrix on the market
 * regime before any solver evaluation, and routes whale-alpha signals
 * into cross-pair correlation checks.
 *
 * Family labels are ROUTING TAGS over parametric guards (V01..V12 are
 * slippage/depth/delay/size parameter sets, not named algos) — the
 * assignment follows each variant's parameter signature:
 *   MOMENTUM        — tight slippage + 1-block delay: ride the move
 *   MEAN_REVERSION  — wide slippage + multi-block delay: fade extremes
 *   STAT_ARB        — high minDepth: only deepest pools carry the quote
 *   CROSS_PAIR_VOL  — high pendIntensity: mempool-alpha variants
 *   MICROSTRUCTURE  — mid params: spread/skew capture
 */

export type VariantFamily =
  | 'MOMENTUM' | 'MEAN_REVERSION' | 'STAT_ARB' | 'CROSS_PAIR_VOL' | 'MICROSTRUCTURE';

export const VARIANT_FAMILY: Record<string, VariantFamily> = {
  V01: 'MOMENTUM',        // slip5, depth500k, 1blk — tightest trend rider
  V02: 'MOMENTUM',        // slip10, depth500k, 1blk
  V03: 'MICROSTRUCTURE',  // slip15, depth250k, 1blk
  V04: 'MEAN_REVERSION',  // slip20, depth250k, 2blk
  V05: 'STAT_ARB',        // slip15, depth100k, 1blk, mid size
  V06: 'MEAN_REVERSION',  // slip25, depth100k, 2blk
  V07: 'CROSS_PAIR_VOL',  // slip30, depth50k, 2blk, high pend
  V08: 'STAT_ARB',        // slip15, depth1M, 1blk — deepest-pool arb
  V09: 'CROSS_PAIR_VOL',  // slip40, depth25k, 3blk, high pend
  V10: 'MOMENTUM',        // slip10, depth750k, 1blk, big size
  V11: 'CROSS_PAIR_VOL',  // slip50, depth10k, 3blk, high pend — widest net
  V12: 'MICROSTRUCTURE',  // slip15, depth250k, 2blk
};

/** Regime → family eligibility. Hard constraints per the strategy spec:
 *  HIGH_VOL_TRENDING suppresses mean-reversion, scales momentum. */
const REGIME_GATE: Record<RegimeSnapshot['regime'], { suppress: VariantFamily[]; boost: VariantFamily[] }> = {
  HIGH_VOL_TRENDING: { suppress: ['MEAN_REVERSION'], boost: ['MOMENTUM', 'CROSS_PAIR_VOL'] },
  LOW_VOL_MEAN_REVERTING: { suppress: ['MOMENTUM', 'CROSS_PAIR_VOL'], boost: ['MEAN_REVERSION', 'STAT_ARB'] },
  ILLIQUID_CRASH: { suppress: ['CROSS_PAIR_VOL', 'MEAN_REVERSION', 'MOMENTUM', 'MICROSTRUCTURE'], boost: ['STAT_ARB'] },
  BALANCED: { suppress: [], boost: [] },
};

/** evaluate_predictive_variants — the conditioned variant set for this
 *  regime. ILLIQUID_CRASH additionally hard-floors depth ≥250k so a
 *  crisis tape can only quote the deepest pools. */
export function evaluatePredictiveVariants(snap: RegimeSnapshot): Variant[] {
  const gate = REGIME_GATE[snap.regime];
  return VARIANTS.filter((v) => {
    if (gate.suppress.includes(VARIANT_FAMILY[v.id])) return false;
    if (snap.regime === 'ILLIQUID_CRASH' && v.minDepthUsd < 250_000) return false;
    return true;
  });
}

/** Regime-conditioned variant pick — the scheduler keeps its
 *  settled-evidence rotation, but a suppressed variant is skipped
 *  (bounded walk over the matrix, never an infinite loop). */
export function nextVariant(scheduler: VariantScheduler, snap: RegimeSnapshot): Variant {
  const eligible = new Set(evaluatePredictiveVariants(snap).map((v) => v.id));
  for (let i = 0; i < VARIANTS.length; i++) {
    const v = scheduler.next();
    if (eligible.has(v.id)) return v;
  }
  return VARIANTS[0]; // unreachable unless every variant suppressed
}

/** route_whale_alpha_signal — a whale transfer into a watched token
 *  triggers an immediate cross-pair correlation check: the direct pools
 *  PLUS their peer venues (same pair, other DEX/fee tier) become the
 *  refresh set — a whale move reprices one venue first, the arb lives
 *  in the correlation gap to its peers. Returns the routing decision
 *  (also emitted to the signal sink for the verifier). */
export function routeWhaleAlphaSignal(
  chain: ChainConfig,
  tokenAddr: string,
  usd: number,
): { direct: PoolState[]; correlation: PoolState[] } {
  const token = tokenAddr.toLowerCase();
  const direct = registry.all(chain.key).filter(
    (p) => p.token0.toLowerCase() === token || p.token1.toLowerCase() === token,
  );
  const seen = new Set(direct.map((p) => `${p.chain}:${p.address.toLowerCase()}`));
  const correlation: PoolState[] = [];
  for (const p of direct) {
    for (const peer of registry.peers(chain.key, p.token0, p.token1)) {
      const key = `${peer.chain}:${peer.address.toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); correlation.push(peer); }
    }
  }
  emitSignal(chain, {
    kind: 'whale_alpha',
    token: tokenAddr,
    usd,
    direct_pools: direct.length,
    correlation_pools: correlation.length,
  });
  return { direct, correlation };
}
