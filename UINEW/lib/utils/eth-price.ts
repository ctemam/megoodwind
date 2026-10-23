import { createPublicClient, http, Address } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { getRpcUrl, getChainlinkPriceFeed } from "@/lib/config";
import { CHAINLINK_AGGREGATOR_ABI } from "@/lib/abis/chainlinkAggregator";
import { ChainId } from "@/types/monitor";

/**
 * Get viem chain config for chainId
 */
function getChainConfig(chainId: ChainId) {
  return chainId === 1 ? mainnet : sepolia;
}

/**
 * Create public client for specific chain
 */
function createClientForChain(chainId: ChainId) {
  return createPublicClient({
    chain: getChainConfig(chainId),
    transport: http(getRpcUrl(chainId)),
  });
}

export interface EthPriceData {
  price: number; // ETH price in USD
  decimals: number; // Price feed decimals (usually 8)
  updatedAt: number; // Last update timestamp
  roundId: bigint; // Chainlink round ID
}

/**
 * Get current ETH price from Chainlink Price Feed
 * Returns the most recent ETH/USD price from on-chain oracle
 */
export async function getEthPrice(chainId: ChainId = 1): Promise<EthPriceData> {
  try {
    const publicClient = createClientForChain(chainId);
    const priceFeedAddress = getChainlinkPriceFeed(chainId) as Address;

    // Get latest round data from Chainlink
    const latestRoundData = await publicClient.readContract({
      address: priceFeedAddress,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "latestRoundData",
    });

    // Get decimals (usually 8 for ETH/USD)
    const decimals = await publicClient.readContract({
      address: priceFeedAddress,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "decimals",
    });

    const [roundId, answer, , updatedAt] = latestRoundData;

    // Convert answer to USD price
    // answer is in format: price * 10^decimals
    const price = Number(answer) / Math.pow(10, decimals);

    return {
      price,
      decimals,
      updatedAt: Number(updatedAt),
      roundId,
    };
  } catch (error) {
    console.error("Error fetching ETH price from Chainlink:", error);
    throw error;
  }
}

/**
 * Check if price data is fresh (updated within last 2 hours)
 */
export function isPriceFresh(updatedAt: number): boolean {
  const now = Math.floor(Date.now() / 1000); // Current time in seconds
  const twoHours = 2 * 60 * 60; // 2 hours in seconds
  return now - updatedAt < twoHours;
}

/**
 * Get ETH price with cache (to avoid excessive RPC calls)
 */
interface CachedPrice {
  data: EthPriceData;
  timestamp: number;
}

const priceCache: Map<ChainId, CachedPrice> = new Map();
const CACHE_DURATION = 60 * 1000; // 1 minute cache

export async function getEthPriceCached(chainId: ChainId = 1): Promise<number> {
  const now = Date.now();
  const cached = priceCache.get(chainId);

  // Return cached price if still fresh
  if (cached && now - cached.timestamp < CACHE_DURATION) {
    return cached.data.price;
  }

  // Fetch new price
  try {
    const priceData = await getEthPrice(chainId);
    priceCache.set(chainId, { data: priceData, timestamp: now });
    return priceData.price;
  } catch (error) {
    // If fetch fails but we have cached data, return it
    if (cached) {
      console.warn(`Failed to fetch ETH price for chain ${chainId}, using cached value`);
      return cached.data.price;
    }
    // Otherwise throw error
    throw error;
  }
}
