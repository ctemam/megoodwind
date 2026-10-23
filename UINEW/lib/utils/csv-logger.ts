/**
 * CSV Logger for Arbitrage Scan Data
 * Logs all scan results (not just opportunities) for data collection and analysis
 */

import { ArbitrageOpportunity, ScanResult } from "@/types/monitor";

export interface OpportunityRecord {
  timestamp: string;
  tokenPair: string;
  buyDex: string;
  sellDex: string;
  buyPrice: number;
  sellPrice: number;
  priceDiff: number; // %
  estimatedProfit: number; // USD
  netProfit: number; // USD
  slippage?: number; // %
  buySlippage?: number; // %
  sellSlippage?: number; // %
  gasCost: number; // USD
  gasGwei?: number;
  ethPrice: number; // USD
  tradeAmount: number; // ETH
  executionStatus: "pending" | "executing" | "success" | "failed";
  executionError?: string;
  executionTxHash?: string;
  executionGasUsed?: string;
  executionProfitUsd?: number;
}

const CSV_FILE_NAME = "arbitrage-scan-data.csv";
const CSV_DIR = process.env.NEXT_PUBLIC_CSV_DIR || "./data";

/**
 * Initialize CSV file with headers
 */
export function initializeCSV(): void {
  if (typeof window === "undefined") return; // Server-side only

  try {
    const headers = [
      "timestamp",
      "scanNumber",
      "tokenPair",
      "bestSpreadPercent",
      "hasOpportunity",
      "rejectReason", // Why opportunity was not created
      // Buy prices (WETH → Token) - 각 DEX별
      "buyPrice_uniswap_v2",
      "buyPrice_uniswap_v3",
      "buyPrice_uniswap_v3_500",
      "buyPrice_sushiswap",
      "buyPrice_1inch",
      "buyPrice_paraswap",
      // Sell prices (Token → WETH) - 각 DEX별
      "sellPrice_uniswap_v2",
      "sellPrice_uniswap_v3",
      "sellPrice_uniswap_v3_500",
      "sellPrice_sushiswap",
      "sellPrice_1inch",
      "sellPrice_paraswap",
      // Best buy/sell DEX
      "bestBuyDex",
      "bestBuyPrice",
      "bestSellDex",
      "bestSellPrice",
      // Opportunity data (if exists)
      "opportunity_netProfitUsd",
      "opportunity_grossProfitUsd",
      "opportunity_gasCostUsd",
      "opportunity_slippagePercent",
      "opportunity_tradeAmountEth",
      // Market conditions
      "ethPriceUsd",
      "gasGwei",
    ].join(",");

    // Check if file exists in localStorage
    const existing = localStorage.getItem(CSV_FILE_NAME);
    if (!existing) {
      localStorage.setItem(CSV_FILE_NAME, headers + "\n");
      console.log("[CSV Logger] Initialized CSV headers");
    } else {
      console.log("[CSV Logger] CSV already exists, length:", existing.length);
    }
  } catch (error) {
    console.error("[CSV Logger] Failed to initialize:", error);
  }
}

/**
 * Log all scan results to CSV (for data collection)
 * Logs every scan result, regardless of whether opportunity was found
 */
