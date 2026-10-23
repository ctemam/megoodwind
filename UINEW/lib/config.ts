import { ArbitrageConfig, ArbitrageSettings, DexProtocol, FlashLoanProtocol, ChainId } from "@/types/monitor";

/**
 * Network Configuration
 */
export const NETWORKS = {
  MAINNET: {
    chainId: 1 as ChainId,
    name: "Ethereum Mainnet",
    rpcUrl: process.env.NEXT_PUBLIC_ETH_RPC_URL || "",
  },
  SEPOLIA: {
    chainId: 11155111 as ChainId,
    name: "Sepolia Testnet",
    rpcUrl: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "",
  },
} as const;

/**
 * 주요 토큰 주소 및 메타데이터 (Ethereum Mainnet)
 */
export const TOKENS_MAINNET = {
  // Stablecoins
  USDC: {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    category: "stablecoin" as const,
  },
  USDT: {
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    category: "stablecoin" as const,
  },
  DAI: {
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    category: "stablecoin" as const,
  },

  // Major Assets
  WETH: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    category: "major" as const,
  },
  WBTC: {
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    symbol: "WBTC",
    name: "Wrapped BTC",
    decimals: 8,
    category: "major" as const,
  },

  // DeFi Blue Chips
  UNI: {
    address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    symbol: "UNI",
    name: "Uniswap",
    decimals: 18,
    category: "defi" as const,
  },
  LINK: {
    address: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    symbol: "LINK",
    name: "Chainlink",
    decimals: 18,
    category: "defi" as const,
  },
  AAVE: {
    address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    symbol: "AAVE",
    name: "Aave",
    decimals: 18,
    category: "defi" as const,
  },
  MKR: {
    address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
    symbol: "MKR",
    name: "Maker",
    decimals: 18,
    category: "defi" as const,
  },
};

/**
 * 주요 토큰 주소 및 메타데이터 (Sepolia Testnet)
 */
export const TOKENS_SEPOLIA = {
  // Sepolia doesn't have all mainnet tokens, using common test tokens
  WETH: {
    address: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", // Sepolia WETH
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    category: "major" as const,
  },
  USDC: {
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Sepolia USDC (mock)
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    category: "stablecoin" as const,
  },
  DAI: {
    address: "0x68194a729C2450ad26072b3D33ADaCbcef39D574", // Sepolia DAI (Aave)
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    category: "stablecoin" as const,
  },
  LINK: {
    address: "0x779877A7B0D9E8603169DdbD7836e478b4624789", // Sepolia LINK
    symbol: "LINK",
    name: "Chainlink",
    decimals: 18,
    category: "defi" as const,
  },
};

/**
 * Get tokens for specific chain
 */
export function getTokensForChain(chainId: ChainId) {
  return chainId === 1 ? TOKENS_MAINNET : TOKENS_SEPOLIA;
}

/**
 * Get token info by address
 */
export function getTokenByAddress(address: string, chainId: ChainId = 1) {
  const tokens = getTokensForChain(chainId);
  const normalizedAddress = address.toLowerCase();

  for (const [key, token] of Object.entries(tokens)) {
    if (token.address.toLowerCase() === normalizedAddress) {
      return token;
    }
  }

  return null;
}

// Default to mainnet for backward compatibility
export const TOKENS = TOKENS_MAINNET;

/**
 * 기본 관찰 토큰 목록 (스테이블코인 + 메이저)
 */
export const DEFAULT_WATCHED_TOKENS_MAINNET = [
  TOKENS_MAINNET.USDC.address,
  TOKENS_MAINNET.USDT.address,
  TOKENS_MAINNET.DAI.address,
  TOKENS_MAINNET.WETH.address,
  TOKENS_MAINNET.WBTC.address,
];

export const DEFAULT_WATCHED_TOKENS_SEPOLIA = [
  TOKENS_SEPOLIA.WETH.address,
  TOKENS_SEPOLIA.USDC.address,
  TOKENS_SEPOLIA.DAI.address,
  TOKENS_SEPOLIA.LINK.address,
];

