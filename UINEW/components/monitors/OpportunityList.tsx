"use client";

import { useState, useEffect } from "react";
import { ArbitrageOpportunity, ScanLog } from "@/types/monitor";
import { formatUSD, timeAgo } from "@/lib/utils/format";

interface OpportunityListProps {
  opportunities: ArbitrageOpportunity[];
  logs: ScanLog[];
  onClear: () => void;
  onExecute: (opportunityId: string) => void;
  onSimulate: (opportunityId: string) => void;
}

const STATUS_CONFIG = {
  pending: {
    bg: "bg-blue-500/20 border-blue-400/50",
    text: "text-blue-300",
    label: "Pending",
    icon: "⏳",
  },
  executing: {
    bg: "bg-yellow-500/20 border-yellow-400/50 animate-pulse",
    text: "text-yellow-300",
    label: "Executing",
    icon: "⚡",
  },
  success: {
    bg: "bg-green-500/20 border-green-400/50",
    text: "text-green-300",
    label: "Success",
    icon: "✅",
  },
  failed: {
    bg: "bg-red-500/20 border-red-400/50",
    text: "text-red-300",
    label: "Failed",
    icon: "❌",
  },
};

export default function OpportunityList({
  opportunities,
  logs,
  onClear,
  onExecute,
  onSimulate,
}: OpportunityListProps) {
  const [currentIndex, setCurrentIndex] = useState(0);

  const LOG_COLORS = {
    info: "text-blue-300",
    success: "text-green-300",
    warning: "text-yellow-300",
    error: "text-red-300",
  };

  const LOG_ICONS = {
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    error: "❌",
  };

  const currentOpportunity = opportunities.length > 0 ? opportunities[currentIndex] : null;
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < opportunities.length - 1;

  // Reset index when opportunities change
  useEffect(() => {
    if (opportunities.length > 0) {
      if (currentIndex >= opportunities.length) {
        setCurrentIndex(opportunities.length - 1);
      }
      // If new opportunity added, show the first one (newest)
      if (opportunities.length === 1 && currentIndex !== 0) {
        setCurrentIndex(0);
      }
    } else {
      setCurrentIndex(0);
    }
  }, [opportunities.length]);

  const handlePrev = () => {
    if (canGoPrev) {
      setCurrentIndex(currentIndex - 1);
    }
  };

  const handleNext = () => {
    if (canGoNext) {
      setCurrentIndex(currentIndex + 1);
    }
  };

  return (
    <div className="h-full flex flex-col gap-4 min-h-0">
      {/* Opportunities Section - ~60% height */}
      <div className="glass-strong rounded-3xl shadow-2xl p-5 flex flex-col overflow-hidden flex-[6] min-h-0">
        <div className="flex items-center justify-between mb-3 flex-shrink-0">
          <h2 className="text-xl font-bold text-white">
            Opportunities{" "}
            <span className="text-sm text-gray-400 font-normal">({opportunities.length})</span>
          </h2>
          {opportunities.length > 0 && (
            <button
              onClick={onClear}
              className="text-xs text-red-400 hover:text-red-300 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-red-900/20"
            >
              Clear
            </button>
          )}
        </div>

        {opportunities.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center">
            <div className="text-4xl mb-2 opacity-30">🔎</div>
            <p className="text-gray-400 text-sm">
              No opportunities found yet
            </p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 relative">
            {/* Navigation Buttons */}
            <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 flex justify-between px-2 z-10 pointer-events-none">
              <button
                onClick={handlePrev}
                disabled={!canGoPrev}
                className={`pointer-events-auto w-8 h-8 rounded-full glass-strong border border-white/20 flex items-center justify-center transition-all ${
                  canGoPrev
                    ? "hover:bg-white/10 hover:scale-110 cursor-pointer"
                    : "opacity-30 cursor-not-allowed"
                }`}
              >
                <span className="text-white text-lg">↑</span>
              </button>
              <button
                onClick={handleNext}
                disabled={!canGoNext}
                className={`pointer-events-auto w-8 h-8 rounded-full glass-strong border border-white/20 flex items-center justify-center transition-all ${
                  canGoNext
                    ? "hover:bg-white/10 hover:scale-110 cursor-pointer"
                    : "opacity-30 cursor-not-allowed"
                }`}
              >
                <span className="text-white text-lg">↓</span>
              </button>
            </div>

            {/* Current Opportunity Display */}
            {currentOpportunity && (() => {
              const opp = currentOpportunity;
              const statusConfig = STATUS_CONFIG[opp.status];
              const profitColor = opp.netProfit > 100 ? "text-green-300" : "text-yellow-300";

              return (
                <div
                  key={opp.id}
                  className="glass rounded-xl p-3 border border-white/5 hover:border-white/10 transition-all h-full flex flex-col"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h3 className="font-bold text-white text-sm">
                        {opp.tokenPair}
                      </h3>
                      <p className="text-xs text-gray-400">{timeAgo(opp.timestamp)}</p>
                    </div>

                    <div className={`px-2 py-1 rounded-lg border flex items-center gap-1 ${statusConfig.bg}`}>
                      <span className="text-xs">{statusConfig.icon}</span>
                      <span className={`text-xs font-bold ${statusConfig.text}`}>
                        {statusConfig.label}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div className="glass rounded-lg p-2 border border-red-900/50">
                      <p className="text-xs text-red-400 font-medium mb-0.5">📥 Buy @ {opp.buyFrom.dex.toUpperCase()}</p>
                      <p className="text-xs font-bold text-white">
                        ${opp.buyFrom.price.toFixed(4)}
                      </p>
                    </div>

                    <div className="glass rounded-lg p-2 border border-green-900/50">
                      <p className="text-xs text-green-400 font-medium mb-0.5">📤 Sell @ {opp.sellTo.dex.toUpperCase()}</p>
                      <p className="text-xs font-bold text-white">
                        ${opp.sellTo.price.toFixed(4)}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 mb-2 text-center">
                    <div>
                      <p className="text-xs text-gray-400">Diff</p>
                      <p className="text-xs font-bold text-blue-400">
                        +{opp.priceDiff.toFixed(2)}%
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Est.</p>
                      <p className="text-xs font-bold text-green-400">
                        {formatUSD(opp.estimatedProfit)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Net</p>
                      <p className={`text-xs font-bold ${profitColor}`}>
                        {formatUSD(opp.netProfit)}
                      </p>
                    </div>
                  </div>

                  {/* Verification Info */}
                  <div className="glass rounded-lg p-2 mb-2 border border-blue-900/30">
                    <p className="text-xs text-blue-300 font-semibold mb-1">💡 Verification</p>
                    <div className="space-y-0.5">
                      <p className="text-xs text-gray-400">
                        Gas: {formatUSD(opp.estimatedGasCost)} @ {opp.estimatedGasCost > 0 ? Math.round(opp.estimatedGasCost / 3095 * 1e9) : 0} Gwei
                      </p>
                      <p className="text-xs text-gray-400">
                        Flash Loan Fee: ~${(1 * 3095 * 0.0005).toFixed(2)} (0.05%)
                      </p>
                      {opp.slippage !== undefined && (
                        <p className="text-xs text-gray-400">
                          Slippage: {opp.slippage.toFixed(3)}% 
                          {opp.buySlippage !== undefined && opp.sellSlippage !== undefined && (
                            <span className="text-gray-500">
                              {" "}(Buy: {opp.buySlippage.toFixed(2)}%, Sell: {opp.sellSlippage.toFixed(2)}%)
                            </span>
                          )}
                        </p>
                      )}
                      <a
                        href={`https://www.dextools.io/app/ether/pair-explorer/${opp.buyFrom.pairAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-cyan-400 hover:text-cyan-300 underline"
                      >
                        🔍 Verify on DEXTools
                      </a>
                    </div>
                  </div>

                  {opp.status === "pending" && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => onSimulate(opp.id)}
                        className="flex-1 bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 rounded-lg transition-all duration-300 transform hover:scale-105 shadow-lg text-sm"
                      >
                        🔬 Simulate
                      </button>
                      <button
                        onClick={() => onExecute(opp.id)}
                        className="flex-1 gradient-primary text-white font-bold py-2 rounded-lg transition-all duration-300 transform hover:scale-105 shadow-lg text-sm"
                      >
                        ⚡ Execute
                      </button>
                    </div>
                  )}

                  {opp.status === "executing" && (
                    <div className="w-full bg-yellow-500/20 border border-yellow-400/50 text-yellow-300 font-bold py-2 rounded-lg text-center text-sm">
                      <span className="animate-spin inline-block">⚙️</span> Executing...
                    </div>
                  )}

                  {opp.status === "success" && (
                    <div className="w-full bg-green-500/20 border border-green-400/50 text-green-300 font-bold py-2 rounded-lg text-center text-sm">
                      ✅ Completed
                    </div>
                  )}

                  {opp.status === "failed" && (
                    <div className="w-full bg-red-500/20 border border-red-400/50 text-red-300 font-bold py-2 rounded-lg text-center text-sm">
                      ❌ Failed
                    </div>
                  )}
                </div>
              );
            })()}
            
            {/* Counter */}
            {opportunities.length > 1 && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 glass-strong px-3 py-1 rounded-full border border-white/20 text-xs text-gray-300">
                {currentIndex + 1} / {opportunities.length}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Logs Section - ~40% height */}
      <div className="glass-strong rounded-3xl shadow-2xl p-5 flex flex-col overflow-hidden flex-[4] min-h-0">
        <div className="flex items-center justify-between mb-3 flex-shrink-0">
          <h2 className="text-xl font-bold text-white">
            Activity Logs
          </h2>
        </div>

        {logs.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center">
            <div className="text-3xl mb-2 opacity-30">📋</div>
            <p className="text-gray-400 text-sm">
              No logs yet
            </p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-600/50 scrollbar-track-transparent space-y-1 min-h-0">
            {logs.map((log) => (
              <div
                key={log.id}
                className="glass rounded-lg p-2 border border-white/5 hover:border-white/10 transition-all"
              >
                <div className="flex items-start gap-2">
                  <span className="text-xs flex-shrink-0">{LOG_ICONS[log.level]}</span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-mono ${LOG_COLORS[log.level]}`}>
                      {log.message}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {timeAgo(log.timestamp)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
