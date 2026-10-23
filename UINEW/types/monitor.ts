/**
 * Flash Loan + Arbitrage 타입 정의
 */

export type ChainId = 1 | 11155111; // 1: Ethereum Mainnet, 11155111: Sepolia Testnet

export interface ArbitrageConfig {
  enabled: boolean;
  chainId: ChainId;
  refreshInterval: number; // milliseconds
  minProfitUsd: number; // 최소 수익 (USD)
  maxGasPrice: number; // 최대 가스 가격 (Gwei)
}

/**
 * DEX 프로토콜 및 Aggregator
 */
export enum DexProtocol {
  ONE_INCH = "1inch",           // 1inch Aggregator (주요 사용)
  PARASWAP = "paraswap",       // ParaSwap Aggregator
  UNISWAP_V2 = "uniswap_v2",
  UNISWAP_V3 = "uniswap_v3",
  SUSHISWAP = "sushiswap",
  BALANCER = "balancer",
  CURVE = "curve",
}

/**
 * Flash Loan 프로토콜
 */
export enum FlashLoanProtocol {
  AAVE_V3 = "aave_v3",
  UNISWAP_V3 = "uniswap_v3",
  BALANCER = "balancer",
}

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

export interface DexPrice {
  dex: DexProtocol;
  price: number; // Price in USD or quote token terms
  liquidity: string; // USD
  pairAddress: string;
}

/**
 * WETH-based 2-hop Arbitrage Opportunity
 * Strategy: WETH → Token → WETH
 * Example: Start with 1 WETH → Buy USDC on Uniswap V2 → Sell USDC on Uniswap V3 → End with 1.02 WETH
 */
export interface ArbitrageOpportunity {
  id: string;
  timestamp: number;
  tokenPair: string; // e.g., "WETH/USDC"

  // Base token (always WETH for 2-hop strategy)
  tokenIn: TokenInfo; // WETH

  // Intermediate token (USDC, DAI, USDT, etc.)
  tokenOut: TokenInfo;

  // Buy intermediate token (WETH → Token)
  buyFrom: DexPrice;

  // Sell intermediate token back (Token → WETH)
  sellTo: DexPrice;

  priceDiff: number; // Price spread (%)
  estimatedProfit: number; // Gross profit (USD)
  estimatedGasCost: number; // Gas cost (USD)
  netProfit: number; // Net profit after gas & fees (USD)
  tradeAmount: number; // Optimal trade amount in ETH
  slippage?: number; // Total slippage for round trip (%)
  buySlippage?: number; // Slippage on buy leg (%)
  sellSlippage?: number; // Slippage on sell leg (%)
  gasPrice?: GasPrice; // Gas price at time of opportunity detection
  ethPrice?: number; // ETH price in USD at time of detection
  flashLoanProtocol: FlashLoanProtocol;
  status: "pending" | "executing" | "success" | "failed";
}

export interface ArbitrageSettings {
  enabledDexes: DexProtocol[];
  flashLoanProtocol: FlashLoanProtocol;
  minProfitUsd: number;
  maxGasPrice: number;
  maxSlippage: number; // Maximum acceptable slippage (%)
  tradeAmount: number; // Flash loan amount in ETH
  watchedTokens: string[]; // 관찰할 토큰 주소 목록
  autoExecute: boolean; // Auto-execute opportunities when found
}

export type LogLevel = "info" | "success" | "warning" | "error";

export interface ScanLog {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
}

export interface GasPrice {
  baseFeeGwei: number;
  priorityFeeGwei: number;
  maxFeeGwei: number;
  gasPriceGwei?: number; // Legacy gas price (for non-EIP-1559)
  timestamp: number;
}

export interface ScanResult {
  pairSymbol: string;
  opportunity: ArbitrageOpportunity | null;
  scanned: boolean;
  error?: string;
  debug?: {
    wethToTokenQuotes: Array<{ dex: string; price: number }>;
    tokenToWethQuotes: Array<{ dex: string; price: number }>;
    bestSpread: number;
    quotesCount: number;
  };
}

export interface ArbitrageState {
  isScanning: boolean;
  chainId: ChainId; // Current chain ID
  lastUpdate: number;
  opportunities: ArbitrageOpportunity[];
  scanResults: ScanResult[]; // All scan results (profitable or not)
  config: ArbitrageConfig;
  settings: ArbitrageSettings;
  logs: ScanLog[];
  gasPrice: GasPrice | null;
  ethPrice: number | null; // ETH price in USD
  stats: {
    totalScanned: number;
    opportunitiesFound: number;
    totalProfit: number;
  };
}
