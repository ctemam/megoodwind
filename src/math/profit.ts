import { cfg } from '../config/index.js';

/**
 * Item #19 — strict profit-constraint math.
 * net_usd = gross_token_usd - (gas_native + flash_premium + auction_bribe) * native_usd
 * EIP-1559: effective gas price = baseFee + priorityFee (Items #1).
 * AUCTION_CHAINS (eth): deduct worst-case builder tip share from gross
 * BEFORE the profit floor — honest capturable-net qualification.
 */

export interface CostInput {
  gasUnits: bigint;
  baseFeeWei: bigint;
  priorityFeeWei: bigint;
  l1DataFeeWei?: bigint;         // OP-Stack only: GasPriceOracle getL1Fee(calldata)
  flashPremiumToken: bigint;     // 0 for Balancer
  grossOutToken: bigint;
  borrowInToken: bigint;
  tokenUsd: number;
  tokenDec: number;              // borrow-token decimals — raw units scale
  nativeUsd: number;
  chain: string;
}

export interface NetResult {
  grossUsd: number;
  gasUsd: number;
  premiumUsd: number;
  bribeUsd: number;
  netUsd: number;
  pass: boolean;
}

export function netUsd(i: CostInput): NetResult {
  // dual-gas on OP-Stack: L2 execution + L1 data availability (blob market)
  const gasNative = Number(i.gasUnits * (i.baseFeeWei + i.priorityFeeWei) + (i.l1DataFeeWei ?? 0n)) / 1e18;
  const gasUsd = gasNative * i.nativeUsd;
  const unit = 10 ** i.tokenDec; // raw->whole-token scale (borrow decimals, not always 18)
  const grossUsd =
    ((Number(i.grossOutToken) - Number(i.borrowInToken)) / unit) * i.tokenUsd;
  const premiumUsd = (Number(i.flashPremiumToken) / unit) * i.tokenUsd;

  let bribeUsd = 0;
  if (cfg.auctionChains.includes(i.chain)) {
    bribeUsd = Math.max(0, (grossUsd - gasUsd - premiumUsd) * (cfg.COINBASE_BRIBE_PCT_MAX / 100));
  }

  const net = grossUsd - gasUsd - premiumUsd - bribeUsd;
  return {
    grossUsd,
    gasUsd,
    premiumUsd,
    bribeUsd,
    netUsd: net,
    pass: net >= cfg.MIN_PROFIT_USD,
  };
}

/**
 * Constant-product price impact (bps) — the fraction of a pool's
 * input-side depth a trade consumes: impact = a_eff / (rIn + a_eff),
 * a_eff = amountIn·(1-fee). v2 uses real reserves; v3 substitutes the
 * equivalent virtual reserves (x→y: L·2⁹⁶/√P, y→x: L·√P/2⁹⁶ — raw
 * units, so amountIn stays native). Screening approximation: all
 * in-range liquidity treated as concentrated at the current tick.
 */
/** Input-side depth in raw token units — v2 real reserve, v3 virtual
 *  reserve (all in-range liquidity treated as concentrated at the tick). */
export function inputVirtualReserveRaw(
  pool: {
    kind: string; token0: string;
    reserve0?: bigint; reserve1?: bigint;
    sqrtPriceX96?: bigint; liquidity?: bigint;
  },
  tokenIn: string,
): number {
  const inIs0 = tokenIn.toLowerCase() === pool.token0.toLowerCase();
  if (pool.kind === 'v2') {
    return Number(inIs0 ? pool.reserve0 : pool.reserve1);
  }
  if (!pool.sqrtPriceX96 || !pool.liquidity) return 0;
  const s = Number(pool.sqrtPriceX96) / 2 ** 96;
  return inIs0 ? Number(pool.liquidity) / s : Number(pool.liquidity) * s;
}

export function priceImpactBps(
  pool: {
    kind: string; token0: string; feeBps: number;
    reserve0?: bigint; reserve1?: bigint;
    sqrtPriceX96?: bigint; liquidity?: bigint;
  },
  amountIn: bigint,
  tokenIn: string,
): number {
  const aEff = Number(amountIn) * (1 - pool.feeBps / 10_000);
  const vIn = inputVirtualReserveRaw(pool, tokenIn);
  if (!vIn || !Number.isFinite(vIn)) return 0;
  return (aEff / (vIn + aEff)) * 10_000;
}

/** Depth gate value in USD — feed liquidityUsd when the feed supplied it,
 *  otherwise derived from ON-CHAIN state: 2x the USD value of whichever
 *  side carries a known price. Factory-discovered pools start with
 *  liquidityUsd=0; without this fallback the entire on-chain-discovered
 *  universe is depth-rejected no matter how deep it really is. */
export function poolDepthUsd(
  pool: {
    kind: string; token0: string; token1: string;
    dec0: number; dec1: number; liquidityUsd: number;
    reserve0?: bigint; reserve1?: bigint;
    sqrtPriceX96?: bigint; liquidity?: bigint;
  },
  tokenUsd: Map<string, number>,
): number {
  if (pool.liquidityUsd > 0) return pool.liquidityUsd;
  for (const tok of [pool.token0, pool.token1]) {
    const px = tokenUsd.get(tok.toLowerCase());
    if (px === undefined) continue;
    const raw = inputVirtualReserveRaw(pool, tok);
    const dec = tok.toLowerCase() === pool.token0.toLowerCase() ? pool.dec0 : pool.dec1;
    if (raw > 0 && dec >= 0) return (raw / 10 ** dec) * px * 2;
  }
  return 0;
}

/** Credibility ceiling (operating discipline): spreads above ~2% on
 *  top-liquidity pairs are fake — the pool is lying about reserves. */
export const CREDIBILITY_CEILING_PCT = 2.0;

export function spreadPct(amountOut: bigint, amountIn: bigint, sameDecimals = true): number {
  if (amountIn <= 0n || !sameDecimals) return 0;
  return ((Number(amountOut) - Number(amountIn)) / Number(amountIn)) * 100;
}
