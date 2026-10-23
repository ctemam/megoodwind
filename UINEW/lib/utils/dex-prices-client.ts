/**
 * Client-side wrapper for DEX price fetching
 * Calls server-side API to avoid CORS issues
 */

import { Address } from "viem";
import { DexProtocol } from "@/types/monitor";

export interface DexQuote {
  dex: DexProtocol | string;
  price: number;
  source: string;
  pairAddress?: string;
}

/**
 * Get quotes from multiple DEXes via server-side API
 */
export async function getMultiDexQuotes(
  token0: Address,
  token1: Address,
  token0Decimals: number,
  token1Decimals: number
): Promise<DexQuote[]> {
  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

      const response = await fetch("/api/prices/multi-dex", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token0,
          token1,
          decimals0: token0Decimals,
          decimals1: token1Decimals,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return data.quotes || [];
    } catch (error: any) {
      lastError = error;

      // Don't retry on abort (timeout)
      if (error.name === 'AbortError') {
        console.warn(`[DEX Prices] Request timeout for ${token0}/${token1}`);
        return [];
      }

      // Log detailed error
      console.error(`[DEX Prices] Attempt ${attempt + 1}/${maxRetries} failed:`, {
        token0,
        token1,
        error: error.message,
      });

      // Wait before retry (exponential backoff)
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  console.error(`[DEX Prices] All retries failed for ${token0}/${token1}:`, lastError);
  return [];
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

      if (spread > bestSpread && spread <= 50) {
        bestSpread = spread;
        bestBuy = quotes[i];
        bestSell = quotes[j];
      }
    }
  }

  if (!bestBuy || !bestSell || bestSpread < 0.1) {
    return null;
  }

  return {
    buyFrom: bestBuy,
    sellTo: bestSell,
    priceDiff: bestSpread,
  };
}
