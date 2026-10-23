import { createPublicClient, http, Address } from "viem";
import { mainnet } from "viem/chains";
import { UNISWAP_V2_PAIR_ABI } from "@/lib/abis/uniswapV2Pair";
import { UNISWAP_V2_FACTORY_ABI } from "@/lib/abis/uniswapV2Factory";
import { UNISWAP_V3_POOL_ABI } from "@/lib/abis/uniswapV3Pool";
import { UNISWAP_V3_FACTORY_ABI } from "@/lib/abis/uniswapV3Factory";
import { DEX_FACTORIES, ETH_RPC_URL } from "@/lib/config";
import { DexProtocol } from "@/types/monitor";

// Create viem public client
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(ETH_RPC_URL),
});

export interface DexQuote {
  dex: DexProtocol;
  price: number; // Price in quote token (e.g., USDC)
  source: string; // "direct" or "aggregator"
  pairAddress?: string;
}

/**
 * Get Uniswap V2 pair address
 */
async function getUniswapV2PairAddress(
  factoryAddress: Address,
  token0: Address,
  token1: Address
): Promise<Address | null> {
  try {
    const pairAddress = await publicClient.readContract({
      address: factoryAddress,
      abi: UNISWAP_V2_FACTORY_ABI,
      functionName: "getPair",
      args: [token0, token1],
    });

    if (pairAddress === "0x0000000000000000000000000000000000000000") {
      return null;
    }

    return pairAddress as Address;
  } catch (error) {
    console.error("Error getting V2 pair:", error);
    return null;
  }
}

/**
 * Get Uniswap V3 pool address
 */
async function getUniswapV3PoolAddress(
  factoryAddress: Address,
  token0: Address,
  token1: Address,
  fee: number = 3000 // 0.3% default
): Promise<Address | null> {
  try {
    const poolAddress = await publicClient.readContract({
      address: factoryAddress,
      abi: UNISWAP_V3_FACTORY_ABI,
      functionName: "getPool",
      args: [token0, token1, fee],
    });

    if (poolAddress === "0x0000000000000000000000000000000000000000") {
      return null;
    }

    return poolAddress as Address;
  } catch (error) {
    console.error("Error getting V3 pool:", error);
    return null;
  }
}

/**
 * Get price from Uniswap V2 pool
 */
async function getUniswapV2Price(
  pairAddress: Address,
  token0: Address,
  token1: Address,
  token0Decimals: number,
  token1Decimals: number
): Promise<number | null> {
  try {
    const reserves = await publicClient.readContract({
      address: pairAddress,
      abi: UNISWAP_V2_PAIR_ABI,
      functionName: "getReserves",
    });

    const pairToken0 = await publicClient.readContract({
      address: pairAddress,
      abi: UNISWAP_V2_PAIR_ABI,
      functionName: "token0",
    });

    let reserve0 = reserves[0];
    let reserve1 = reserves[1];

    // Ensure correct order
    if (pairToken0.toLowerCase() !== token0.toLowerCase()) {
      [reserve0, reserve1] = [reserve1, reserve0];
    }

    // Calculate price: token1 per token0
    // Convert BigInt to string first to avoid precision loss
    const reserve0Adjusted = parseFloat(reserve0.toString()) / Math.pow(10, token0Decimals);
    const reserve1Adjusted = parseFloat(reserve1.toString()) / Math.pow(10, token1Decimals);

    // Validate reserves
    if (reserve0Adjusted === 0 || reserve1Adjusted === 0 || !isFinite(reserve0Adjusted) || !isFinite(reserve1Adjusted)) {
      return null;
    }

    const price = reserve1Adjusted / reserve0Adjusted;

    return price;
  } catch (error) {
    console.error("Error getting V2 price:", error);
    return null;
  }
}

/**
 * Get price from Uniswap V3 pool
 */
async function getUniswapV3Price(
  poolAddress: Address,
  token0: Address,
  token1: Address,
  token0Decimals: number,
  token1Decimals: number
): Promise<number | null> {
  try {
    const slot0 = await publicClient.readContract({
      address: poolAddress,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "slot0",
    });

    const poolToken0 = await publicClient.readContract({
      address: poolAddress,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "token0",
    });

    const sqrtPriceX96 = BigInt(slot0[0]);

    // Uniswap V3 sqrtPriceX96 format:
    // sqrtPrice = sqrt(token1/token0) * 2^96
    // price = (sqrtPriceX96 / 2^96)^2

    // To get human-readable price, we need to:
    // 1. Calculate the ratio
    // 2. Adjust for decimals
    // 3. Handle token order

    const Q96 = 2n ** 96n;

    // Calculate price step by step to avoid overflow
    // price = (sqrtPriceX96 / Q96)^2 * 10^(decimals0 - decimals1)

    // Split calculation to avoid overflow:
    // First, get the ratio as a decimal number
    const sqrtPriceFloat = Number(sqrtPriceX96) / Number(Q96);

    // Then square it to get the price ratio
    let priceRatio = sqrtPriceFloat * sqrtPriceFloat;

    // Adjust for decimals
    // Pool price is in raw units, so we need to adjust by 10^(decimals0 - decimals1)
    const decimalDiff = token0Decimals - token1Decimals;
    const decimalAdjustment = Math.pow(10, decimalDiff);

    let price = priceRatio * decimalAdjustment;

    // Validate intermediate result
    if (!isFinite(price) || price === 0 || price < 0) {
      console.error("V3 price calculation failed:", {
        sqrtPriceX96: sqrtPriceX96.toString(),
        sqrtPriceFloat,
        priceRatio,
        decimalAdjustment,
        price,
        token0,
        token1,
        token0Decimals,
        token1Decimals,
      });
      return null;
    }

    // Check if we need to invert based on token order in pool vs our input
    const poolToken0Lower = poolToken0.toLowerCase();
    const inputToken0Lower = token0.toLowerCase();

    if (poolToken0Lower !== inputToken0Lower) {
      // Tokens are reversed in pool, invert the price
      price = 1 / price;
    }

    // Final validation with reasonable bounds
    if (!isFinite(price) || price === 0 || price < 0) {
      console.error("V3 price invalid after inversion:", price);
      return null;
    }

    // Sanity check: price should be in a reasonable range
    // For most token pairs, price should be between 0.000001 and 1000000
    if (price < 0.000001 || price > 1000000000) {
      console.warn("V3 price seems unreasonable:", {
        price,
        pair: `${token0}/${token1}`,
        poolToken0,
      });
      // Don't return null, just warn - some exotic pairs might have extreme prices
    }

    return price;
  } catch (error) {
    console.error("Error getting V3 price:", error);
    return null;
  }
}