export function getDefaultWatchedTokens(chainId: ChainId) {
  return chainId === 1 ? DEFAULT_WATCHED_TOKENS_MAINNET : DEFAULT_WATCHED_TOKENS_SEPOLIA;
}

// Default to mainnet for backward compatibility
export const DEFAULT_WATCHED_TOKENS = DEFAULT_WATCHED_TOKENS_MAINNET;

/**
 * 기본 차익거래 설정 (HARDCODED: Mainnet only)
 */
export const DEFAULT_ARBITRAGE_CONFIG: ArbitrageConfig = {
  enabled: false,
  chainId: 1, // FIXED: Ethereum Mainnet only
  refreshInterval: 10000, // 10 seconds (reduced RPC load)
  minProfitUsd: 50, // 최소 $50 수익
  maxGasPrice: 50, // 최대 50 Gwei
};

/**
 * 기본 차익거래 설정
 */
export const DEFAULT_ARBITRAGE_SETTINGS: ArbitrageSettings = {
  enabledDexes: [
    DexProtocol.ONE_INCH,      // 메인 aggregator
    DexProtocol.PARASWAP,      // 백업 aggregator
    DexProtocol.UNISWAP_V3,
  ],
  flashLoanProtocol: FlashLoanProtocol.BALANCER, // Changed to Balancer (0% fee!)
  minProfitUsd: 5, // $5 minimum profit (mainnet ready)
  maxSlippage: 0.5, // 0.5% max slippage (strict)
  maxGasPrice: 50, // 50 Gwei max (cost control)
  tradeAmount: 1, // 1 ETH
  watchedTokens: DEFAULT_WATCHED_TOKENS,
  autoExecute: true, // Auto-execute opportunities on Hardhat fork
};

/**
 * Get RPC URL for specific chain
 */
export function getRpcUrl(chainId: ChainId): string {
  return chainId === 1 ? NETWORKS.MAINNET.rpcUrl : NETWORKS.SEPOLIA.rpcUrl;
}

// Default to mainnet for backward compatibility
export const ETH_RPC_URL = NETWORKS.MAINNET.rpcUrl;

/**
 * Chainlink Price Feed Addresses
 */
export const CHAINLINK_PRICE_FEEDS = {
  1: {
    // Ethereum Mainnet
    ETH_USD: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  },
  11155111: {
    // Sepolia Testnet
    ETH_USD: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  },
} as const;

/**
 * Get Chainlink price feed address for specific chain
 */
export function getChainlinkPriceFeed(chainId: ChainId): string {
  return CHAINLINK_PRICE_FEEDS[chainId].ETH_USD;
}

/**
 * DEX Router 및 Aggregator 주소 (Ethereum Mainnet)
 */
export const DEX_ROUTERS_MAINNET = {
  [DexProtocol.ONE_INCH]: "0x1111111254EEB25477B68fb85Ed929f73A960582", // 1inch v5 Router
  [DexProtocol.PARASWAP]: "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57", // ParaSwap v5
  [DexProtocol.UNISWAP_V2]: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  [DexProtocol.UNISWAP_V3]: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  [DexProtocol.SUSHISWAP]: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
  [DexProtocol.BALANCER]: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  [DexProtocol.CURVE]: "0x8e764bE4288B842791989DB5b8ec067279829809",
};

/**
 * DEX Router addresses for Sepolia Testnet
 */
export const DEX_ROUTERS_SEPOLIA = {
  [DexProtocol.UNISWAP_V2]: "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008", // Sepolia Uniswap V2 Router
  [DexProtocol.UNISWAP_V3]: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E", // Sepolia Uniswap V3 Router
  [DexProtocol.SUSHISWAP]: "0x0000000000000000000000000000000000000000", // Not available on Sepolia
  [DexProtocol.BALANCER]: "0x0000000000000000000000000000000000000000", // Not available on Sepolia
  [DexProtocol.CURVE]: "0x0000000000000000000000000000000000000000", // Not available on Sepolia
  [DexProtocol.ONE_INCH]: "0x0000000000000000000000000000000000000000", // Not available on Sepolia
  [DexProtocol.PARASWAP]: "0x0000000000000000000000000000000000000000", // Not available on Sepolia
};

