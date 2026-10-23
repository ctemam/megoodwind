"use client";

import { useState, useEffect, useCallback } from "react";
import { ArbitrageState, ArbitrageSettings, ArbitrageOpportunity, ScanLog, LogLevel, ChainId } from "@/types/monitor";
import { DEFAULT_ARBITRAGE_CONFIG, DEFAULT_ARBITRAGE_SETTINGS, NETWORKS, getDefaultWatchedTokens } from "@/lib/config";
import { getCurrentGasPrice } from "@/lib/utils/gas-price";
import { getEthPriceCached } from "@/lib/utils/eth-price";
import { scanAllWETHPairs } from "@/lib/utils/weth-arbitrage-scanner";
import { initializeCSV, logOpportunity, updateExecutionStatus, logScanResults } from "@/lib/utils/csv-logger";
import { simulateArbitrageExecution, formatSimulationResult } from "@/lib/utils/simulate-arbitrage";

/**
 * 차익거래 상태 관리 훅
 */
export function useArbitrage() {
  // HARDCODED: Always use Mainnet (Chain ID: 1)
  const FIXED_CHAIN_ID = 1; // Ethereum Mainnet

  const [state, setState] = useState<ArbitrageState>({
    isScanning: false,
    chainId: FIXED_CHAIN_ID, // Fixed to Mainnet
    lastUpdate: Date.now(),
    opportunities: [],
    scanResults: [],
    config: DEFAULT_ARBITRAGE_CONFIG,
    settings: {
      ...DEFAULT_ARBITRAGE_SETTINGS,
      watchedTokens: getDefaultWatchedTokens(FIXED_CHAIN_ID), // Mainnet tokens only
    },
    logs: [],
    gasPrice: null,
    ethPrice: null,
    stats: {
      totalScanned: 0,
      opportunitiesFound: 0,
      totalProfit: 0,
    },
  });

  const addLog = useCallback((level: LogLevel, message: string) => {
    const log: ScanLog = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
      level,
      message,
    };
    setState((prev) => ({
      ...prev,
      logs: [log, ...prev.logs].slice(0, 100), // Keep last 100 logs
    }));
  }, []);

  const startScanning = useCallback(async () => {
    setState((prev) => ({
      ...prev,
      isScanning: true,
      lastUpdate: Date.now(),
    }));
    addLog("info", "Scanner started on Ethereum Mainnet");

    // Fetch initial gas price
    try {
      const gasData = await getCurrentGasPrice();
      setState((prev) => ({
        ...prev,
        gasPrice: {
          baseFeeGwei: gasData.baseFeeGwei,
          priorityFeeGwei: gasData.priorityFeeGwei,
          maxFeeGwei: gasData.maxFeeGwei,
          timestamp: gasData.timestamp,
        },
      }));
      addLog("info", `Current gas: ${gasData.maxFeeGwei.toFixed(1)} Gwei (base: ${gasData.baseFeeGwei.toFixed(1)} + priority: ${gasData.priorityFeeGwei.toFixed(1)})`);
    } catch (error) {
      addLog("error", `Failed to fetch gas price: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Fetch initial ETH price
    try {
      const ethPrice = await getEthPriceCached(FIXED_CHAIN_ID);
      setState((prev) => ({
        ...prev,
        ethPrice,
      }));
      addLog("info", `ETH price: $${ethPrice.toFixed(2)} (Chainlink)`);
    } catch (error) {
      addLog("error", `Failed to fetch ETH price: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [addLog]);

  const stopScanning = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isScanning: false,
    }));
    addLog("warning", "Scanner stopped");
  }, [addLog]);

  const updateSettings = useCallback((settings: ArbitrageSettings) => {
    setState((prev) => ({
      ...prev,
      settings,
    }));
  }, []);

  const setChainId = useCallback((chainId: ChainId) => {
    // DISABLED: Network switching is disabled, always use Mainnet
    addLog("warning", "Network switching disabled - using Mainnet only");
    return;
  }, [addLog]);

  const addOpportunity = useCallback((opportunity: ArbitrageOpportunity) => {
    setState((prev) => ({
      ...prev,
      opportunities: [opportunity, ...prev.opportunities].slice(0, 50), // 최근 50개만 유지
      lastUpdate: Date.now(),
      stats: {
        ...prev.stats,
        opportunitiesFound: prev.stats.opportunitiesFound + 1,
      },
    }));
    addLog("success", `Found opportunity: ${opportunity.tokenPair} (+${opportunity.priceDiff.toFixed(2)}%)`);
    
    // Log to CSV (ethPrice and gasPrice are now in the opportunity object)
    logOpportunity(opportunity);
  }, [addLog]);

  const clearOpportunities = useCallback(() => {
    setState((prev) => ({
      ...prev,
      opportunities: [],
    }));
    addLog("info", "Cleared all opportunities");
  }, [addLog]);

  const executeArbitrage = useCallback(async (opportunityId: string) => {
    const opportunity = state.opportunities.find(o => o.id === opportunityId);
    if (!opportunity) return;

    // MAINNET MODE: Execution disabled for safety
    // This is a monitoring-only interface
    addLog("warning", `⚠️ Manual execution required for Mainnet safety`);
    addLog("info", `📋 Opportunity: ${opportunity.tokenPair} | Profit: $${opportunity.netProfit.toFixed(2)}`);
    addLog("info", `📍 Contract: ${process.env.NEXT_PUBLIC_CONTRACT_ADDRESS || 'Not configured'}`);

    return;
  }, [state.opportunities, addLog]);

  const simulateArbitrage = useCallback(async (opportunityId: string) => {
    const opportunity = state.opportunities.find(o => o.id === opportunityId);
    if (!opportunity) return;

    const contractAddress = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS;
    if (!contractAddress) {
      addLog("error", "❌ Contract address not configured");
      return;
    }

    addLog("info", `🔬 Simulating ${opportunity.tokenPair}...`);

    // Update status to simulating
    setState((prev) => ({
      ...prev,
      opportunities: prev.opportunities.map((opp) =>
        opp.id === opportunityId ? { ...opp, status: "executing" as const } : opp
      ),
    }));

    try {
      const result = await simulateArbitrageExecution(opportunity, contractAddress);

      if (result.success) {
        addLog("success", `✅ Simulation passed: ${formatSimulationResult(result)}`);
        addLog("info", `💰 Expected profit: $${opportunity.netProfit.toFixed(2)}`);
        addLog("info", `⛽ Gas estimate: ${result.estimatedGas?.toString()} units`);

        setState((prev) => ({
          ...prev,
          opportunities: prev.opportunities.map((opp) =>
            opp.id === opportunityId ? { ...opp, status: "pending" as const } : opp
          ),
        }));
      } else {
        addLog("error", `❌ ${formatSimulationResult(result)}`);
        if (result.simulationDetails) {
          addLog("error", `Details: ${result.simulationDetails.substring(0, 200)}`);
        }

        setState((prev) => ({
          ...prev,
          opportunities: prev.opportunities.map((opp) =>
            opp.id === opportunityId ? { ...opp, status: "failed" as const } : opp
          ),
        }));
      }
    } catch (error: any) {
      addLog("error", `❌ Simulation error: ${error.message || 'Unknown error'}`);

      setState((prev) => ({
        ...prev,
        opportunities: prev.opportunities.map((opp) =>
          opp.id === opportunityId ? { ...opp, status: "failed" as const } : opp
        ),
      }));
    }
  }, [state.opportunities, addLog]);

  // Initialize CSV logger on mount
  useEffect(() => {
    initializeCSV();
  }, []);

  // Auto-execute disabled for Mainnet safety
  // Monitoring-only mode

  // 스캐닝 루프 - Real price fetching
  useEffect(() => {
    if (!state.isScanning) return;

    let scanCount = 0;
    let isMounted = true;

    const scanForOpportunities = async () => {
      if (!isMounted) return;
      scanCount++;

      try {
        addLog("info", `🔍 Scanning high-liquidity WETH pairs...`);

        // Ensure gas price is fetched before scanning (for accurate profitability calculation)
        let currentGasPrice = state.gasPrice;
        if (!currentGasPrice || scanCount === 1) {
          try {
            const gasData = await getCurrentGasPrice();
            currentGasPrice = {
              baseFeeGwei: gasData.baseFeeGwei,
              priorityFeeGwei: gasData.priorityFeeGwei,
              maxFeeGwei: gasData.maxFeeGwei,
              timestamp: gasData.timestamp,
            };
            setState((prev) => ({
              ...prev,
              gasPrice: currentGasPrice,
            }));
            addLog("info", `⛽ Gas: ${currentGasPrice.maxFeeGwei.toFixed(1)} Gwei (mainnet)`);
          } catch (error) {
            addLog("warning", "Failed to fetch gas price, using fallback 30 Gwei");
            // Use fallback gas price
            currentGasPrice = {
              baseFeeGwei: 10,
              priorityFeeGwei: 2,
              maxFeeGwei: 30,
              timestamp: Date.now(),
            };
          }
        }

        // Get ETH price from Chainlink
        let ethPriceUsd = 3500; // Fallback
        try {
          ethPriceUsd = await getEthPriceCached(FIXED_CHAIN_ID);
        } catch (error) {
          addLog("warning", "Failed to fetch ETH price, using fallback $3500");
        }

        // Scan all high-liquidity WETH pairs (WETH/USDC, WETH/USDT, etc.)
        // Use currentGasPrice (just fetched) instead of state.gasPrice (may be stale)
        const results = await scanAllWETHPairs(
          FIXED_CHAIN_ID, // Always use Mainnet
          state.settings.tradeAmount, // WETH amount (e.g., 1 ETH)
          currentGasPrice, // Use freshly fetched gas price
          ethPriceUsd,
          state.settings.maxSlippage, // Maximum acceptable slippage
          state.settings.flashLoanProtocol // Flash loan protocol (Balancer, Aave V3, etc.)
        );

        // Log all scan results to CSV (for data collection)
        // Use scanCount instead of state.stats.totalScanned for accurate count
        logScanResults(
          results,
          scanCount,
          ethPriceUsd,
          currentGasPrice?.maxFeeGwei || null
        );
        
        // Store all scan results with fresh array reference
        setState((prev) => ({
          ...prev,
          scanResults: [...results], // Create new array to trigger re-render
          lastUpdate: Date.now(), // Force update
          stats: {
            ...prev.stats,
            totalScanned: scanCount, // Use scanCount instead of newScanNumber
          },
        }));

        // Count scanned pairs
        const scannedCount = results.filter((r) => r.scanned).length;

        // Log the latest pair being displayed
        if (results.length > 0) {
          const latestResult = results[results.length - 1];
          const latestPrice = latestResult.debug?.wethToTokenQuotes[0]?.price || 0;
          addLog("info", `📊 Scanned ${scannedCount} pairs | Latest: ${latestResult.pairSymbol} @ $${latestPrice.toFixed(2)}`);
        } else {
          addLog("info", `📊 Scanned ${scannedCount} WETH pairs (${results.length} total results)`);
        }

        // Process results
        let foundCount = 0;
        for (const result of results) {
          // Log debug info for each pair
          if (result.debug) {
            const d = result.debug;
            addLog(
              "info",
              `🔍 ${result.pairSymbol}: Found ${d.quotesCount} quotes (${d.wethToTokenQuotes.length} WETH→Token, ${d.tokenToWethQuotes.length} Token→WETH) | Best spread: ${d.bestSpread.toFixed(4)}%`
            );

            // Log individual DEX prices
            if (d.wethToTokenQuotes.length > 0) {
              const prices = d.wethToTokenQuotes
                .map((q) => `${q.dex}: $${q.price.toFixed(2)}`)
                .join(", ");
              addLog("info", `  Buy (WETH→Token): ${prices}`);
            }
            if (d.tokenToWethQuotes.length > 0) {
              const prices = d.tokenToWethQuotes
                .map((q) => `${q.dex}: $${(1 / q.price).toFixed(2)}`) // Invert to USD
                .join(", ");
              addLog("info", `  Sell (Token→WETH): ${prices}`);
            }
          }

          if (result.opportunity) {
            addOpportunity(result.opportunity);
            foundCount++;

            const opp = result.opportunity;
            addLog(
              "success",
              `✅ ${result.pairSymbol}: ${opp.buyFrom.dex.toUpperCase()} ($${opp.buyFrom.price.toFixed(4)}) → ${opp.sellTo.dex.toUpperCase()} ($${opp.sellTo.price.toFixed(4)}) | Net: $${opp.netProfit.toFixed(2)}`
            );

            // Detailed verification log
            addLog(
              "info",
              `📊 Details: Gross: $${opp.estimatedProfit.toFixed(2)} - Gas: $${opp.estimatedGasCost.toFixed(2)} - FL Fee: $${(1 * ethPriceUsd * 0.0005).toFixed(2)} = Net: $${opp.netProfit.toFixed(2)}`
            );

            addLog(
              "info",
              `🔗 Verify: Buy @ ${opp.buyFrom.dex} pair ${opp.buyFrom.pairAddress.slice(0, 10)}... | Sell @ ${opp.sellTo.dex} pair ${opp.sellTo.pairAddress.slice(0, 10)}...`
            );
          } else if (result.error) {
            addLog("error", `❌ ${result.pairSymbol}: ${result.error}`);
          }
        }

        if (foundCount === 0) {
          addLog("info", `No profitable opportunities (min profit: $${state.settings.minProfitUsd})`);
        } else {
          addLog("warning", `🔥 Found ${foundCount} profitable opportunities!`);
        }
      } catch (error) {
        addLog("error", `Scan error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Update gas price every 3 scans (~15 seconds with 5s interval)
      if (scanCount % 3 === 0) {
        // Update gas price
        try {
          const gasData = await getCurrentGasPrice();
          setState((prev) => ({
            ...prev,
            gasPrice: {
              baseFeeGwei: gasData.baseFeeGwei,
              priorityFeeGwei: gasData.priorityFeeGwei,
              maxFeeGwei: gasData.maxFeeGwei,
              timestamp: gasData.timestamp,
            },
          }));

          if (gasData.maxFeeGwei > state.settings.maxGasPrice) {
            addLog("warning", `⛽ Gas ${gasData.maxFeeGwei.toFixed(1)} Gwei exceeds max ${state.settings.maxGasPrice} Gwei`);
          } else {
            addLog("info", `⛽ Gas: ${gasData.maxFeeGwei.toFixed(1)} Gwei`);
          }
        } catch (error) {
          addLog("error", `Failed to update gas price: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        // Update ETH price
        try {
          const ethPrice = await getEthPriceCached(FIXED_CHAIN_ID);
          setState((prev) => ({
            ...prev,
            ethPrice,
          }));
          addLog("info", `💎 ETH: $${ethPrice.toFixed(2)}`);
        } catch (error) {
          addLog("error", `Failed to update ETH price: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    };

    // Run immediately on mount/start
    scanForOpportunities();

    const interval = setInterval(() => {
      if (isMounted) {
        scanForOpportunities();
      }
    }, state.config.refreshInterval);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
    // Only depend on essential values that should restart the scan
    // chainId is fixed to Mainnet, no need to include in dependencies
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isScanning, state.config.refreshInterval]);

  return {
    state,
    startScanning,
    stopScanning,
    updateSettings,
    setChainId,
    addOpportunity,
    clearOpportunities,
    executeArbitrage,
    simulateArbitrage,
  };
}
