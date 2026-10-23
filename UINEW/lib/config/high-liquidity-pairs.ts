/**
 * High Liquidity Trading Pairs for WETH-based Arbitrage
 *
 * These pairs are selected based on:
 * - High TVL (Total Value Locked)
 * - Deep liquidity (low slippage)
 * - Active trading volume
 * - Multiple DEX availability
 */

import { DexProtocol } from "@/types/monitor";
import { TOKENS_MAINNET, TOKENS_SEPOLIA, DEX_ROUTERS_MAINNET, DEX_ROUTERS_SEPOLIA } from "@/lib/config";

export interface HighLiquidityPair {
  token: {
    address: string;
    symbol: string;
    decimals: number;
  };
  dexes: {
    protocol: DexProtocol;
    router: string;
    fee?: number; // For V3 (3000 = 0.3%, 500 = 0.05%, 10000 = 1%)
  }[];
  minLiquidity: number; // Minimum liquidity in USD to consider
}

/**
 * Ethereum Mainnet High Liquidity Pairs
 * All paired with WETH for 2-hop arbitrage: WETH → Token → WETH
 * 
 * ⚡ OPTIMIZED based on 625 scans data analysis:
 * - WETH/USDC: 72.5% opportunities above 0.17% spread (⭐⭐⭐ Best)
 * - WETH/USDT: 51.8% opportunities above 0.17% spread (⭐⭐ Good)
 * - WETH/DAI:  55.2% opportunities above 0.17% spread (⭐⭐ Good)
 * - WETH/WBTC: 15.4% opportunities (EXCLUDED - low spread, avg 0.0907%)
 * 
 * By removing WBTC, scan speed improves by 25% (3 pairs vs 4)
 */
export const MAINNET_HIGH_LIQUIDITY_PAIRS: HighLiquidityPair[] = [
  // WETH/USDC - ⭐⭐⭐ BEST PERFORMER (72.5% profitable, avg 0.1952%)
  {
    token: {
      address: TOKENS_MAINNET.USDC.address,
      symbol: "USDC",
      decimals: 6,
    },
    dexes: [
      {
        protocol: DexProtocol.UNISWAP_V2,
        router: DEX_ROUTERS_MAINNET[DexProtocol.UNISWAP_V2],
      },
      {
        protocol: DexProtocol.UNISWAP_V3,
        router: DEX_ROUTERS_MAINNET[DexProtocol.UNISWAP_V3],
        fee: 3000, // 0.3% pool
      },
      {
        protocol: DexProtocol.UNISWAP_V3,
        router: DEX_ROUTERS_MAINNET[DexProtocol.UNISWAP_V3],
        fee: 500, // 0.05% pool (ultra low fee, high volume)
      },
      {
        protocol: DexProtocol.SUSHISWAP,
        router: DEX_ROUTERS_MAINNET[DexProtocol.SUSHISWAP],
      },
    ],
    minLiquidity: 50_000_000, // $50M minimum
  },

  // WETH/USDT - ⭐⭐ GOOD PERFORMER (51.8% profitable, avg 0.1832%)
  {
    token: {
      address: TOKENS_MAINNET.USDT.address,
      symbol: "USDT",
      decimals: 6,
    },
    dexes: [
      {
        protocol: DexProtocol.UNISWAP_V2,
        router: DEX_ROUTERS_MAINNET[DexProtocol.UNISWAP_V2],
      },
      {
        protocol: DexProtocol.UNISWAP_V3,
        router: DEX_ROUTERS_MAINNET[DexProtocol.UNISWAP_V3],
        fee: 3000,
      },
      {
        protocol: DexProtocol.SUSHISWAP,
        router: DEX_ROUTERS_MAINNET[DexProtocol.SUSHISWAP],
      },
    ],
    minLiquidity: 30_000_000, // $30M minimum
  },

  // WETH/DAI - ⭐⭐ GOOD PERFORMER (55.2% profitable, avg 0.1703%)
  {
    token: {
      address: TOKENS_MAINNET.DAI.address,
      symbol: "DAI",
      decimals: 18,
    },
    dexes: [
      {
        protocol: DexProtocol.UNISWAP_V2,
        router: DEX_ROUTERS_MAINNET[DexProtocol.UNISWAP_V2],
      },
      {
        protocol: DexProtocol.UNISWAP_V3,
        router: DEX_ROUTERS_MAINNET[DexProtocol.UNISWAP_V3],
        fee: 3000,
      },
      {
        protocol: DexProtocol.SUSHISWAP,
        router: DEX_ROUTERS_MAINNET[DexProtocol.SUSHISWAP],
      },
    ],
    minLiquidity: 20_000_000, // $20M minimum
  },

  // ❌ WETH/WBTC - EXCLUDED (Only 15.4% profitable, avg 0.0907% spread)
  // Removing this pair improves scan efficiency by 25% (3 pairs instead of 4)
];