/**
 * Get DEX router addresses for specific chain
 */
export function getDexRouters(chainId: ChainId) {
  return chainId === 1 ? DEX_ROUTERS_MAINNET : DEX_ROUTERS_SEPOLIA;
}

// Default to mainnet for backward compatibility
export const DEX_ROUTERS = DEX_ROUTERS_MAINNET;

/**
 * 1inch API URL by chain
 */
export function get1inchApiUrl(chainId: ChainId): string {
  return chainId === 1
    ? "https://api.1inch.dev/swap/v6.0/1"
    : "https://api.1inch.dev/swap/v6.0/11155111"; // Sepolia (if supported)
}

export const ONE_INCH_API_URL = get1inchApiUrl(1);

/**
 * DEX Factory 주소 (Ethereum Mainnet)
 */
export const DEX_FACTORIES_MAINNET = {
  [DexProtocol.UNISWAP_V2]: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
  [DexProtocol.UNISWAP_V3]: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  [DexProtocol.SUSHISWAP]: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
};

/**
 * DEX Factory addresses for Sepolia Testnet
 */
export const DEX_FACTORIES_SEPOLIA = {
  [DexProtocol.UNISWAP_V2]: "0x7E0987E5b3a30e3f2828572Bb659A548460a3003", // Sepolia Uniswap V2 Factory
  [DexProtocol.UNISWAP_V3]: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c", // Sepolia Uniswap V3 Factory
  [DexProtocol.SUSHISWAP]: "0x0000000000000000000000000000000000000000", // Not available
};

/**
 * Get DEX factory addresses for specific chain
 */
export function getDexFactories(chainId: ChainId) {
  return chainId === 1 ? DEX_FACTORIES_MAINNET : DEX_FACTORIES_SEPOLIA;
}

// Default to mainnet for backward compatibility
export const DEX_FACTORIES = DEX_FACTORIES_MAINNET;

/**
 * Flash Loan Provider 주소 (Ethereum Mainnet)
 */
export const FLASH_LOAN_PROVIDERS_MAINNET = {
  [FlashLoanProtocol.AAVE_V3]: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  [FlashLoanProtocol.UNISWAP_V3]: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  [FlashLoanProtocol.BALANCER]: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
};

/**
 * Flash Loan Provider addresses for Sepolia Testnet
 */
export const FLASH_LOAN_PROVIDERS_SEPOLIA = {
  [FlashLoanProtocol.AAVE_V3]: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951", // Aave V3 Pool on Sepolia
  [FlashLoanProtocol.UNISWAP_V3]: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c", // Uniswap V3 Factory
  [FlashLoanProtocol.BALANCER]: "0x0000000000000000000000000000000000000000", // Not available
};

/**
 * Get flash loan provider addresses for specific chain
 */
export function getFlashLoanProviders(chainId: ChainId) {
  return chainId === 1 ? FLASH_LOAN_PROVIDERS_MAINNET : FLASH_LOAN_PROVIDERS_SEPOLIA;
}

// Default to mainnet for backward compatibility
export const FLASH_LOAN_PROVIDERS = FLASH_LOAN_PROVIDERS_MAINNET;

/**
 * Uniswap V3 Pools for Flash Swaps (Ethereum Mainnet)
 * Using 500 bps (0.05% fee) pools for lowest flash swap cost
 */
export const UNISWAP_V3_FLASH_POOLS_MAINNET = {
  WETH_USDC_500: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",   // 0.05% fee (BEST)
  WETH_USDC_3000: "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8",  // 0.3% fee
  WETH_USDT_3000: "0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36",  // 0.3% fee
  WETH_DAI_3000: "0xC2e9F25Be6257c210d7Adf0D4Cd6E3E881ba25f8",   // 0.3% fee
  WETH_WBTC_3000: "0xCBCdF9626bC03E24f779434178A73a0B4bad62eD",  // 0.3% fee
  USDC_USDT_100: "0x3416cF6C708Da44DB2624D63ea0AAef7113527C6",   // 0.01% fee (stablecoin pair)
} as const;

