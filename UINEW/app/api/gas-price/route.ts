/**
 * Server-side API: Get current gas price
 * Avoids CORS issues from client-side RPC calls
 * Always uses actual mainnet RPC (not Hardhat fork) for realistic gas prices
 */

import { NextResponse } from "next/server";
import { createPublicClient, http, formatGwei } from "viem";
import { mainnet } from "viem/chains";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// Always use actual mainnet RPC for gas price (not Hardhat fork)
// NEXT_PUBLIC_ETH_RPC_URL should point to Alchemy mainnet URL (e.g., https://eth-mainnet.g.alchemy.com/v2/API_KEY)
// Even if Hardhat fork uses it, we want actual mainnet gas prices for realistic calculations
const getMainnetRpcUrl = (): string => {
  // If MAINNET_RPC_URL is set, use it (should point to actual mainnet)
  if (process.env.MAINNET_RPC_URL) {
    return process.env.MAINNET_RPC_URL;
  }
  
  // Always try to read .env.local first to get the actual Alchemy URL
  // This ensures we use mainnet even if process.env is pointing to localhost
  try {
    const envPath = path.join(process.cwd(), '.env.local');
    if (fs.existsSync(envPath)) {
      // Use dotenv to parse .env.local
      const envConfig = dotenv.config({ path: envPath });
      if (envConfig.parsed && envConfig.parsed.NEXT_PUBLIC_ETH_RPC_URL) {
        const extractedUrl = envConfig.parsed.NEXT_PUBLIC_ETH_RPC_URL.trim();
        if (extractedUrl.includes('alchemy.com') && !extractedUrl.includes('localhost')) {
          console.log(`[Gas Price API] ✅ Using Alchemy mainnet URL from .env.local`);
          return extractedUrl;
        }
      }
      
      // Fallback: read file directly and parse with regex
      const envContent = fs.readFileSync(envPath, 'utf8');
      const match = envContent.match(/NEXT_PUBLIC_ETH_RPC_URL\s*=\s*['"]?([^'"\n\r]+)['"]?/);
      if (match && match[1]) {
        const extractedUrl = match[1].trim();
        if (extractedUrl.includes('alchemy.com') && !extractedUrl.includes('localhost')) {
          console.log(`[Gas Price API] ✅ Using Alchemy mainnet URL from .env.local (direct read)`);
          return extractedUrl;
        }
      }
    }
  } catch (e: any) {
    console.error(`[Gas Price API] ❌ Failed to read .env.local: ${e?.message || e}`);
  }
  
  // Fallback to process.env (may be localhost if Hardhat fork is running)
  const rpcUrl = process.env.NEXT_PUBLIC_ETH_RPC_URL || "";
  
  // If RPC URL points to localhost, warn
  if (rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")) {
    console.warn(`[Gas Price API] ⚠️ RPC URL is localhost (${rpcUrl}). Gas prices will be from Hardhat fork (unrealistic).`);
    return rpcUrl;
  }
  
  // If not localhost, use as-is (should be mainnet RPC - Alchemy URL)
  return rpcUrl;
};

const mainnetRpcUrl = getMainnetRpcUrl();
console.log(`[Gas Price API] Using RPC: ${mainnetRpcUrl.includes('alchemy.com') ? 'Alchemy Mainnet ✅' : mainnetRpcUrl.includes('localhost') ? 'Hardhat Fork ⚠️' : 'Unknown'}`);

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(mainnetRpcUrl, {
    timeout: 10_000,
    retryCount: 2,
    retryDelay: 500,
  }),
});

export async function GET() {
  try {
    const [block, priorityFee, gasPrice] = await Promise.all([
      publicClient.getBlock({ blockTag: "latest" }),
      publicClient.estimateMaxPriorityFeePerGas(),
      publicClient.getGasPrice(),
    ]);

    const baseFee = block.baseFeePerGas || 0n;
    const maxFeePerGas = baseFee * 2n + priorityFee;

    return NextResponse.json({
      baseFee: baseFee.toString(),
      priorityFee: priorityFee.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      gasPrice: gasPrice.toString(),
      baseFeeGwei: Number(formatGwei(baseFee)),
      priorityFeeGwei: Number(formatGwei(priorityFee)),
      maxFeeGwei: Number(formatGwei(maxFeePerGas)),
      gasPriceGwei: Number(formatGwei(gasPrice)),
      timestamp: Date.now(),
    });
  } catch (error: any) {
    console.error("[Gas Price API] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch gas price" },
      { status: 500 }
    );
  }
}
