import { ethers } from 'ethers';

/// Item #19 math toolkit — UniV3 slot0 math + tick-distance guard
/// (MAX_TICK_DISTANCE=200 per ToR §2: skip legs whose swap crosses
/// >200 ticks where the tick-walk approximation error bound breaks).

const Q96 = 2n ** 96n;

export interface V3State {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

export function tickFromSqrt(sqrtPriceX96: bigint): number {
  // ln(p)/ln(1.0001) where p = (sqrt/2^96)^2 — float ok for guard purposes
  const p = Number(sqrtPriceX96) / Number(Q96);
  if (p <= 0) return 0;
  return Math.floor(Math.log(p * p) / Math.log(1.0001));
}

/** Spot price token0->token1 (decimal-adjusted). */
export function v3SpotPrice(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const p = Number(sqrtPriceX96) / Number(Q96);
  const raw = p * p; // token1 per token0, raw units
  return raw * 10 ** (dec0 - dec1);
}

/** Guard from env: skip leg if projected swap crosses too many ticks. */
export function tickDistanceOk(tickBefore: number, tickAfter: number, maxDist: number): boolean {
  return Math.abs(tickAfter - tickBefore) <= maxDist;
}

/**
 * WO-9/audit — exact single-tick v3 output (no tick crossing).
 * zeroForOne: selling token0 pushes sqrtP down:
 *   inv_new = 1/sqrtP + amtInNet/L  →  s_new = s·L·Q96 / (L·Q96 + amtInNet·s)
 *   out1 = L·(s − s_new)/Q96
 * oneForZero: buying token0 pushes sqrtP up:
 *   s_new = s + amtInNet·Q96/L
 *   out0 = L·(1/s − 1/s_new) = L·Q96·(s_new−s)/(s·s_new)
 * Crosses a tick => real output is strictly LOWER — this is a tight
 * upper bound that kills the spot-price phantom edge the audit found.
 */
export function v3AmountOutInTick(
  sqrtPriceX96: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean, feeBps: number,
): bigint {
  if (!sqrtPriceX96 || !liquidity || amountIn <= 0n) return 0n;
  const s = sqrtPriceX96, L = liquidity;
  const amtInNet = amountIn * BigInt(10_000 - feeBps) / 10_000n;
  if (zeroForOne) {
    const sNew = (s * L * Q96) / (L * Q96 + amtInNet * s);
    if (sNew >= s) return 0n;
    return (L * (s - sNew)) / Q96;
  }
  const sNew = s + (amtInNet * Q96) / L;
  if (sNew <= s) return 0n;
  return (L * Q96 * (sNew - s)) / (s * sNew);
}

/** slot0() calldata + decoder. */
export const SLOT0_ABI = new ethers.Interface([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 obsIndex,uint16 obsCard,uint16 obsCardNext,uint8 feeProto,bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);