/**
 * Get price from Uniswap V2 (or Sushiswap)
 */
export async function getUniswapV2Quote(
  dex: DexProtocol.UNISWAP_V2 | DexProtocol.SUSHISWAP,
  token0: Address,
  token1: Address,
  token0Decimals: number,
  token1Decimals: number
): Promise<DexQuote | null> {
  const factoryAddress = DEX_FACTORIES[dex] as Address;

  if (!factoryAddress) {
    return null;
  }

  const pairAddress = await getUniswapV2PairAddress(
    factoryAddress,
    token0,
    token1
  );

  if (!pairAddress) {
    return null;
  }

  const price = await getUniswapV2Price(
    pairAddress,
    token0,
    token1,
    token0Decimals,
    token1Decimals
  );

  if (price === null) {
    return null;
  }

  return {
    dex,
    price,
    source: "direct",
    pairAddress,
  };
}

/**
 * Get price from Uniswap V3
 */
export async function getUniswapV3Quote(
  token0: Address,
  token1: Address,
  token0Decimals: number,
  token1Decimals: number,
  fee: number = 3000
): Promise<DexQuote | null> {
  const factoryAddress = DEX_FACTORIES[DexProtocol.UNISWAP_V3] as Address;

  if (!factoryAddress) {
    return null;
  }

  const poolAddress = await getUniswapV3PoolAddress(
    factoryAddress,
    token0,
    token1,
    fee
  );

  if (!poolAddress) {
    return null;
  }

  const price = await getUniswapV3Price(
    poolAddress,
    token0,
    token1,
    token0Decimals,
    token1Decimals
  );

  if (price === null) {
    return null;
  }

  return {
    dex: DexProtocol.UNISWAP_V3,
    price,
    source: "direct",
    pairAddress: poolAddress,
  };
}

/**
 * Get quotes from multiple DEXes in parallel
 */
export async function getMultiDexQuotes(
  token0: Address,
  token1: Address,
  token0Decimals: number,
  token1Decimals: number
): Promise<DexQuote[]> {
  const promises = [
    getUniswapV2Quote(
      DexProtocol.UNISWAP_V2,
      token0,
      token1,
      token0Decimals,
      token1Decimals
    ),
    getUniswapV3Quote(token0, token1, token0Decimals, token1Decimals, 3000),
    getUniswapV3Quote(token0, token1, token0Decimals, token1Decimals, 500),
    getUniswapV2Quote(
      DexProtocol.SUSHISWAP,
      token0,
      token1,
      token0Decimals,
      token1Decimals
    ),
  ];

  const results = await Promise.allSettled(promises);

  const quotes: DexQuote[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== null) {
      const quote = result.value;
      // Validate price data: must be positive, finite, and not NaN
      if (
        quote.price > 0 &&
        isFinite(quote.price) &&
        !isNaN(quote.price)
      ) {
        quotes.push(quote);
      }
    }
  }

  return quotes;
}

/**
 * Find best arbitrage opportunity from multiple quotes
 */
export function findBestArbitrage(quotes: DexQuote[]): {
  buyFrom: DexQuote;
  sellTo: DexQuote;
  priceDiff: number;
} | null {
  if (quotes.length < 2) {
    return null;
  }

  let bestSpread = 0;
  let bestBuy: DexQuote | null = null;
  let bestSell: DexQuote | null = null;

  for (let i = 0; i < quotes.length; i++) {
    for (let j = 0; j < quotes.length; j++) {
      if (i === j) continue;

      const buyPrice = quotes[i].price;
      const sellPrice = quotes[j].price;
      const spread = ((sellPrice - buyPrice) / buyPrice) * 100;

      // Filter out unrealistic spreads (likely data errors)
      // Max realistic spread: 50% (anything higher is likely a pricing error)
      if (spread > bestSpread && spread <= 50) {
        bestSpread = spread;
        bestBuy = quotes[i];
        bestSell = quotes[j];
      }
    }
  }

  // Minimum spread threshold: 0.1%
  if (!bestBuy || !bestSell || bestSpread < 0.1) {
    return null;
  }

  return {
    buyFrom: bestBuy,
    sellTo: bestSell,
    priceDiff: bestSpread,
  };
}