/**
 * Sepolia Testnet Pairs (Limited liquidity)
 */
export const SEPOLIA_HIGH_LIQUIDITY_PAIRS: HighLiquidityPair[] = [
  {
    token: {
      address: TOKENS_SEPOLIA.USDC.address,
      symbol: "USDC",
      decimals: 6,
    },
    dexes: [
      {
        protocol: DexProtocol.UNISWAP_V2,
        router: DEX_ROUTERS_SEPOLIA[DexProtocol.UNISWAP_V2],
      },
      {
        protocol: DexProtocol.UNISWAP_V3,
        router: DEX_ROUTERS_SEPOLIA[DexProtocol.UNISWAP_V3],
        fee: 3000,
      },
    ],
    minLiquidity: 1000, // Very low for testnet
  },
  {
    token: {
      address: TOKENS_SEPOLIA.DAI.address,
      symbol: "DAI",
      decimals: 18,
    },
    dexes: [
      {
        protocol: DexProtocol.UNISWAP_V2,
        router: DEX_ROUTERS_SEPOLIA[DexProtocol.UNISWAP_V2],
      },
      {
        protocol: DexProtocol.UNISWAP_V3,
        router: DEX_ROUTERS_SEPOLIA[DexProtocol.UNISWAP_V3],
        fee: 3000,
      },
    ],
    minLiquidity: 1000,
  },
];

/**
 * Get high liquidity pairs for specific chain
 */
export function getHighLiquidityPairs(chainId: number): HighLiquidityPair[] {
  return chainId === 1 ? MAINNET_HIGH_LIQUIDITY_PAIRS : SEPOLIA_HIGH_LIQUIDITY_PAIRS;
}

/**
 * WETH address by chain
 */
export function getWETHAddress(chainId: number): string {
  return chainId === 1 ? TOKENS_MAINNET.WETH.address : TOKENS_SEPOLIA.WETH.address;
}

/**
 * Trading strategy configuration
 */
export const ARBITRAGE_STRATEGY = {
  // Always start and end with WETH
  baseToken: "WETH",

  // Scan only these high-volume pairs
  scanInterval: 3000, // 3 seconds

  // Minimum profit thresholds (OPTIMIZED based on 625 scans)
  minProfitUsd: 5.0, // $5 minimum profit (after all fees)
  minSpreadPercent: 0.17, // 0.17% minimum spread (optimized - 48.3% hit rate vs 32% at 0.2%)

  // Risk management (TIGHTENED)
  maxSlippagePercent: 0.5, // 0.5% max slippage (strict)
  maxGasGwei: 50, // Don't execute if gas > 50 Gwei (cost control)

  // Flash loan (default to Balancer for 0% fee)
  flashLoanFeePercent: 0.0, // Balancer = 0% (free!)
  // Alternative fees:
  // - Aave V3 = 0.09% (9 bps)
  // - Uniswap V3 = 0.05% (5 bps for 500 tier pools)
};
