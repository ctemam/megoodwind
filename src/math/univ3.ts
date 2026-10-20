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

/** slot0() calldata + decoder. */
export const SLOT0_ABI = new ethers.Interface([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 obsIndex,uint16 obsCard,uint16 obsCardNext,uint8 feeProto,bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);