export function logScanResults(
  scanResults: ScanResult[],
  scanNumber: number,
  ethPrice: number | null,
  gasGwei: number | null
): void {
  if (typeof window === "undefined") return; // Client-side only

  try {
    const timestamp = new Date().toISOString();
    const ethPriceValue = ethPrice || 0;
    const gasGweiValue = gasGwei || 0;

    // Log each pair's scan result
    scanResults.forEach((result) => {
      if (!result.debug) return; // Skip if no debug data

      const { wethToTokenQuotes, tokenToWethQuotes, bestSpread } = result.debug;
      const hasOpportunity = result.opportunity !== null;

      // Find best buy/sell DEX
      const bestBuyQuote = wethToTokenQuotes.reduce((best, current) =>
        current.price > best.price ? current : best
      );
      const bestSellQuote = tokenToWethQuotes.reduce((best, current) =>
        current.price > best.price ? current : best
      );

      // Helper function to get price by DEX name
      const getPrice = (quotes: Array<{ dex: string; price: number }>, dexName: string): string => {
        const quote = quotes.find(q => q.dex.toLowerCase() === dexName.toLowerCase());
        return quote ? quote.price.toFixed(6) : "";
      };

      const csvRow = [
        timestamp,
        scanNumber.toString(),
        result.pairSymbol,
        bestSpread.toFixed(4),
        hasOpportunity ? "1" : "0",
        result.error || "", // Reject reason (e.g., "Not profitable after fees", "Slippage too high")
        // Buy prices (WETH → Token)
        getPrice(wethToTokenQuotes, "uniswap_v2"),
        getPrice(wethToTokenQuotes, "uniswap_v3"),
        getPrice(wethToTokenQuotes, "uniswap_v3_500"),
        getPrice(wethToTokenQuotes, "sushiswap"),
        getPrice(wethToTokenQuotes, "1inch"),
        getPrice(wethToTokenQuotes, "paraswap"),
        // Sell prices (Token → WETH)
        getPrice(tokenToWethQuotes, "uniswap_v2"),
        getPrice(tokenToWethQuotes, "uniswap_v3"),
        getPrice(tokenToWethQuotes, "uniswap_v3_500"),
        getPrice(tokenToWethQuotes, "sushiswap"),
        getPrice(tokenToWethQuotes, "1inch"),
        getPrice(tokenToWethQuotes, "paraswap"),
        // Best buy/sell
        bestBuyQuote.dex,
        bestBuyQuote.price.toFixed(6),
        bestSellQuote.dex,
        bestSellQuote.price.toFixed(6),
        // Opportunity data (if exists)
        result.opportunity?.netProfit.toFixed(2) || "",
        result.opportunity?.estimatedProfit.toFixed(2) || "",
        result.opportunity?.estimatedGasCost.toFixed(2) || "",
        result.opportunity?.slippage?.toFixed(4) || "",
        result.opportunity?.tradeAmount.toFixed(4) || "",
        // Market conditions
        ethPriceValue.toFixed(2),
        gasGweiValue.toFixed(2),
      ].join(",");

      // Append to CSV in localStorage
      const existing = localStorage.getItem(CSV_FILE_NAME) || "";
      localStorage.setItem(CSV_FILE_NAME, existing + csvRow + "\n");
    });

    console.log(`[CSV Logger] Logged ${scanResults.length} scan results for scan #${scanNumber}`);
  } catch (error) {
    console.error("[CSV Logger] Failed to log scan results:", error);
  }
}

/**
 * Log opportunity to CSV (for backward compatibility and execution tracking)
 * Note: This is still used to track opportunity execution status
 */
export function logOpportunity(opportunity: ArbitrageOpportunity): void {
  if (typeof window === "undefined") return; // Server-side only

  try {
    const record: OpportunityRecord = {
      timestamp: new Date(opportunity.timestamp).toISOString(),
      tokenPair: opportunity.tokenPair,
      buyDex: opportunity.buyFrom.dex,
      sellDex: opportunity.sellTo.dex,
      buyPrice: opportunity.buyFrom.price,
      sellPrice: opportunity.sellTo.price,
      priceDiff: opportunity.priceDiff,
      estimatedProfit: opportunity.estimatedProfit,
      netProfit: opportunity.netProfit,
      slippage: opportunity.slippage,
      buySlippage: opportunity.buySlippage,
      sellSlippage: opportunity.sellSlippage,
      gasCost: opportunity.estimatedGasCost,
      gasGwei: opportunity.gasPrice?.maxFeeGwei, // Use from opportunity
      ethPrice: opportunity.ethPrice || 0, // Use from opportunity
      tradeAmount: opportunity.tradeAmount || 1,
      executionStatus: opportunity.status,
    };

    const csvRow = [
      record.timestamp,
      record.tokenPair,
      record.buyDex,
      record.sellDex,
      record.buyPrice.toFixed(6),
      record.sellPrice.toFixed(6),
      record.priceDiff.toFixed(4),
      record.estimatedProfit.toFixed(2),
      record.netProfit.toFixed(2),
      record.slippage?.toFixed(4) || "",
      record.buySlippage?.toFixed(4) || "",
      record.sellSlippage?.toFixed(4) || "",
      record.gasCost.toFixed(2),
      record.gasGwei?.toFixed(2) || "",
      record.ethPrice.toFixed(2),
      record.tradeAmount.toFixed(4),
      record.executionStatus,
      record.executionError || "",
      record.executionTxHash || "",
      record.executionGasUsed || "",
      record.executionProfitUsd?.toFixed(2) || "",
    ].join(",");

    // Append to CSV in localStorage
    const existing = localStorage.getItem(CSV_FILE_NAME) || "";
    localStorage.setItem(CSV_FILE_NAME, existing + csvRow + "\n");
    
    // Debug log
    console.log("[CSV Logger] Logged opportunity:", {
      tokenPair: opportunity.tokenPair,
      netProfit: opportunity.netProfit,
      status: opportunity.status,
      csvLength: (existing + csvRow + "\n").length,
    });
  } catch (error) {
    console.error("[CSV Logger] Failed to log opportunity:", error);
  }
}

