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
  flashPremiumToken: bigint;     // 0 for Balancer
  grossOutToken: bigint;
  borrowInToken: bigint;
  tokenUsd: number;
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
  const gasNative = Number(i.gasUnits * (i.baseFeeWei + i.priorityFeeWei)) / 1e18;
  const gasUsd = gasNative * i.nativeUsd;
  const dec = 1; // tokenUsd already expressed per whole token
  const grossUsd =
    ((Number(i.grossOutToken) - Number(i.borrowInToken)) / 1e18) * i.tokenUsd * dec;
  const premiumUsd = (Number(i.flashPremiumToken) / 1e18) * i.tokenUsd;

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

/** Credibility ceiling (operating discipline): spreads above ~2% on
 *  top-liquidity pairs are fake — the pool is lying about reserves. */
export const CREDIBILITY_CEILING_PCT = 2.0;

export function spreadPct(amountOut: bigint, amountIn: bigint, sameDecimals = true): number {
  if (amountIn <= 0n || !sameDecimals) return 0;
  return ((Number(amountOut) - Number(amountIn)) / Number(amountIn)) * 100;
}
