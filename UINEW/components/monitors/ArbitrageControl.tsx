"use client";

import { ArbitrageState, ArbitrageSettings, FlashLoanProtocol } from "@/types/monitor";
import { formatUSD } from "@/lib/utils/format";
import { downloadCSV } from "@/lib/utils/csv-logger";

import { ChainId } from "@/types/monitor";

interface ArbitrageControlProps {
  state: ArbitrageState;
  onStart: () => void;
  onStop: () => void;
  onUpdateSettings: (settings: ArbitrageSettings) => void;
  onSetChainId: (chainId: ChainId) => void;
}

const FLASH_LOAN_LABELS: Record<FlashLoanProtocol, string> = {
  [FlashLoanProtocol.AAVE_V3]: "Aave V3",
  [FlashLoanProtocol.UNISWAP_V3]: "Uniswap V3",
  [FlashLoanProtocol.BALANCER]: "Balancer",
};

export default function ArbitrageControl({
  state,
  onStart,
  onStop,
  onUpdateSettings,
  onSetChainId,
}: ArbitrageControlProps) {
  return (
    <div className="h-full min-h-0 glass-strong rounded-3xl shadow-2xl p-5 flex flex-col">
      {/* Header with Network Switcher and Start/Stop Button */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Scanner Control</h2>
          {/* Network Badge - Fixed to Mainnet */}
          <div className="flex items-center gap-2 mt-2">
            <div className="px-3 py-1 rounded-lg text-xs font-bold bg-blue-500 text-white flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>
              Ethereum Mainnet
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={downloadCSV}
            className="px-6 py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-white font-bold transition-all duration-300 transform hover:scale-105"
            title="Download CSV data"
          >
            📥 CSV
          </button>
        <button
          onClick={state.isScanning ? onStop : onStart}
          className={`relative px-6 py-2.5 rounded-xl font-bold transition-all duration-300 transform hover:scale-105 ${
            state.isScanning
              ? "gradient-warning text-white shadow-lg shadow-red-900/50"
              : "gradient-success text-white shadow-lg shadow-green-900/50"
          }`}
        >
          <span className="relative z-10">{state.isScanning ? "Stop" : "Start"}</span>
          {state.isScanning && (
            <span className="absolute inset-0 rounded-xl animate-pulse bg-red-900/30"></span>
          )}
        </button>
        </div>
      </div>

      {/* Status Indicator */}
      <div className={`glass-strong rounded-xl p-3 border mb-4 ${
        state.isScanning
          ? "border-green-600/50 pulse-glow"
          : "border-white/5"
      }`}>
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full ${
            state.isScanning ? "bg-green-500 animate-pulse" : "bg-gray-600"
          }`}></div>
          <span className="font-bold text-white text-sm">
            {state.isScanning ? "🔍 Scanning..." : "⏸️ Idle"}
          </span>
        </div>
      </div>

      {/* Price Indicators - Gas and ETH (fixed height to avoid layout shift) */}
      <div className="grid grid-cols-2 gap-2 mb-4 min-h-[72px]">
        {/* Gas Price */}
        <div
          className={`glass-strong rounded-xl p-3 border ${
            state.gasPrice && state.gasPrice.maxFeeGwei > state.settings.maxGasPrice
              ? "border-red-600/50"
              : "border-blue-600/30"
          }`}
        >
            <div className="flex items-center gap-2">
              <span className="text-lg">⛽</span>
              <div className="flex-1">
                <p className="text-xs text-gray-400 font-medium">Gas</p>
                <p className="text-sm font-bold text-white">
                {state.gasPrice
                  ? `${state.gasPrice.maxFeeGwei.toFixed(2)} Gwei`
                  : "—"}
                </p>
              </div>
            </div>
          </div>

        {/* ETH Price */}
          <div className="glass-strong rounded-xl p-3 border border-purple-600/30">
            <div className="flex items-center gap-2">
              <span className="text-lg">💎</span>
              <div className="flex-1">
                <p className="text-xs text-gray-400 font-medium">ETH/USD</p>
                <p className="text-sm font-bold text-white">
                {state.ethPrice ? `$${state.ethPrice.toFixed(2)}` : "—"}
                </p>
              </div>
            </div>
          </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="glass rounded-lg p-2.5 text-center border border-emerald-900/50">
          <p className="text-xs text-emerald-400 font-medium">Scanned</p>
          <p className="text-base font-bold text-white">{state.stats.totalScanned}</p>
        </div>
        <div className="glass rounded-lg p-2.5 text-center border border-gray-700/50">
          <p className="text-xs text-gray-300 font-medium">Found</p>
          <p className="text-base font-bold text-white">{state.stats.opportunitiesFound}</p>
        </div>
        <div className="glass rounded-lg p-2.5 text-center border border-yellow-900/50">
          <p className="text-xs text-yellow-400 font-medium">Profit</p>
          <p className="text-base font-bold text-white">{formatUSD(state.stats.totalProfit)}</p>
        </div>
      </div>

      {/* Multi-DEX Price Comparison - Current Scan Snapshot */}
      <div className="glass rounded-xl p-3 border border-white/5 flex flex-col flex-1">
        <div className="flex items-center justify-between mb-3 flex-shrink-0">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <span>📊</span>
            <span>Multi-DEX Price Comparison</span>
          </h3>
          {state.scanResults.length > 0 && (
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold text-blue-300">
                Scan #{state.stats.totalScanned}
              </span>
            </div>
          )}
        </div>

        <div className="flex-1">
        {state.scanResults.length === 0 ? (
            <div className="h-full flex items-center justify-center text-gray-400 text-sm py-8">
            {state.isScanning ? "Scanning DEX prices..." : "Start scanning to compare prices"}
          </div>
        ) : (
          (() => {
            // Show ONE pair at a time - rotate through scan results
            const currentIndex = (state.stats.totalScanned - 1) % state.scanResults.length;
            const result = state.scanResults[currentIndex];

            if (!result || !result.debug) return null;

            const { wethToTokenQuotes, tokenToWethQuotes, bestSpread } = result.debug;
            const hasOpportunity = result.opportunity !== null;

            // Helper: Find best/worst prices
            const findBestWorst = (quotes: Array<{ dex: string; price: number }>) => {
              if (quotes.length === 0) return { best: null, worst: null };
              const prices = quotes.map((q) => q.price);
              return { best: Math.max(...prices), worst: Math.min(...prices) };
            };

            const wethToTokenBestWorst = findBestWorst(wethToTokenQuotes);
            const tokenToWethBestWorst = findBestWorst(tokenToWethQuotes);

            return (
              <div
                key={`${result.pairSymbol}-${state.stats.totalScanned}`}
                  className={`glass-strong rounded-xl p-2.5 border-2 transition-all ${
                  hasOpportunity
                    ? "border-green-500/60 bg-green-500/10"
                    : "border-blue-500/40 bg-blue-500/5"
                }`}
              >
                {/* Pair Header - Compact */}
                  <div className="flex items-center justify-between mb-1.5">
                    <h4 className="text-lg font-bold text-white">{result.pairSymbol}</h4>
                  <div className="flex items-center gap-2">
                    {hasOpportunity && (
                      <span className="px-3 py-1 rounded-lg bg-green-500/30 border-2 border-green-400/60 text-green-200 text-xs font-bold animate-pulse">
                        ⚡ PROFIT
                      </span>
                    )}
                    <div className="text-right">
                      <p className="text-[10px] text-gray-400">Spread</p>
                        <p className="text-sm font-bold text-blue-300">
                        {bestSpread.toFixed(3)}%
                      </p>
                    </div>
                  </div>
                </div>

                {/* WETH → Token Prices (COMPACT) */}
                {wethToTokenQuotes.length > 0 && (
                    <div className="mb-1.5">
                    <p className="text-xs text-blue-300 font-bold mb-2 flex items-center gap-1">
                      <span className="text-lg">📥</span>
                      Buy Route (WETH → Token)
                    </p>
                    <div className="grid grid-cols-4 gap-2">
                      {wethToTokenQuotes.map((quote, i) => {
                        const isBest = quote.price === wethToTokenBestWorst.best;
                        return (
                          <div
                            key={i}
                            className={`glass-strong rounded-lg p-2 border-2 text-center transition-all ${
                              isBest
                                ? "border-green-400/70 bg-green-500/20 scale-105"
                                : "border-white/20"
                            }`}
                          >
                              <div className="flex items-center justify-center gap-0.5 mb-0.5">
                                <p className="text-[9px] font-bold text-gray-300">
                                {quote.dex.toUpperCase()}
                              </p>
                              {isBest && <span className="text-sm">🏆</span>}
                            </div>
                              <p className={`text-sm font-bold ${isBest ? "text-green-300" : "text-white"}`}>
                              ${quote.price.toFixed(2)}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Token → WETH Prices (COMPACT) */}
                {tokenToWethQuotes.length > 0 && (
                    <div className="mb-1.5">
                    <p className="text-xs text-purple-300 font-bold mb-2 flex items-center gap-1">
                      <span className="text-lg">📤</span>
                      Sell Route (Token → WETH)
                    </p>
                    <div className="grid grid-cols-4 gap-2">
                      {tokenToWethQuotes.map((quote, i) => {
                        const isBest = quote.price === tokenToWethBestWorst.best;
                        const displayPrice = quote.price > 0 ? 1 / quote.price : 0;
                        return (
                          <div
                            key={i}
                            className={`glass-strong rounded-lg p-2 border-2 text-center transition-all ${
                              isBest
                                ? "border-green-400/70 bg-green-500/20 scale-105"
                                : "border-white/20"
                            }`}
                          >
                              <div className="flex items-center justify-center gap-0.5 mb-0.5">
                                <p className="text-[9px] font-bold text-gray-300">
                                {quote.dex.toUpperCase()}
                              </p>
                              {isBest && <span className="text-sm">🏆</span>}
                            </div>
                              <p className={`text-sm font-bold ${isBest ? "text-green-300" : "text-white"}`}>
                              ${displayPrice.toFixed(2)}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Opportunity Summary - Compact */}
                {hasOpportunity && result.opportunity && (
                    <div className="mt-1.5 pt-1.5 border-t-2 border-green-400/30">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-[10px] text-gray-400 mb-0.5">Best Route</p>
                          <p className="text-[11px] font-bold text-white">
                          {result.opportunity.buyFrom.dex.toUpperCase()} → {result.opportunity.sellTo.dex.toUpperCase()}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-gray-400 mb-0.5">Net Profit</p>
                          <p className="text-lg font-bold text-green-300">
                          +${result.opportunity.netProfit.toFixed(2)}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()
        )}
        </div>
      </div>
    </div>
  );
}