/**
 * Update execution status in CSV
 */
export function updateExecutionStatus(
  opportunityId: string,
  status: "executing" | "success" | "failed",
  error?: string,
  txHash?: string,
  gasUsed?: string,
  profitUsd?: number
): void {
  if (typeof window === "undefined") return; // Server-side only

  try {
    const csv = localStorage.getItem(CSV_FILE_NAME);
    if (!csv) return;

    // Parse CSV and update matching row
    const lines = csv.split("\n");
    if (lines.length < 2) return; // No data rows

    const headers = lines[0].split(",");
    const executionStatusIndex = headers.indexOf("executionStatus");
    
    if (executionStatusIndex < 0) return;

    // Find the most recent row with "pending" or "executing" status (from bottom to top)
    // This ensures we update the latest opportunity that's waiting for execution
    let updatedIndex = -1;
    const updatedLines = [...lines];

    for (let i = lines.length - 1; i > 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;

      const cols = line.split(",");
      if (cols.length < headers.length) continue;

      const currentStatus = cols[executionStatusIndex];
      
      // Update if status is "pending" or "executing" (allows updating executing -> success/failed)
      if (currentStatus === "pending" || currentStatus === "executing") {
        cols[executionStatusIndex] = status;
        
        if (error !== undefined) {
          const errorIndex = headers.indexOf("executionError");
          if (errorIndex >= 0) {
            cols[errorIndex] = error ? `"${error.replace(/"/g, '""')}"` : "";
          }
        }
        
        if (txHash !== undefined) {
          const txHashIndex = headers.indexOf("executionTxHash");
          if (txHashIndex >= 0) {
            cols[txHashIndex] = txHash || "";
          }
        }
        
        if (gasUsed !== undefined) {
          const gasUsedIndex = headers.indexOf("executionGasUsed");
          if (gasUsedIndex >= 0) {
            cols[gasUsedIndex] = gasUsed || "";
          }
        }
        
        if (profitUsd !== undefined) {
          const profitIndex = headers.indexOf("executionProfitUsd");
          if (profitIndex >= 0) {
            cols[profitIndex] = profitUsd !== undefined && profitUsd !== null ? profitUsd.toFixed(2) : "";
          }
        }

        updatedLines[i] = cols.join(",");
        updatedIndex = i;
        break; // Update only the most recent matching row
      }
    }

    if (updatedIndex >= 0) {
      localStorage.setItem(CSV_FILE_NAME, updatedLines.join("\n"));
      console.log(`[CSV Logger] Updated execution status to "${status}" for opportunity ${opportunityId} (row ${updatedIndex})`);
    } else {
      console.warn(`[CSV Logger] Could not find pending/executing row to update for opportunity ${opportunityId}`);
    }
  } catch (error) {
    console.error("[CSV Logger] Failed to update execution status:", error);
  }
}

/**
 * Download CSV file
 */
export function downloadCSV(): void {
  if (typeof window === "undefined") return; // Server-side only

  try {
    const csv = localStorage.getItem(CSV_FILE_NAME);
    if (!csv) {
      alert("No data to download");
      return;
    }

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);

    link.setAttribute("href", url);
    link.setAttribute("download", `arbitrage-scan-data-${Date.now()}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (error) {
    console.error("[CSV Logger] Failed to download CSV:", error);
  }
}

/**
 * Get CSV data as string
 */
export function getCSVData(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(CSV_FILE_NAME) || "";
}

/**
 * Clear CSV data
 */
export function clearCSV(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(CSV_FILE_NAME);
  initializeCSV();
}

