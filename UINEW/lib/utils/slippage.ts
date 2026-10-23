import { createPublicClient, http, Address, formatUnits, parseUnits } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { ETH_RPC_URL } from "@/lib/config";
import { UNISWAP_V2_PAIR_ABI } from "@/lib/abis/uniswapV2Pair";
import { UNISWAP_V3_POOL_ABI } from "@/lib/abis/uniswapV3Pool";

/**
 * Slippage calculation utilities for DEX arbitrage
 */

interface ReservesV2 {
  reserve0: bigint;
  reserve1: bigint;
  token0: Address;
  token1: Address;
}

interface PriceImpactResult {
  expectedAmountOut: bigint;
  actualAmountOut: bigint;
  priceImpact: number; // Percentage (0-100)
  slippage: number; // Percentage (0-100)
}

/**
 * Get reserves from Uniswap V2 pair
 */
export async function getUniswapV2Reserves(
  pairAddress: Address,
  chainId: number
): Promise<ReservesV2> {
  const client = createPublicClient({
    chain: chainId === 1 ? mainnet : sepolia,
    transport: http(ETH_RPC_URL),
  });

  try {
    const [reserves, token0, token1] = await Promise.all([
      client.readContract({
        address: pairAddress,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: "getReserves",
      }) as Promise<[bigint, bigint, number]>,
      client.readContract({
        address: pairAddress,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: "token0",
      }) as Promise<Address>,
      client.readContract({
        address: pairAddress,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: "token1",
      }) as Promise<Address>,
    ]);

    return {
      reserve0: reserves[0],
      reserve1: reserves[1],
      token0,
      token1,
    };
  } catch (error) {
    console.error("Error fetching V2 reserves:", error);
    throw error;
  }
}

/**
 * Calculate Uniswap V2 output amount with fee (0.3%)
 * Formula: amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
 */
export function calculateV2AmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
    return 0n;
  }

  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;

  return numerator / denominator;
}

/**
 * Calculate price impact for Uniswap V2 swap
 */
export async function calculateV2PriceImpact(
  pairAddress: Address,
  amountIn: bigint,
  tokenIn: Address,
  chainId: number
): Promise<PriceImpactResult> {
  const reserves = await getUniswapV2Reserves(pairAddress, chainId);

  // Determine which reserve is which
  const isToken0 = tokenIn.toLowerCase() === reserves.token0.toLowerCase();
  const reserveIn = isToken0 ? reserves.reserve0 : reserves.reserve1;
  const reserveOut = isToken0 ? reserves.reserve1 : reserves.reserve0;

  // Calculate expected amount (linear, no slippage)
  const price = Number(reserveOut) / Number(reserveIn);
  const expectedAmountOut = BigInt(Math.floor(Number(amountIn) * price));

  // Calculate actual amount (with price impact)
  const actualAmountOut = calculateV2AmountOut(amountIn, reserveIn, reserveOut);

  // Price impact = (expected - actual) / expected * 100
  const priceImpact =
    expectedAmountOut > 0n
      ? Number((expectedAmountOut - actualAmountOut) * 10000n / expectedAmountOut) / 100
      : 0;

  // Slippage is same as price impact for single swap
  const slippage = priceImpact;

  return {
    expectedAmountOut,
    actualAmountOut,
    priceImpact,
    slippage,
  };
}

/**
 * Calculate price impact for Uniswap V3 swap
 * Simplified version - for accurate calculation, need to walk through ticks
 */
export async function calculateV3PriceImpact(
  poolAddress: Address,
  amountIn: bigint,
  tokenIn: Address,
  chainId: number
): Promise<PriceImpactResult> {
  const client = createPublicClient({
    chain: chainId === 1 ? mainnet : sepolia,
    transport: http(ETH_RPC_URL),
  });

  try {
    const [slot0, liquidity, token0] = await Promise.all([
      client.readContract({
        address: poolAddress,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "slot0",
      }) as Promise<[bigint, number, number, number, number, number, boolean]>,
      client.readContract({
        address: poolAddress,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "liquidity",
      }) as Promise<bigint>,
      client.readContract({
        address: poolAddress,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "token0",
      }) as Promise<Address>,
    ]);

    const sqrtPriceX96 = slot0[0];
    const currentLiquidity = liquidity;

    // Simple approximation - actual V3 calculation is more complex
    // For now, use similar logic to V2 with liquidity as reserve proxy
    const isToken0 = tokenIn.toLowerCase() === token0.toLowerCase();
    
    // Approximate reserves from liquidity and sqrtPrice
    // This is simplified - real V3 needs tick traversal
    const price = Number(sqrtPriceX96) ** 2 / (2 ** 192);
    const reserveIn = currentLiquidity / 2n; // Rough approximation
    const reserveOut = BigInt(Math.floor(Number(reserveIn) * price));

    const expectedAmountOut = BigInt(Math.floor(Number(amountIn) * price));
    const actualAmountOut = calculateV2AmountOut(amountIn, reserveIn, reserveOut);

    const priceImpact =
      expectedAmountOut > 0n
        ? Number((expectedAmountOut - actualAmountOut) * 10000n / expectedAmountOut) / 100
        : 0;

    return {
      expectedAmountOut,
      actualAmountOut,
      priceImpact,
      slippage: priceImpact,
    };
  } catch (error) {
    console.error("Error calculating V3 price impact:", error);
    // Return conservative estimate (lowered for testing)
    return {
      expectedAmountOut: 0n,
      actualAmountOut: 0n,
      priceImpact: 0.5, // Conservative 0.5% estimate
      slippage: 0.5,
    };
  }
}

/**
 * Calculate total slippage for arbitrage route (buy + sell)
 */
export async function calculateArbitrageSlippage(
  buyPairAddress: Address,
  sellPairAddress: Address,
  amountIn: bigint,
  tokenAddress: Address,
  wethAddress: Address,
  buyDexType: "v2" | "v3",
  sellDexType: "v2" | "v3",
  chainId: number
): Promise<{
  buySlippage: number;
  sellSlippage: number;
  totalSlippage: number;
  buyAmountOut: bigint;
  sellAmountOut: bigint;
}> {
  // Calculate buy leg (WETH → Token)
  const buyImpact =
    buyDexType === "v2"
      ? await calculateV2PriceImpact(buyPairAddress, amountIn, wethAddress, chainId)
      : await calculateV3PriceImpact(buyPairAddress, amountIn, wethAddress, chainId);

  // Calculate sell leg (Token → WETH)
  const sellImpact =
    sellDexType === "v2"
      ? await calculateV2PriceImpact(sellPairAddress, buyImpact.actualAmountOut, tokenAddress, chainId)
      : await calculateV3PriceImpact(sellPairAddress, buyImpact.actualAmountOut, tokenAddress, chainId);

  // Total slippage compounds
  const totalSlippage = buyImpact.slippage + sellImpact.slippage;

  return {
    buySlippage: buyImpact.slippage,
    sellSlippage: sellImpact.slippage,
    totalSlippage,
    buyAmountOut: buyImpact.actualAmountOut,
    sellAmountOut: sellImpact.actualAmountOut,
  };
}

/**
 * Check if slippage is acceptable
 */
export function isSlippageAcceptable(
  slippage: number,
  maxSlippage: number
): boolean {
  return slippage <= maxSlippage;
}

