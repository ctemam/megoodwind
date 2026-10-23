/**
 * Uniswap V3 Price Calculation Utilities
 *
 * Reference: https://docs.uniswap.org/contracts/v3/reference/core/libraries/TickMath
 */

/**
 * Calculate price from Uniswap V3 sqrtPriceX96
 *
 * @param sqrtPriceX96 - The sqrt(price) * 2^96 from pool.slot0()
 * @param decimals0 - Decimals of token0
 * @param decimals1 - Decimals of token1
 * @param token0IsInput - True if we're pricing token0 in terms of token1
 * @returns Human-readable price (token1 per token0 if token0IsInput is true)
 */
export function calculateV3Price(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
  token0IsInput: boolean = true
): number {
  // Q96 = 2^96
  const Q96 = 2n ** 96n;

  // Calculate price as token1/token0 (pool's natural direction)
  // price = (sqrtPriceX96 / 2^96)^2

  // To avoid overflow and maintain precision:
  // price = (sqrtPriceX96^2) / (2^96)^2
  // price = (sqrtPriceX96^2) / 2^192

  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const denominator = Q96 * Q96;

  // Adjust for decimals
  // If token0 has 18 decimals and token1 has 6 decimals:
  // Raw price needs to be multiplied by 10^(18-6) = 10^12
  const decimalsDiff = decimals0 - decimals1;

  let price: number;

  if (decimalsDiff >= 0) {
    // Multiply by 10^decimalsDiff
    const adjustment = 10n ** BigInt(decimalsDiff);
    const adjustedNumerator = numerator * adjustment;
    price = Number(adjustedNumerator) / Number(denominator);
  } else {
    // Divide by 10^(-decimalsDiff)
    const adjustment = 10n ** BigInt(-decimalsDiff);
    const adjustedDenominator = denominator * adjustment;
    price = Number(numerator) / Number(adjustedDenominator);
  }

  // If we want token0 per token1 instead of token1 per token0, invert
  if (!token0IsInput) {
    price = 1 / price;
  }

  return price;
}

/**
 * Test function to validate price calculation
 */
export function testV3PriceCalculation() {
  // Example: WETH/USDC pool on Ethereum
  // WETH = 18 decimals, USDC = 6 decimals
  // Expected price: ~3500 USDC per WETH

  // Mock sqrtPriceX96 (this should come from actual pool)
  const mockSqrtPriceX96 = 1500000000000000000000000n; // Example value

  const wethDecimals = 18;
  const usdcDecimals = 6;

  // Calculate USDC per WETH
  const priceUsdcPerWeth = calculateV3Price(
    mockSqrtPriceX96,
    wethDecimals,
    usdcDecimals,
    true
  );

  console.log("USDC per WETH:", priceUsdcPerWeth);

  // Calculate WETH per USDC
  const priceWethPerUsdc = calculateV3Price(
    mockSqrtPriceX96,
    wethDecimals,
    usdcDecimals,
    false
  );

  console.log("WETH per USDC:", priceWethPerUsdc);
  console.log("Inverse check:", priceUsdcPerWeth * priceWethPerUsdc);
}
