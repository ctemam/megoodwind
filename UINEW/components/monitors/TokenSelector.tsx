"use client";

import { useState } from "react";
import { TOKENS } from "@/lib/config";

interface TokenSelectorProps {
  selectedTokens: string[];
  onTokensChange: (tokens: string[]) => void;
}

const TOKEN_LIST = Object.values(TOKENS);

export default function TokenSelector({
  selectedTokens,
  onTokensChange,
}: TokenSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);

  const toggleToken = (address: string) => {
    if (selectedTokens.includes(address)) {
      onTokensChange(selectedTokens.filter((t) => t !== address));
    } else {
      onTokensChange([...selectedTokens, address]);
    }
  };

  const categoryGroups = {
    stablecoin: TOKEN_LIST.filter((t) => t.category === "stablecoin"),
    major: TOKEN_LIST.filter((t) => t.category === "major"),
    defi: TOKEN_LIST.filter((t) => t.category === "defi"),
  };

  const categoryLabels = {
    stablecoin: "Stablecoins",
    major: "Major Assets",
    defi: "DeFi Tokens",
  };

  return (
    <>
      {/* Button to open modal */}
      <button
        onClick={() => setIsOpen(true)}
        className="w-full glass rounded-xl p-3 border border-white/5 hover:border-white/10 transition-all text-left"
      >
        <p className="text-xs text-gray-400 mb-1 font-medium">Watched Tokens</p>
        <p className="text-white font-bold text-sm">{selectedTokens.length} selected</p>
      </button>

      {/* Modal */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setIsOpen(false)}
          ></div>

          {/* Modal Content */}
          <div className="relative glass-strong rounded-3xl shadow-2xl p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden flex flex-col border border-white/10">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold text-white">Select Tokens to Watch</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="text-gray-400 hover:text-white transition-colors text-2xl w-8 h-8 flex items-center justify-center"
              >
                ✕
              </button>
            </div>

            {/* Token Selection */}
            <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/20 space-y-6">
              {Object.entries(categoryGroups).map(([category, tokens]) => (
                <div key={category}>
                  <p className="text-sm text-gray-400 mb-3 font-bold uppercase">
                    {categoryLabels[category as keyof typeof categoryLabels]}
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {tokens.map((token) => {
                      const isSelected = selectedTokens.includes(token.address);
                      return (
                        <div
                          key={token.address}
                          onClick={() => toggleToken(token.address)}
                          className={`flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
                            isSelected
                              ? "bg-green-900/30 border border-green-600/50"
                              : "bg-gray-900/50 border border-gray-700/50 hover:border-gray-600"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`w-2 h-2 rounded-full ${isSelected ? "bg-green-400" : "bg-gray-600"}`}></div>
                            <div>
                              <p className="text-white font-bold text-sm">{token.symbol}</p>
                              <p className="text-gray-400 text-xs">{token.name}</p>
                            </div>
                          </div>
                          {isSelected && <span className="text-green-400">✓</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="mt-6 flex items-center justify-between pt-4 border-t border-white/10">
              <p className="text-sm text-gray-400">
                {selectedTokens.length} token{selectedTokens.length !== 1 ? 's' : ''} selected
              </p>
              <button
                onClick={() => setIsOpen(false)}
                className="gradient-primary text-white font-bold py-2 px-6 rounded-xl transition-all duration-300 transform hover:scale-105 shadow-lg"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