/**
 * Uniswap V3 Pools for Flash Swaps (Sepolia Testnet)
 */
export const UNISWAP_V3_FLASH_POOLS_SEPOLIA = {
  // Sepolia has limited liquidity, using what's available
  WETH_USDC_3000: "0x0000000000000000000000000000000000000000", // Not available or low liquidity
} as const;

/**
 * Get Uniswap V3 flash pool address
 * @param tokenA First token address
 * @param tokenB Second token address
 * @param chainId Chain ID
 * @returns Pool address or null if not found
 */
export function getUniswapV3FlashPool(
  tokenA: string,
  tokenB: string,
  chainId: ChainId
): string | null {
  if (chainId !== 1) {
    // Sepolia not supported yet due to low liquidity
    return null;
  }

  const weth = TOKENS_MAINNET.WETH.address.toLowerCase();
  const usdc = TOKENS_MAINNET.USDC.address.toLowerCase();
  const usdt = TOKENS_MAINNET.USDT.address.toLowerCase();
  const dai = TOKENS_MAINNET.DAI.address.toLowerCase();
  const wbtc = TOKENS_MAINNET.WBTC.address.toLowerCase();

  const token0 = tokenA.toLowerCase();
  const token1 = tokenB.toLowerCase();

  // WETH/USDC (highest volume, 0.05% fee)
  if ((token0 === weth && token1 === usdc) || (token0 === usdc && token1 === weth)) {
    return UNISWAP_V3_FLASH_POOLS_MAINNET.WETH_USDC_500;
  }

  // WETH/USDT
  if ((token0 === weth && token1 === usdt) || (token0 === usdt && token1 === weth)) {
    return UNISWAP_V3_FLASH_POOLS_MAINNET.WETH_USDT_3000;
  }

  // WETH/DAI
  if ((token0 === weth && token1 === dai) || (token0 === dai && token1 === weth)) {
    return UNISWAP_V3_FLASH_POOLS_MAINNET.WETH_DAI_3000;
  }

  // WETH/WBTC
  if ((token0 === weth && token1 === wbtc) || (token0 === wbtc && token1 === weth)) {
    return UNISWAP_V3_FLASH_POOLS_MAINNET.WETH_WBTC_3000;
  }

  // USDC/USDT (stablecoin pair, 0.01% fee)
  if ((token0 === usdc && token1 === usdt) || (token0 === usdt && token1 === usdc)) {
    return UNISWAP_V3_FLASH_POOLS_MAINNET.USDC_USDT_100;
  }

  return null;
}

/**
 * Flash Loan Fees by Protocol
 */
export const FLASH_LOAN_FEES = {
  [FlashLoanProtocol.AAVE_V3]: 0.09,      // 0.09% (9 bps)
  [FlashLoanProtocol.UNISWAP_V3]: 0.05,   // 0.05% (5 bps) for 500 tier pools
  [FlashLoanProtocol.BALANCER]: 0.0,      // 0.0% (free, but gas costs apply)
} as const;

/**
 * Get flash loan fee for protocol
 */
export function getFlashLoanFee(protocol: FlashLoanProtocol): number {
  return FLASH_LOAN_FEES[protocol];
}

/**
 * Flash Loan Arbitrage Contract Addresses
 */
export const ARBITRAGE_CONTRACTS = {
  1: "0x21b26c866cf0524011b5fba99d4cc9aba644c4fd", // Mainnet (deployed: 2025-12-20)
  11155111: "0x221f68BEBDF4D20660747a6105970C727E78c36b", // Sepolia V2 (Uniswap V3 Flash Swap support)
} as const;

/**
 * Get arbitrage contract address for specific chain
 */
export function getArbitrageContract(chainId: ChainId): string {
  return ARBITRAGE_CONTRACTS[chainId];
}
