import { PoolState } from '../pools/registry.js';

/**
 * WO-9 / RESEARCH_BRIEF R1 — closed-form optimal size for constant-product
 * cycles. Any n-hop CP cycle collapses to (P,Q,R) in O(n):
 *   leg i: f(t) = (g_i * rOut_i) t / (rIn_i + g_i t)  →  (p,q,r) = (g rOut, rIn, g)
 *   compose (p1,q1,r1)·(p2,q2,r2) = (p1 p2, q1 q2, q2 r1 + p1 r2)
 * Profitable iff P > Q(1+phi); optimal input t* = (sqrt(P Q/(1+phi)) - Q)/R;
 * max gross = (sqrt(P) - sqrt(Q(1+phi)))^2 / R.
 * Architect verification: 980 random profitable cases vs brute force,
 * max relative error 5.6e-12 (test/sizing_test.ts reproduces).
 * Scope: v2-volatile legs only — v3 is piecewise across ticks (screening
 * search remains for mixed paths; exec-probe is the arbiter).
 */
export interface CycleSize {
  tStar: bigint;        // optimal input in borrow-token units
  maxGrossOut: number;  // f(t*) in borrow-token units (float, screening only)
  profitable: boolean;  // P > Q(1+phi)
}

export function closedFormCycle(
  legs: { pool: PoolState; tokenIn: string }[],
  phi = 0, // flash premium fraction on borrowed amount (AAVE=0.0009, else 0)
): CycleSize | null {
  let P = 1, Q = 1, R = 0;
  for (const leg of legs) {
    const p = leg.pool;
    if (p.kind !== 'v2' || p.stable || !p.reserve0 || !p.reserve1) return null;
    const inIs0 = leg.tokenIn.toLowerCase() === p.token0.toLowerCase();
    const rIn = Number(inIs0 ? p.reserve0 : p.reserve1);
    const rOut = Number(inIs0 ? p.reserve1 : p.reserve0);
    const g = (10_000 - (p.feeBps || 30)) / 10_000;
    const lp = g * rOut, lq = rIn, lr = g;
    // compose current cycle (P,Q,R) with this leg (lp,lq,lr):
    // R_new = q_leg*R_cycle + P_cycle*r_leg  (R1: q2*r1 + p1*r2)
    const Rnew = lq * R + P * lr;
    P = P * lp; Q = Q * lq; R = Rnew;
  }
  const qAdj = Q * (1 + phi);
  if (P <= qAdj || !Number.isFinite(P) || !Number.isFinite(Q) || !Number.isFinite(R) || R <= 0) {
    return { tStar: 0n, maxGrossOut: 0, profitable: false };
  }
  const sqP = Math.sqrt(P), sqQ = Math.sqrt(qAdj);
  const t = (Math.sqrt(P * Q / (1 + phi)) - Q) / R;
  const gross = (sqP - sqQ) ** 2 / R;
  if (!Number.isFinite(t) || t <= 0) return { tStar: 0n, maxGrossOut: gross, profitable: false };
  return { tStar: BigInt(Math.floor(t)), maxGrossOut: gross, profitable: true };
}
