/**
 * WETH-based 2-hop Arbitrage Scanner (BIDIRECTIONAL)
 *
 * Scans BOTH directions:
 * 1. WETH → Token → WETH
 * 2. Token → WETH → Token (then convert back)
 */

import { getHighLiquidityPairs, getWETHAddress, ARBITRAGE_STRATEGY } from "@/lib/config/high-liquidity-pairs";
import { getMultiDexQuotes, findBestArbitrage } from "@/lib/utils/dex-prices-client";
import { ArbitrageOpportunity, ChainId, GasPrice, FlashLoanProtocol } from "@/types/monitor";
import { calculateGasCostUSD, getEstimatedGasUnits } from "@/lib/utils/gas-price";
import { calculateArbitrageSlippage, isSlippageAcceptable } from "@/lib/utils/slippage";
import { parseUnits, Address } from "viem";

/**
 * Calculate optimal trade amount for maximum profit
 * 
 * Profit formula: NetProfit = (spread% * amount * ethPrice) - gasCost - (flashLoanFee% * amount * ethPrice)
 *                           = amount * ethPrice * (spread% - flashLoanFee%) - gasCost
 * 
 * NOTE: spreadPercent and flashLoanFeePercent are in percentage form (e.g., 0.5 means 0.5%, NOT 50%)
 * 
 * Constraints:
 * - Minimum: Cover fixed costs (gas) + minimum profit
 * - Maximum: Limited by liquidity and slippage (default 10 ETH)
 * - Optimal: Maximize profit within constraints
 */
function calculateOptimalTradeAmount(
  spreadPercent: number, // Price difference in % (e.g., 0.5 = 0.5%)
  gasCostUsd: number, // Fixed gas cost in USD
  flashLoanFeePercent: number, // Flash loan fee in % (e.g., 0.09 = 0.09%)
  ethPriceUsd: number, // ETH price in USD
  maxSlippagePercent: number, // Maximum acceptable slippage (e.g., 0.5 = 0.5%)
  estimatedSlippage: number, // Estimated slippage at 1 ETH (e.g., 0.1 = 0.1%)
  minProfitUsd: number, // Minimum profit required in USD
  maxAmount: number = 10 // Maximum 10 ETH (safety limit)
): number {
  // Convert percentages to decimals (0.5% → 0.005)
  const spreadDecimal = spreadPercent / 100;
  const flashLoanFeeDecimal = flashLoanFeePercent / 100;
  const maxSlippageDecimal = maxSlippagePercent / 100;
  const estimatedSlippageDecimal = estimatedSlippage / 100;
  
  // Effective spread after flash loan fee (in decimal form)
  const effectiveSpread = spreadDecimal - flashLoanFeeDecimal;
  
  if (effectiveSpread <= 0) {
    // Not profitable at any amount - flash loan fee exceeds spread
    // Log for high spreads to debug
    if (spreadPercent >= 0.17) {
      console.log(`[OptimalAmount] ${spreadPercent.toFixed(4)}% REJECTED: effectiveSpread <= 0`, {
        spreadPercent: `${spreadPercent.toFixed(4)}%`,
        spreadDecimal: spreadDecimal.toFixed(6),
        flashLoanFeePercent: `${flashLoanFeePercent}%`,
        flashLoanFeeDecimal: flashLoanFeeDecimal.toFixed(6),
        effectiveSpread: `${(effectiveSpread * 100).toFixed(4)}%`,
      });
    }
    return 0;
  }
  
  // NetProfit = amount * ethPrice * effectiveSpread - gasCost
  // For NetProfit >= minProfitUsd:
  // amount * ethPrice * effectiveSpread - gasCost >= minProfitUsd
  // amount >= (gasCost + minProfitUsd) / (ethPrice * effectiveSpread)
  
  const minAmountForProfit = (gasCostUsd + minProfitUsd) / (ethPriceUsd * effectiveSpread);
  
  // Start with minimum amount needed for target profit
  let optimalAmount = Math.max(minAmountForProfit, 0.1); // At least 0.1 ETH
  
  // Debug: Log min amount calculation
  const minAmountBeforeSlippage = optimalAmount;
  
  // Adjust for slippage: slippage typically scales with sqrt(amount) for AMMs
  // If slippage at 1 ETH is X%, at N ETH it's roughly X% * sqrt(N)
  let slippageAtOptimal = 0;
  let slippageLimited = false;
  if (estimatedSlippageDecimal > 0) {
    slippageAtOptimal = estimatedSlippageDecimal * Math.sqrt(optimalAmount);
    if (slippageAtOptimal > maxSlippageDecimal) {
      // Reduce amount to keep slippage within limits
      // slippage * sqrt(newAmount) = maxSlippage
      // newAmount = (maxSlippage / slippage)^2
      const scaleFactor = (maxSlippageDecimal / estimatedSlippageDecimal) ** 2;
      optimalAmount = Math.min(optimalAmount, scaleFactor);
      slippageLimited = true;
    }
  }
  
  // Cap at maximum safety limit
  const beforeMaxCap = optimalAmount;
  optimalAmount = Math.min(optimalAmount, maxAmount);
  const maxCapLimited = beforeMaxCap > maxAmount;
  
  // Round to reasonable precision (0.01 ETH)
  const beforeRound = optimalAmount;
  optimalAmount = Math.floor(optimalAmount * 100) / 100;
  
  // Enhanced debug logging for high spreads (even if amount < 1 ETH)
  if (spreadPercent >= 0.17) {
    console.log(`[OptimalAmount] ${spreadPercent.toFixed(4)}% spread calculation:`, {
      spreadPercent: `${spreadPercent.toFixed(4)}%`,
      flashLoanFeePercent: `${flashLoanFeePercent}%`,
      effectiveSpread: `${(effectiveSpread * 100).toFixed(4)}%`,
      gasCostUsd: `$${gasCostUsd.toFixed(4)}`,
      minProfitUsd: `$${minProfitUsd}`,
      ethPriceUsd: `$${ethPriceUsd.toFixed(2)}`,
      minAmountForProfit: `${minAmountForProfit.toFixed(6)} ETH`,
      minAmountBeforeSlippage: `${minAmountBeforeSlippage.toFixed(6)} ETH`,
      estimatedSlippage: `${estimatedSlippage.toFixed(2)}%`,
      slippageAtOptimal: `${(slippageAtOptimal * 100).toFixed(4)}%`,
      maxSlippage: `${maxSlippagePercent}%`,
      slippageLimited: slippageLimited,
      beforeMaxCap: `${beforeMaxCap.toFixed(6)} ETH`,
      maxCapLimited: maxCapLimited,
      beforeRound: `${beforeRound.toFixed(6)} ETH`,
      finalOptimalAmount: `${optimalAmount.toFixed(6)} ETH`,
    });
  }
  
  return optimalAmount;
}

