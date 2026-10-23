/**
 * Simulate arbitrage execution on Mainnet without actually sending transaction
 * Uses eth_call to simulate the transaction
 */

import { createPublicClient, http, encodeFunctionData, Address } from "viem";
import { mainnet } from "viem/chains";
import { ArbitrageOpportunity } from "@/types/monitor";

// Minimal ABI for simulation
const FLASH_LOAN_ARBITRAGE_ABI = [
  {
    inputs: [
      { internalType: "address", name: "asset", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "bytes", name: "params", type: "bytes" },
    ],
    name: "requestBalancerFlashLoan",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface SimulationResult {
  success: boolean;
  error?: string;
  estimatedGas?: bigint;
  gasLimit?: bigint;
  simulationDetails?: string;
  wouldRevert?: boolean;
  revertReason?: string;
}

/**
 * Simulate arbitrage execution using eth_call
 */
export async function simulateArbitrageExecution(
  opportunity: ArbitrageOpportunity,
  contractAddress: string
): Promise<SimulationResult> {
  try {
    const rpcUrl = process.env.NEXT_PUBLIC_ETH_RPC_URL;
    if (!rpcUrl) {
      return {
        success: false,
        error: "RPC URL not configured",
      };
    }

    // Create public client
    const publicClient = createPublicClient({
      chain: mainnet,
      transport: http(rpcUrl),
    });

    // Encode arbitrage parameters
    const arbParams = {
      tokenA: opportunity.tokenIn.address,
      tokenB: opportunity.tokenOut.address,
      dexBuy: opportunity.buyFrom.pairAddress,
      dexSell: opportunity.sellTo.pairAddress,
      feeBuy: 3000, // Default 0.3% for V3 (will be 0 for V2)
      feeSell: 3000,
      minProfit: 0n, // Allow simulation even with low profit
      maxSlippageBps: 100, // 1% slippage for simulation
      isV3Buy: opportunity.buyFrom.dex.includes("v3"),
      isV3Sell: opportunity.sellTo.dex.includes("v3"),
      flashProvider: 2, // Balancer = 2
    };

    // Encode parameters as bytes
    const paramsEncoded = encodeFunctionData({
      abi: [
        {
          inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" },
            { name: "dexBuy", type: "address" },
            { name: "dexSell", type: "address" },
            { name: "feeBuy", type: "uint24" },
            { name: "feeSell", type: "uint24" },
            { name: "minProfit", type: "uint256" },
            { name: "maxSlippageBps", type: "uint16" },
            { name: "isV3Buy", type: "bool" },
            { name: "isV3Sell", type: "bool" },
            { name: "flashProvider", type: "uint8" },
          ],
          name: "encodeParams",
          outputs: [{ type: "bytes" }],
          stateMutability: "pure",
          type: "function",
        },
      ],
      functionName: "encodeParams",
      args: [
        arbParams.tokenA as Address,
        arbParams.tokenB as Address,
        arbParams.dexBuy as Address,
        arbParams.dexSell as Address,
        arbParams.feeBuy,
        arbParams.feeSell,
        arbParams.minProfit,
        arbParams.maxSlippageBps,
        arbParams.isV3Buy,
        arbParams.isV3Sell,
        arbParams.flashProvider,
      ],
    });

    // Calculate flash loan amount in Wei
    const tradeAmountWei = BigInt(Math.floor(opportunity.tradeAmount * 1e18));

    // Try to estimate gas (this will revert if the transaction would fail)
    try {
      const gasEstimate = await publicClient.estimateGas({
        account: contractAddress as Address, // Use contract as sender for simulation
        to: contractAddress as Address,
        data: encodeFunctionData({
          abi: FLASH_LOAN_ARBITRAGE_ABI,
          functionName: "requestBalancerFlashLoan",
          args: [
            opportunity.tokenIn.address as Address,
            tradeAmountWei,
            paramsEncoded as `0x${string}`,
          ],
        }),
      });

      return {
        success: true,
        estimatedGas: gasEstimate,
        gasLimit: (gasEstimate * 120n) / 100n, // Add 20% buffer
        simulationDetails: `Gas estimate: ${gasEstimate.toString()} units`,
        wouldRevert: false,
      };
    } catch (estimateError: any) {
      // If gas estimation fails, the transaction would revert
      const errorMessage = estimateError.message || estimateError.toString();

      // Try to extract revert reason
      let revertReason = "Transaction would revert";
      if (errorMessage.includes("execution reverted")) {
        const match = errorMessage.match(/execution reverted: (.+?)(?:\n|$)/);
        if (match) {
          revertReason = match[1];
        }
      } else if (errorMessage.includes("Unprofitable")) {
        revertReason = "Unprofitable arbitrage";
      } else if (errorMessage.includes("insufficient")) {
        revertReason = "Insufficient liquidity or balance";
      }

      return {
        success: false,
        wouldRevert: true,
        revertReason,
        error: `Simulation failed: ${revertReason}`,
        simulationDetails: errorMessage,
      };
    }
  } catch (error: any) {
    return {
      success: false,
      error: `Simulation error: ${error.message || "Unknown error"}`,
    };
  }
}

/**
 * Format simulation result for display
 */
export function formatSimulationResult(result: SimulationResult): string {
  if (!result.success) {
    if (result.wouldRevert) {
      return `❌ Would Revert: ${result.revertReason}`;
    }
    return `❌ Error: ${result.error}`;
  }

  const gasInK = Number(result.estimatedGas || 0n) / 1000;
  return `✅ Estimated Gas: ${gasInK.toFixed(0)}k units`;
}
