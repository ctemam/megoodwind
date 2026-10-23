import { TOKENS } from "@/lib/config";

export interface TokenPrice {
  token: string;
  price: number; // Price in USD
  dstAmount: string; // Amount received
}

export interface ArbitrageCheck {
  tokenAddress: string;
  tokenSymbol: string;
  buyPrice: number; // USD
  sellPrice: number; // USD
  priceDiff: number; // %
  profitable: boolean;
}

/**
 * Get quote from our API endpoint
 */
async function getQuote(
  srcToken: string,
  dstToken: string,
  amount: string
): Promise<any> {
  try {
    const response = await fetch(
      `/api/quote?src=${srcToken}&dst=${dstToken}&amount=${amount}`
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("Quote API error:", error);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error("Failed to fetch quote:", error);
    return null;
  }
}

/**
 * Get token decimals from config
 */
function getTokenDecimals(tokenAddress: string): number {
  const lowerAddress = tokenAddress.toLowerCase();

  for (const token of Object.values(TOKENS)) {
    if (token.address.toLowerCase() === lowerAddress) {
      return token.decimals;
    }
  }

  // Default to 18 if not found
  return 18;
}

/**
 * Get token price in USDC
 */
export async function getTokenPrice(
  tokenAddress: string,
  amountInWei: string
): Promise<TokenPrice | null> {
  const USDC_ADDRESS = TOKENS.USDC.address;

  if (tokenAddress.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
    return {
      token: tokenAddress,
      price: 1, // USDC is $1
      dstAmount: amountInWei,
    };
  }

  const quote = await getQuote(tokenAddress, USDC_ADDRESS, amountInWei);

  if (!quote || !quote.dstAmount) {
    return null;
  }

  // Get correct decimals for this token
  const tokenDecimals = getTokenDecimals(tokenAddress);

  // Convert USDC amount (6 decimals) to USD
  const usdcAmount = parseInt(quote.dstAmount) / 1e6;
  const tokenAmount = parseInt(amountInWei) / Math.pow(10, tokenDecimals);

  const pricePerToken = usdcAmount / tokenAmount;

  return {
    token: tokenAddress,
    price: pricePerToken,
    dstAmount: quote.dstAmount,
  };
}

/**
 * Check arbitrage opportunity by comparing buy and sell prices
 */
export async function checkArbitrage(
  tokenAddress: string,
  tokenSymbol: string,
  amountInWei: string,
  minProfitPercent: number = 0.5
): Promise<ArbitrageCheck | null> {
  const USDC_ADDRESS = TOKENS.USDC.address;

  // Get buy price (Token -> USDC)
  const buyQuote = await getQuote(tokenAddress, USDC_ADDRESS, amountInWei);

  if (!buyQuote) {
    return null;
  }

  const usdcReceived = parseInt(buyQuote.dstAmount) / 1e6;

  // Get sell price (USDC -> Token)
  // Use the USDC amount we would receive as input
  const usdcAmountWei = (usdcReceived * 1e6).toString();
  const sellQuote = await getQuote(USDC_ADDRESS, tokenAddress, usdcAmountWei);

  if (!sellQuote) {
    return null;
  }

  const tokenAmountReceived = parseInt(sellQuote.dstAmount) / 1e18;
  const originalTokenAmount = parseInt(amountInWei) / 1e18;

  // Calculate price difference
  const priceDiff = ((tokenAmountReceived - originalTokenAmount) / originalTokenAmount) * 100;

  return {
    tokenAddress,
    tokenSymbol,
    buyPrice: usdcReceived / originalTokenAmount,
    sellPrice: originalTokenAmount / tokenAmountReceived,
    priceDiff,
    profitable: priceDiff > minProfitPercent,
  };
}

/**
 * Get multiple token prices in parallel
 */
export async function getMultipleTokenPrices(
  tokens: Array<{ address: string; amount: string }>
): Promise<(TokenPrice | null)[]> {
  const promises = tokens.map((token) =>
    getTokenPrice(token.address, token.amount)
  );

  return await Promise.all(promises);
}
