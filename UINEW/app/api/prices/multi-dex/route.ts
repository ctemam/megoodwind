/**
 * Server-side API: Get prices from multiple DEXes
 * This avoids CORS issues and keeps RPC URL private
 */

import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, Address } from "viem";
import { mainnet } from "viem/chains";
import { UNISWAP_V2_PAIR_ABI } from "@/lib/abis/uniswapV2Pair";
import { UNISWAP_V2_FACTORY_ABI } from "@/lib/abis/uniswapV2Factory";
import { UNISWAP_V3_POOL_ABI } from "@/lib/abis/uniswapV3Pool";
import { UNISWAP_V3_FACTORY_ABI } from "@/lib/abis/uniswapV3Factory";
import { DEX_FACTORIES } from "@/lib/config";
import { DexProtocol } from "@/types/monitor";

// Server-side RPC client with timeout (no CORS issues)
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.NEXT_PUBLIC_ETH_RPC_URL, {
    timeout: 10_000, // 10 second timeout for RPC calls
    retryCount: 2,
    retryDelay: 500,
  }),
});

interface QuoteRequest {
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
}

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
    return null;
  }
}

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

    if (pairToken0.toLowerCase() !== token0.toLowerCase()) {
      [reserve0, reserve1] = [reserve1, reserve0];
    }

    const reserve0Adjusted =
      parseFloat(reserve0.toString()) / Math.pow(10, token0Decimals);
    const reserve1Adjusted =
      parseFloat(reserve1.toString()) / Math.pow(10, token1Decimals);

    if (
      reserve0Adjusted === 0 ||
      reserve1Adjusted === 0 ||
      !isFinite(reserve0Adjusted) ||
      !isFinite(reserve1Adjusted)
    ) {
      return null;
    }

    const price = reserve1Adjusted / reserve0Adjusted;
    return price;
  } catch (error) {
    return null;
  }
}

async function getUniswapV3PoolAddress(
  factoryAddress: Address,
  token0: Address,
  token1: Address,
  fee: number = 3000
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
    return null;
  }
}

async function getUniswapV3Price(
  poolAddress: Address,
  token0: Address,
  token1: Address,
  token0Decimals: number,
  token1Decimals: number
): Promise<number | null> {
  try {
    const [slot0, poolToken0, poolToken1] = await Promise.all([
      publicClient.readContract({
        address: poolAddress,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "slot0",
      }),
      publicClient.readContract({
        address: poolAddress,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "token0",
      }),
      publicClient.readContract({
        address: poolAddress,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "token1",
      }),
    ]);

    const sqrtPriceX96 = BigInt(slot0[0]);
    const Q96 = 2n ** 96n;

    const sqrtPriceFloat = Number(sqrtPriceX96) / Number(Q96);
    let priceRatio = sqrtPriceFloat * sqrtPriceFloat;

    // Determine pool's token decimals based on actual pool token order
    const poolToken0Lower = poolToken0.toLowerCase();
    const poolToken1Lower = poolToken1.toLowerCase();
    const inputToken0Lower = token0.toLowerCase();
    const inputToken1Lower = token1.toLowerCase();

    let poolToken0Decimals: number;
    let poolToken1Decimals: number;

    if (poolToken0Lower === inputToken0Lower) {
      // Pool order matches input order
      poolToken0Decimals = token0Decimals;
      poolToken1Decimals = token1Decimals;
    } else {
      // Pool order is reversed from input order
      poolToken0Decimals = token1Decimals;
      poolToken1Decimals = token0Decimals;
    }

    // Apply decimal adjustment using POOL's token order
    const decimalDiff = poolToken0Decimals - poolToken1Decimals;
    const decimalAdjustment = Math.pow(10, decimalDiff);
    let price = priceRatio * decimalAdjustment;

    if (!isFinite(price) || price === 0 || price < 0) {
      return null;
    }

    // If pool token order doesn't match input order, invert
    if (poolToken0Lower !== inputToken0Lower) {
      price = 1 / price;
    }

    return price;
  } catch (error) {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const body: QuoteRequest = await request.json();
    const { token0, token1, decimals0, decimals1 } = body;

    console.log(`[API] Fetching prices for ${token0}/${token1}`);

    const quotes = [];

    // Uniswap V2
    try {
      const factoryAddress = DEX_FACTORIES[DexProtocol.UNISWAP_V2] as Address;
      const pairAddress = await getUniswapV2PairAddress(
        factoryAddress,
        token0 as Address,
        token1 as Address
      );

      if (pairAddress) {
        const price = await getUniswapV2Price(
          pairAddress,
          token0 as Address,
          token1 as Address,
          decimals0,
          decimals1
        );

        if (price !== null && price > 0 && isFinite(price)) {
          quotes.push({
            dex: DexProtocol.UNISWAP_V2,
            price,
            source: "direct",
            pairAddress,
          });
        }
      }
    } catch (e) {
      // Skip if error
    }

    // Uniswap V3 (0.3% pool)
    try {
      const factoryAddress = DEX_FACTORIES[DexProtocol.UNISWAP_V3] as Address;
      const poolAddress = await getUniswapV3PoolAddress(
        factoryAddress,
        token0 as Address,
        token1 as Address,
        3000
      );

      if (poolAddress) {
        const price = await getUniswapV3Price(
          poolAddress,
          token0 as Address,
          token1 as Address,
          decimals0,
          decimals1
        );

        if (price !== null && price > 0 && isFinite(price)) {
          quotes.push({
            dex: DexProtocol.UNISWAP_V3,
            price,
            source: "direct",
            pairAddress: poolAddress,
          });
        }
      }
    } catch (e) {
      // Skip if error
    }

    // Uniswap V3 (0.05% pool)
    try {
      const factoryAddress = DEX_FACTORIES[DexProtocol.UNISWAP_V3] as Address;
      const poolAddress = await getUniswapV3PoolAddress(
        factoryAddress,
        token0 as Address,
        token1 as Address,
        500
      );

      if (poolAddress) {
        const price = await getUniswapV3Price(
          poolAddress,
          token0 as Address,
          token1 as Address,
          decimals0,
          decimals1
        );

        if (price !== null && price > 0 && isFinite(price)) {
          quotes.push({
            dex: "uniswap_v3_500", // Distinguish from 0.3% pool
            price,
            source: "direct",
            pairAddress: poolAddress,
          });
        }
      }
    } catch (e) {
      // Skip if error
    }

    // Sushiswap
    try {
      const factoryAddress = DEX_FACTORIES[DexProtocol.SUSHISWAP] as Address;
      const pairAddress = await getUniswapV2PairAddress(
        factoryAddress,
        token0 as Address,
        token1 as Address
      );

      if (pairAddress) {
        const price = await getUniswapV2Price(
          pairAddress,
          token0 as Address,
          token1 as Address,
          decimals0,
          decimals1
        );

        if (price !== null && price > 0 && isFinite(price)) {
          quotes.push({
            dex: DexProtocol.SUSHISWAP,
            price,
            source: "direct",
            pairAddress,
          });
        }
      }
    } catch (e) {
      // Skip if error
    }

    const duration = Date.now() - startTime;
    console.log(`[API] Fetched ${quotes.length} quotes in ${duration}ms`);

    return NextResponse.json({
      quotes,
      meta: {
        duration,
        quotesCount: quotes.length,
      }
    });
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`[API] Error after ${duration}ms:`, error.message);

    return NextResponse.json(
      {
        error: error.message || "Failed to fetch prices",
        quotes: [], // Return empty array on error
      },
      { status: 500 }
    );
  }
}
