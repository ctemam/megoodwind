/**
 * 유틸리티 함수들
 */

/**
 * 숫자를 축약된 형식으로 포맷 (1000 -> 1K)
 */
export function formatNumber(num: number): string {
  if (num >= 1_000_000_000) {
    return (num / 1_000_000_000).toFixed(2) + "B";
  }
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(2) + "M";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(2) + "K";
  }
  return num.toFixed(2);
}

/**
 * 가격을 USD 형식으로 포맷
 */
export function formatUSD(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * 타임스탬프를 상대적 시간으로 변환
 */
export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * 체인 ID를 이름으로 변환
 */
export function getChainName(chainId: number): string {
  const names: Record<number, string> = {
    1: "Ethereum",
    56: "BSC",
    137: "Polygon",
    42161: "Arbitrum",
    8453: "Base",
  };
  return names[chainId] || `Chain ${chainId}`;
}

/**
 * Token address to symbol mapping
 */
const TOKEN_NAMES: Record<string, string> = {
  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': 'WETH',
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 'USDC',
  '0xdAC17F958D2ee523a2206206994597C13D831ec7': 'USDT',
  '0x6B175474E89094C44Da98b954EedeAC495271d0F': 'DAI',
  '0x514910771AF9Ca656af840dff83E8264EcF986CA': 'LINK',
  '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': 'WBTC',
  '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984': 'UNI',
  '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9': 'AAVE',
  '0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F': 'SNX',
  '0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e': 'YFI',
  '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2': 'MKR',
  '0xD533a949740bb3306d119CC777fa900bA034cd52': 'CRV',
  '0x0D8775F648430679A709E98d2b0Cb6250d2887EF': 'BAT',
  '0xE41d2489571d322189246DaFA5ebDe1F4699F498': 'ZRX',
  '0x111111111117dC0aa78b770fA6A738034120C302': '1INCH',
  '0x0F5D2fB29fb7d3CFeE444a200298f468908cC942': 'MANA',
  '0x4d224452801ACEd8B2F0aebE155379bb5D594381': 'APE',
  '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0': 'MATIC',
  '0x4Fabb145d64652a948d72533023f6E7A623C7C53': 'BUSD',
  '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE': 'SHIB',
};

/**
 * Convert token address to token symbol
 */
export function getTokenName(address: string): string {
  const lowerAddress = address.toLowerCase();
  for (const [addr, name] of Object.entries(TOKEN_NAMES)) {
    if (addr.toLowerCase() === lowerAddress) {
      return name;
    }
  }
  // Return shortened address if not found
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
