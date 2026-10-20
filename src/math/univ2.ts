/// Item #19 math toolkit — UniV2-style constant-product quoting.

export interface V2Reserves {
  reserveIn: bigint;
  reserveOut: bigint;
}

/** getAmountOut with pool fee in bps (30 = 0.3%). */
export function v2AmountOut(amountIn: bigint, r: V2Reserves, feeBps: number): bigint {
  if (amountIn <= 0n || r.reserveIn <= 0n || r.reserveOut <= 0n) return 0n;
  const inAfterFee = amountIn * BigInt(10_000 - feeBps);
  return (inAfterFee * r.reserveOut) / (r.reserveIn * 10_000n + inAfterFee);
}

/** Exact-input spot price of tokenIn in tokenOut units, adjusted for decimals. */
export function v2SpotPrice(r: V2Reserves, inDecimals: number, outDecimals: number): number {
  if (r.reserveIn <= 0n) return 0;
  return (Number(r.reserveOut) / 10 ** outDecimals) / (Number(r.reserveIn) / 10 ** inDecimals);
}