export interface ScanResult {
  opportunity: ArbitrageOpportunity | null;
  pairSymbol: string;
  scanned: boolean;
  error?: string;
  debug?: {
    wethToTokenQuotes: Array<{ dex: string; price: number }>;
    tokenToWethQuotes: Array<{ dex: string; price: number }>;
    bestSpread: number;
    quotesCount: number;
  };
}

/**
 * Scan a single WETH pair for arbitrage (BOTH DIRECTIONS)
 */
export async function scanWETHPair(
  chainId: ChainId,
  tokenAddress: string,
  tokenSymbol: string,
  tokenDecimals: number,
  wethAmount: number,
  gasPrice: GasPrice | null,
  ethPriceUsd: number,
  maxSlippage: number = 0.5, // Default 0.5% max slippage
  flashLoanProtocol: FlashLoanProtocol = FlashLoanProtocol.AAVE_V3
): Promise<ScanResult> {
  const wethAddress = getWETHAddress(chainId);
  const pairSymbol = `WETH/${tokenSymbol}`;

  try {
    // Get WETH → Token prices from all DEXes
    const wethToTokenQuotes = await getMultiDexQuotes(
      wethAddress as `0x${string}`,
      tokenAddress as `0x${string}`,
      18,
      tokenDecimals
    );

    // Get Token → WETH prices from all DEXes
    const tokenToWethQuotes = await getMultiDexQuotes(
      tokenAddress as `0x${string}`,
      wethAddress as `0x${string}`,
      tokenDecimals,
      18
    );

    let bestOpportunity: ArbitrageOpportunity | null = null;
    let bestNetProfit = 0;

    // === Strategy: WETH → Token → WETH ===
    // Find best combination: Buy Token cheap (high Token/WETH), Sell Token expensive (high WETH/Token)
    if (wethToTokenQuotes.length >= 1 && tokenToWethQuotes.length >= 1) {
      // Find DEX where we get most Token per WETH (buy Token)
      const buyDex = wethToTokenQuotes.reduce((best, current) =>
        current.price > best.price ? current : best
      );

      // Find DEX where we get most WETH per Token (sell Token)
      const sellDex = tokenToWethQuotes.reduce((best, current) =>
        current.price > best.price ? current : best
      );

      // Avoid same DEX (no arbitrage possible)
      if (buyDex.dex !== sellDex.dex) {
        // Step 1: Calculate price difference at 1 ETH (for initial assessment)
        const testAmount = 1; // 1 ETH for initial calculation
        const tokenReceived = testAmount * buyDex.price; // Buy token: WETH → Token
        const wethReceived = tokenReceived * sellDex.price; // Sell token: Token → WETH
        const priceDiff = ((wethReceived - testAmount) / testAmount) * 100;

        // Debug: Log price calculation for high spreads
        if (priceDiff >= 0.15) {
          console.log(`[PriceCalc] ${pairSymbol}:`, {
            buyDex: buyDex.dex,
            buyPrice: buyDex.price.toFixed(6),
            sellDex: sellDex.dex,
            sellPrice: sellDex.price.toFixed(6),
            testAmount: `${testAmount} ETH`,
            tokenReceived: tokenReceived.toFixed(6),
            wethReceived: wethReceived.toFixed(6),
            priceDiff: `${priceDiff.toFixed(4)}%`,
            minSpreadRequired: `${ARBITRAGE_STRATEGY.minSpreadPercent}%`,
          });
        }

        // Only proceed if spread is large enough
        if (priceDiff >= ARBITRAGE_STRATEGY.minSpreadPercent) {
          // Step 2: Calculate fixed costs
          const gasUnits = getEstimatedGasUnits(buyDex.dex, sellDex.dex);
          // Use actual mainnet gas price (fetched from API) even in Hardhat fork
          // This simulates real-world conditions for accurate profitability calculation
          // Use gasPriceGwei (actual gas price) instead of maxFeeGwei (maximum fee)
          // maxFeeGwei is conservative but may be too high for realistic calculations
          // gasPriceGwei is the actual current gas price, which is more accurate
          const gasPriceGwei = gasPrice?.gasPriceGwei || gasPrice?.baseFeeGwei || gasPrice?.maxFeeGwei || 30;
          const gasCostUsd = calculateGasCostUSD(gasUnits, gasPriceGwei, ethPriceUsd);
          
          // Debug: Log gas cost calculation for high spreads
          if (priceDiff >= 0.17) {
            console.log(`[GasCalc] ${pairSymbol}:`, {
              chainId: chainId,
              buyDex: buyDex.dex,
              sellDex: sellDex.dex,
              gasUnits: gasUnits.toLocaleString(),
              gasPriceFromAPI: gasPrice?.gasPriceGwei || gasPrice?.baseFeeGwei || gasPrice?.maxFeeGwei || 'null',
              gasPriceGweiUsed: gasPriceGwei,
              maxFeeGwei: gasPrice?.maxFeeGwei || 'null',
              baseFeeGwei: gasPrice?.baseFeeGwei || 'null',
              ethPriceUsd: `$${ethPriceUsd.toFixed(2)}`,
              gasCostUsd: `$${gasCostUsd.toFixed(4)}`,
              gasCostEth: `${(gasCostUsd / ethPriceUsd).toFixed(8)} ETH`,
            });
          }
          
          // Step 3: Estimate slippage at 1 ETH (for optimal amount calculation)
          let estimatedSlippage = 0.3; // Default estimate
          try {
            if (buyDex.pairAddress && sellDex.pairAddress) {
              const testAmountWei = parseUnits(testAmount.toString(), 18);
              const buyDexType = buyDex.dex.includes("v3") ? "v3" : "v2";
              const sellDexType = sellDex.dex.includes("v3") ? "v3" : "v2";
              
              const slippageResult = await calculateArbitrageSlippage(
                buyDex.pairAddress as Address,
                sellDex.pairAddress as Address,
                testAmountWei,
                tokenAddress as Address,
                wethAddress as Address,
                buyDexType,
                sellDexType,
                chainId
              );
              estimatedSlippage = slippageResult.totalSlippage;
            }
          } catch (error) {
            console.warn(`[Slippage] Failed to estimate for ${pairSymbol}:`, error);
          }

          // Debug: Log slippage estimation for high spreads
          if (priceDiff >= 0.17) {
            console.log(`[SlippageEst] ${pairSymbol}:`, {
              estimatedSlippage: `${estimatedSlippage.toFixed(2)}%`,
              maxSlippage: `${maxSlippage}%`,
              buyPairAddress: buyDex.pairAddress || 'N/A',
              sellPairAddress: sellDex.pairAddress || 'N/A',
            });
          }

          // Step 4: Calculate optimal trade amount
          const optimalAmount = calculateOptimalTradeAmount(
            priceDiff,
            gasCostUsd,
            ARBITRAGE_STRATEGY.flashLoanFeePercent,
            ethPriceUsd,
            maxSlippage,
            estimatedSlippage,
            ARBITRAGE_STRATEGY.minProfitUsd
          );

          if (optimalAmount <= 0) {
            // Not profitable at any amount
            // Enhanced debugging for high spreads
            if (priceDiff >= 0.17) {
              const effectiveSpread = (priceDiff / 100) - (ARBITRAGE_STRATEGY.flashLoanFeePercent / 100);
              const minAmountForProfit = (gasCostUsd + ARBITRAGE_STRATEGY.minProfitUsd) / (ethPriceUsd * effectiveSpread);
              console.log(`[Debug] ${pairSymbol} REJECTED:`, {
                spread: `${priceDiff.toFixed(4)}%`,
                flashLoanFee: `${ARBITRAGE_STRATEGY.flashLoanFeePercent}%`,
                effectiveSpread: `${(effectiveSpread * 100).toFixed(4)}%`,
                gasCostUsd: `$${gasCostUsd.toFixed(2)}`,
                minProfitUsd: `$${ARBITRAGE_STRATEGY.minProfitUsd}`,
                ethPriceUsd: `$${ethPriceUsd.toFixed(2)}`,
                minAmountForProfit: `${minAmountForProfit.toFixed(4)} ETH`,
                optimalAmount: `${optimalAmount.toFixed(4)} ETH`,
                gasPriceGwei: gasPrice?.maxFeeGwei || 30,
                estimatedSlippage: `${estimatedSlippage.toFixed(2)}%`,
                maxSlippage: `${maxSlippage}%`,
              });
            }
            return {
              opportunity: null,
              pairSymbol,
              scanned: true,
              error: "Not profitable after fees",
              debug: {
                wethToTokenQuotes: wethToTokenQuotes.map(q => ({ dex: q.dex, price: q.price })),
                tokenToWethQuotes: tokenToWethQuotes.map(q => ({ dex: q.dex, price: q.price })),
                bestSpread: priceDiff,
                quotesCount: wethToTokenQuotes.length + tokenToWethQuotes.length,
              },
            };
          }

          // Step 5: Recalculate with optimal amount
          const optimalTokenReceived = optimalAmount * buyDex.price;
          const optimalWethReceived = optimalTokenReceived * sellDex.price;
          const optimalWethProfit = optimalWethReceived - optimalAmount;
          const optimalGrossProfitUsd = optimalWethProfit * ethPriceUsd;
          const optimalFlashLoanFeeUsd = (ARBITRAGE_STRATEGY.flashLoanFeePercent / 100) * optimalAmount * ethPriceUsd;
          const optimalNetProfitUsd = optimalGrossProfitUsd - gasCostUsd - optimalFlashLoanFeeUsd;

          // Debug: Log profit calculation for high spreads
          if (priceDiff >= 0.17) {
            console.log(`[ProfitCalc] ${pairSymbol}:`, {
              optimalAmount: `${optimalAmount.toFixed(4)} ETH`,
              optimalTokenReceived: optimalTokenReceived.toFixed(6),
              optimalWethReceived: optimalWethReceived.toFixed(6),
              optimalWethProfit: `${optimalWethProfit.toFixed(6)} ETH`,
              optimalGrossProfitUsd: `$${optimalGrossProfitUsd.toFixed(4)}`,
              optimalFlashLoanFeeUsd: `$${optimalFlashLoanFeeUsd.toFixed(4)}`,
              gasCostUsd: `$${gasCostUsd.toFixed(4)}`,
              optimalNetProfitUsd: `$${optimalNetProfitUsd.toFixed(4)}`,
              minProfitUsd: `$${ARBITRAGE_STRATEGY.minProfitUsd}`,
              meetsMinProfit: optimalNetProfitUsd >= ARBITRAGE_STRATEGY.minProfitUsd,
              flashLoanFeePercent: `${ARBITRAGE_STRATEGY.flashLoanFeePercent}%`,
            });
          }

          // Debug: Log if net profit doesn't meet minimum requirement
          if (priceDiff >= 0.17 && optimalNetProfitUsd < ARBITRAGE_STRATEGY.minProfitUsd) {
            console.log(`[ProfitTooLow] ${pairSymbol} REJECTED:`, {
              optimalNetProfitUsd: `$${optimalNetProfitUsd.toFixed(4)}`,
              minProfitUsd: `$${ARBITRAGE_STRATEGY.minProfitUsd}`,
              shortfall: `$${(ARBITRAGE_STRATEGY.minProfitUsd - optimalNetProfitUsd).toFixed(4)}`,
              spread: `${priceDiff.toFixed(4)}%`,
              optimalAmount: `${optimalAmount.toFixed(4)} ETH`,
              optimalGrossProfitUsd: `$${optimalGrossProfitUsd.toFixed(4)}`,
              gasCostUsd: `$${gasCostUsd.toFixed(4)}`,
              flashLoanFeeUsd: `$${optimalFlashLoanFeeUsd.toFixed(4)}`,
            });
          }

          if (optimalNetProfitUsd >= ARBITRAGE_STRATEGY.minProfitUsd && optimalNetProfitUsd > bestNetProfit) {
            // Step 6: Calculate actual slippage at optimal amount
            let buySlippage = 0;
            let sellSlippage = 0;
            let totalSlippage = 0;

            try {
              if (buyDex.pairAddress && sellDex.pairAddress) {
                const optimalAmountWei = parseUnits(optimalAmount.toString(), 18);
                const buyDexType = buyDex.dex.includes("v3") ? "v3" : "v2";
                const sellDexType = sellDex.dex.includes("v3") ? "v3" : "v2";

                const slippageResult = await calculateArbitrageSlippage(
                  buyDex.pairAddress as Address,
                  sellDex.pairAddress as Address,
                  optimalAmountWei,
                  tokenAddress as Address,
                  wethAddress as Address,
                  buyDexType,
                  sellDexType,
                  chainId
                );

                buySlippage = slippageResult.buySlippage;
                sellSlippage = slippageResult.sellSlippage;
                totalSlippage = slippageResult.totalSlippage;
              }
            } catch (error) {
              console.warn(`[Slippage] Failed to calculate for ${pairSymbol}:`, error);
              totalSlippage = estimatedSlippage;
            }

            // Check if slippage is acceptable
            if (!isSlippageAcceptable(totalSlippage, maxSlippage)) {
              // Enhanced slippage rejection logging
              console.log(`[SlippageReject] ${pairSymbol} REJECTED:`, {
                totalSlippage: `${totalSlippage.toFixed(4)}%`,
                maxSlippage: `${maxSlippage}%`,
                buySlippage: `${buySlippage.toFixed(4)}%`,
                sellSlippage: `${sellSlippage.toFixed(4)}%`,
                spread: `${priceDiff.toFixed(4)}%`,
                optimalAmount: `${optimalAmount.toFixed(4)} ETH`,
                netProfit: `$${optimalNetProfitUsd.toFixed(4)}`,
                grossProfit: `$${optimalGrossProfitUsd.toFixed(4)}`,
              });
              // Return early with error
              return {
                opportunity: null,
                pairSymbol,
                scanned: true,
                error: `Slippage too high: ${totalSlippage.toFixed(2)}% > ${maxSlippage}%`,
                debug: {
                  wethToTokenQuotes: wethToTokenQuotes.map(q => ({ dex: q.dex, price: q.price })),
                  tokenToWethQuotes: tokenToWethQuotes.map(q => ({ dex: q.dex, price: q.price })),
                  bestSpread: priceDiff,
                  quotesCount: wethToTokenQuotes.length + tokenToWethQuotes.length,
                },
              };
            } else {
              bestNetProfit = optimalNetProfitUsd;

              // Debug: Log successful opportunity creation
              console.log(`[OpportunityCreated] ${pairSymbol} SUCCESS:`, {
                spread: `${priceDiff.toFixed(4)}%`,
                optimalAmount: `${optimalAmount.toFixed(4)} ETH`,
                optimalNetProfitUsd: `$${optimalNetProfitUsd.toFixed(4)}`,
                optimalGrossProfitUsd: `$${optimalGrossProfitUsd.toFixed(4)}`,
                gasCostUsd: `$${gasCostUsd.toFixed(4)}`,
                flashLoanFeeUsd: `$${optimalFlashLoanFeeUsd.toFixed(4)}`,
                totalSlippage: `${totalSlippage.toFixed(4)}%`,
                buyDex: buyDex.dex,
                sellDex: sellDex.dex,
              });

            // Convert prices to consistent USD format
            // buyDex.price: WETH → Token (e.g., 1 WETH = 3130 USDT) - already in USD
            // sellDex.price: Token → WETH (e.g., 1 USDT = 0.00032 WETH) - need to invert for USD
            const buyPriceUsd = buyDex.price; // WETH → Token price (already USD)
              const sellPriceUsd =
                sellDex.price > 0 ? 1 / sellDex.price : 0; // Token → WETH inverted = WETH price in USD

            bestOpportunity = {
              id: `${Date.now()}-${tokenSymbol}`,
              timestamp: Date.now(),
              tokenPair: pairSymbol,
              tokenIn: { address: wethAddress, symbol: "WETH", decimals: 18 },
                tokenOut: {
                  address: tokenAddress,
                  symbol: tokenSymbol,
                  decimals: tokenDecimals,
                },
              buyFrom: {
                dex: buyDex.dex as any,
                price: buyPriceUsd,
                liquidity: "10000000",
                  pairAddress:
                    buyDex.pairAddress ||
                    "0x0000000000000000000000000000000000000000",
              },
              sellTo: {
                dex: sellDex.dex as any,
                price: sellPriceUsd,
                liquidity: "10000000",
                  pairAddress:
                    sellDex.pairAddress ||
                    "0x0000000000000000000000000000000000000000",
              },
              priceDiff,
                estimatedProfit: optimalGrossProfitUsd,
              estimatedGasCost: gasCostUsd,
                netProfit: optimalNetProfitUsd,
                tradeAmount: optimalAmount, // Use optimal amount instead of fixed 1 ETH
                slippage: totalSlippage,
                buySlippage,
                sellSlippage,
                gasPrice: gasPrice || undefined, // Include gas price for execution
                ethPrice: ethPriceUsd, // Include ETH price for execution
                flashLoanProtocol: flashLoanProtocol,
              status: "pending",
            };
            }
          }
        }
      }
    }

    // Calculate best spread for debugging
    const allSpreads: number[] = [];
    for (let i = 0; i < wethToTokenQuotes.length; i++) {
      for (let j = 0; j < tokenToWethQuotes.length; j++) {
        if (wethToTokenQuotes[i].dex !== tokenToWethQuotes[j].dex) {
          const tokenReceived = wethAmount * wethToTokenQuotes[i].price;
          const wethReceived = tokenReceived * tokenToWethQuotes[j].price;
          const spread = ((wethReceived - wethAmount) / wethAmount) * 100;
          allSpreads.push(spread);
        }
      }
    }

    return {
      opportunity: bestOpportunity,
      pairSymbol,
      scanned: true,
      debug: {
        wethToTokenQuotes: wethToTokenQuotes.map((q) => ({
          dex: q.dex,
          price: q.price,
        })),
        tokenToWethQuotes: tokenToWethQuotes.map((q) => ({
          dex: q.dex,
          price: q.price,
        })),
        bestSpread: allSpreads.length > 0 ? Math.max(...allSpreads) : 0,
        quotesCount: wethToTokenQuotes.length + tokenToWethQuotes.length,
      },
    };
  } catch (error: any) {
    return {
      opportunity: null,
      pairSymbol,
      scanned: true,
      error: error.message || "Unknown error",
    };
  }
}

/**
 * Scan all high-liquidity WETH pairs (both directions)
 */
export async function scanAllWETHPairs(
  chainId: ChainId,
  wethAmount: number,
  gasPrice: GasPrice | null,
  ethPriceUsd: number,
  maxSlippage: number = 0.5, // Default 0.5% max slippage
  flashLoanProtocol: FlashLoanProtocol = FlashLoanProtocol.AAVE_V3
): Promise<ScanResult[]> {
  const pairs = getHighLiquidityPairs(chainId);

  const scanPromises = pairs.map((pair) =>
    scanWETHPair(
      chainId,
      pair.token.address,
      pair.token.symbol,
      pair.token.decimals,
      wethAmount,
      gasPrice,
      ethPriceUsd,
      maxSlippage,
      flashLoanProtocol
    )
  );

  const results = await Promise.all(scanPromises);
  return results;
}
