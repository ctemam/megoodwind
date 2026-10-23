"use client";

import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";

interface BlockchainScannerProps {
  isScanning: boolean;
  scannedCount?: number;
  totalPairs?: number;
}

const DEX_NAMES = [
  "Uniswap V2",
  "Uniswap V3",
  "Sushiswap",
  "Balancer",
  "Curve",
  "1inch",
  "0x DEX",
];

const BLOCK_COUNT = 10;

// Deterministic pseudo-hash generator to avoid hydration mismatches
const generateHashFromIndex = (index: number) => {
  const seed = ((index + 1) * 2654435761) >>> 0; // Knuth multiplicative hash
  return seed.toString(16).padStart(6, "0").slice(0, 6);
};

export function BlockchainScanner({ isScanning, scannedCount = 0, totalPairs = 0 }: BlockchainScannerProps) {
  const [currentDexIndex, setCurrentDexIndex] = useState(0);
  const [scanRate, setScanRate] = useState(0);
  const [lastScannedCount, setLastScannedCount] = useState(0);
  const blockHashes = useMemo(
    () => Array.from({ length: BLOCK_COUNT }, (_, i) => generateHashFromIndex(i)),
    []
  );

  // Calculate scan rate (scans per second)
  useEffect(() => {
    if (!isScanning) {
      setScanRate(0);
      return;
    }

    const interval = setInterval(() => {
      const diff = scannedCount - lastScannedCount;
      setScanRate(diff);
      setLastScannedCount(scannedCount);
    }, 1000);

    return () => clearInterval(interval);
  }, [isScanning, scannedCount, lastScannedCount]);

  // Rotate through DEX names
  useEffect(() => {
    if (!isScanning) return;

    const interval = setInterval(() => {
      setCurrentDexIndex((prev) => (prev + 1) % DEX_NAMES.length);
    }, 2000);

    return () => clearInterval(interval);
  }, [isScanning]);

  const blockVariants = {
    idle: {
      opacity: 0.3,
      scale: 1,
    },
    scanning: (i: number) => ({
      opacity: [0.3, 1, 0.3],
      scale: [1, 1.15, 1],
      transition: {
        duration: 1.8,
        repeat: Infinity as number,
        delay: i * 0.25,
        ease: [0.4, 0, 0.2, 1] as const,
      },
    }),
  };

  const chainVariants = {
    idle: {
      opacity: 0.2,
    },
    scanning: {
      opacity: [0.2, 0.7, 0.2],
      transition: {
        duration: 1.5,
        repeat: Infinity as number,
        ease: [0.4, 0, 0.2, 1] as const,
      },
    },
  };

  return (
    <div className="relative flex items-center justify-center gap-6 py-4 px-4">
      {/* Center: Blocks */}
      <div className="flex items-center gap-2">
        {Array.from({ length: BLOCK_COUNT }).map((_, i) => (
        <div key={i} className="flex items-center">
          {/* Block Icon */}
          <motion.div
            custom={i}
            variants={blockVariants}
            initial="idle"
            animate={isScanning ? "scanning" : "idle"}
            className="relative group"
          >
            {/* 3D Block Container */}
            <div className="relative w-14 h-14">
              {/* 3D Blockchain Block SVG */}
              <svg
                width="56"
                height="56"
                viewBox="0 0 56 56"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="text-cyan-400"
              >
                {/* Back face (darker) */}
                <path
                  d="M28 8 L44 16 L44 32 L28 40 L12 32 L12 16 Z"
                  fill="url(#gradient1)"
                  opacity="0.6"
                />

                {/* Top face */}
                <path
                  d="M28 8 L44 16 L28 24 L12 16 Z"
                  fill="url(#gradient2)"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />

                {/* Left face */}
                <path
                  d="M12 16 L12 32 L28 40 L28 24 Z"
                  fill="url(#gradient3)"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  opacity="0.7"
                />

                {/* Right face */}
                <path
                  d="M28 24 L28 40 L44 32 L44 16 Z"
                  fill="url(#gradient4)"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  opacity="0.8"
                />

                {/* Hash pattern inside block */}
                <g opacity="0.6">
                  <line x1="20" y1="20" x2="30" y2="20" stroke="currentColor" strokeWidth="1" />
                  <line x1="22" y1="23" x2="28" y2="23" stroke="currentColor" strokeWidth="1" />
                  <line x1="24" y1="26" x2="32" y2="26" stroke="currentColor" strokeWidth="1" />
                  <line x1="20" y1="29" x2="26" y2="29" stroke="currentColor" strokeWidth="1" />
                </g>

                {/* Gradients */}
                <defs>
                  <linearGradient id="gradient1" x1="28" y1="8" x2="28" y2="40" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#0891b2" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#0e7490" stopOpacity="0.5" />
                  </linearGradient>
                  <linearGradient id="gradient2" x1="28" y1="8" x2="28" y2="24" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#22d3ee" />
                    <stop offset="100%" stopColor="#0891b2" />
                  </linearGradient>
                  <linearGradient id="gradient3" x1="12" y1="16" x2="28" y2="40" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#0e7490" />
                    <stop offset="100%" stopColor="#155e75" />
                  </linearGradient>
                  <linearGradient id="gradient4" x1="44" y1="16" x2="28" y2="40" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#06b6d4" />
                    <stop offset="100%" stopColor="#0891b2" />
                  </linearGradient>
                </defs>
              </svg>

              {/* Scanning glow effect */}
              {isScanning && (
                <motion.div
                  className="absolute inset-0 rounded-lg bg-cyan-400/20 blur-xl"
                  animate={{
                    scale: [1, 1.4, 1],
                    opacity: [0.3, 0.6, 0.3],
                  }}
                  transition={{
                    duration: 1.8,
                    repeat: Infinity as number,
                    delay: i * 0.25,
                    ease: [0.4, 0, 0.2, 1] as const,
                  }}
                />
              )}

              {/* Hash value display */}
              <div className="absolute -bottom-3 left-1/2 transform -translate-x-1/2 bg-gray-800/90 px-2 py-0.5 rounded border border-cyan-500/30 opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="text-[8px] font-mono text-cyan-300">
                  0x{blockHashes[i]}
                </span>
              </div>
            </div>
          </motion.div>

          {/* Chain link between blocks */}
          {i < BLOCK_COUNT - 1 && (
            <div className="relative mx-1">
              {/* Animated data flow line */}
              <motion.svg
                width="24"
                height="48"
                viewBox="0 0 24 48"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                variants={chainVariants}
                initial="idle"
                animate={isScanning ? "scanning" : "idle"}
                className="text-cyan-500"
              >
                {/* Main chain line */}
                <line
                  x1="0"
                  y1="24"
                  x2="24"
                  y2="24"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />

                {/* Chain links */}
                <circle cx="6" cy="24" r="2" fill="currentColor" opacity="0.6" />
                <circle cx="12" cy="24" r="2" fill="currentColor" opacity="0.8" />
                <circle cx="18" cy="24" r="2" fill="currentColor" opacity="0.6" />

                {/* Arrow */}
                <path
                  d="M20 21 L24 24 L20 27"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </motion.svg>

              {/* Data packets flowing through */}
              {isScanning && (
                <>
                  <motion.div
                    className="absolute top-1/2 left-0 w-1.5 h-1.5 bg-cyan-400 rounded-full shadow-lg shadow-cyan-400/50"
                    animate={{
                      x: [0, 24],
                      opacity: [0, 1, 1, 0],
                    }}
                    transition={{
                      duration: 1.2,
                      repeat: Infinity as number,
                      delay: i * 0.15,
                      ease: [0, 0, 1, 1] as const,
                    }}
                  />
                  <motion.div
                    className="absolute top-1/2 left-0 w-1 h-1 bg-blue-300 rounded-full"
                    animate={{
                      x: [0, 24],
                      opacity: [0, 1, 1, 0],
                    }}
                    transition={{
                      duration: 1.2,
                      repeat: Infinity as number,
                      delay: i * 0.15 + 0.4,
                      ease: [0, 0, 1, 1] as const,
                    }}
                  />
                </>
              )}
            </div>
          )}
        </div>
      ))}
      </div>

      {/* Right: Current DEX being scanned */}
      <div className="absolute right-4">
        {isScanning ? (
          <motion.div
            className="flex items-center gap-3 px-4 py-2 rounded-lg bg-blue-500/10 border border-blue-500/30"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3 }}
          >
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></div>
            <motion.span
              key={currentDexIndex}
              className="text-sm font-semibold text-blue-300"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
            >
              Scanning {DEX_NAMES[currentDexIndex]}
            </motion.span>
          </motion.div>
        ) : (
          <div className="text-sm text-gray-400">
            Ready to scan
          </div>
        )}
      </div>
    </div>
  );
}
