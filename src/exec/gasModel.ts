import { PoolState } from '../pools/registry.js';

/**
 * Per-route gas model — WO-5 step 2.
 *
 * Replaces the single GAS_ESTIMATE_UNITS constant. Values are measured on
 * the WO-4 Anvil mainnet fork (test/exec-canary) via the real UserOp→
 * handleOps carrier; the table below is keyed `${legKind}x${legCount}`
 * with a flat fallback for unmeasured shapes. A safety margin
 * (GAS_MARGIN_BPS, default +10%) is applied on top.
 *
 * Where a fork probe (gasProbe) returns a live estimateGas for the exact
 * execData, the executor prefers it over this table.
 */

export interface LegShape {
  pool: Pick<PoolState, 'kind'>;
}

/** measured on fork, WO-5 step 2 (raw values in the WO-5 report):
 *  2-hop V2: 353,744 / 353,744 / 353,744 / 353,744 → 354k
 *  3-hop V2: 433,945 / 433,945 / 433,945 → 434k
 *  V3 legs:  unmeasured — conservative 60k/leg margin over v2 until the
 *            first v3 fork run lands. */
const TABLE: Record<string, bigint> = {
  'v2x2': 354_000n,
  'v2x3': 434_000n,
  'v3x2': 480_000n,
  'v3x3': 560_000n,
};
const FALLBACK = 620_000n; // > any measured shape — fail-expensive, not fail-open

const MIXED_KEY = (kinds: string[]) => (kinds.every((k) => k === 'v3') ? 'v3' : kinds.every((k) => k === 'v2') ? 'v2' : 'mixed');

export function routeGasUnits(legs: LegShape[], marginBps = 1000): bigint {
  const kinds = legs.map((l) => l.pool.kind);
  const key = `${MIXED_KEY(kinds)}x${legs.length}`;
  let base = TABLE[key];
  if (!base) {
    // mixed venue kinds — take the worst per-leg kind present
    base = kinds.includes('v3') ? TABLE[`v3x${legs.length}`] ?? FALLBACK : FALLBACK;
  }
  return (base * (10_000n + BigInt(marginBps))) / 10_000n;
}

export const GAS_TABLE = TABLE;
