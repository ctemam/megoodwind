import { ChainKey } from '../config/index.js';
import { logger } from '../config/logger.js';
import { DexKind, PoolRef } from '../pools/registry.js';

/**
 * Feed ingest — DexScreener primary (high-cap ~300/min, batched
 * /tokens/v1/{chain}/{up-to-30-addrs}), GeckoTerminal reserved for gaps.
 * DS responses carry ~30s CDN cache: always re-verify spreads on fresh
 * on-chain state before sizing.
 */

const DS_CHAIN: Record<string, string> = {
  eth: 'ethereum', bsc: 'bsc', poly: 'polygon', arb: 'arbitrum', op: 'optimism',
  avax: 'avalanche', base: 'base', linea: 'linea', scroll: 'scroll', blast: 'blast',
};
const dsChain = (key: ChainKey): string => DS_CHAIN[key] ?? key;

const log = logger('dexscreener');
const BASE = 'https://api.dexscreener.com';

interface DSPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; symbol: string; decimals?: number };
  quoteToken: { address: string; symbol: string; decimals?: number };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fee?: number;
}

function kindFromLabels(p: DSPair): DexKind {
  const labels = (p.labels ?? []).map((l) => l.toLowerCase());
  if (labels.some((l) => l === 'v3' || l === 'cl' || l === 'concentrated')) return 'v3';
  if (labels.some((l) => l === 'v2' || l === 'v1' || l === 'legacy')) return 'v2';
  // protocol-specific defaults only when labels are absent
  if (['uniswap'].includes(p.dexId) && labels.length === 0) return 'v2';
  return 'v2';
}

const DEFAULT_FEE_BPS: Record<string, number> = {
  uniswap: 30, sushiswap: 30, pancakeswap: 25, nomiswap: 10,
  quickswap: 30, camelot: 30, aerodrome: 30, velodrome: 30,
};

export function toPoolRef(chain: ChainKey, p: DSPair): PoolRef {
  const kind = kindFromLabels(p);
  return {
    address: p.pairAddress,
    chain,
    dexId: p.dexId,
    kind,
    token0: p.baseToken.address,
    token1: p.quoteToken.address,
    symbol0: p.baseToken.symbol,
    symbol1: p.quoteToken.symbol,
    dec0: p.baseToken.decimals ?? 18,
    dec1: p.quoteToken.decimals ?? 18,
    feeBps: kind === 'v3'
      ? Math.round((p.fee ?? 0.3) * 100)
      : DEFAULT_FEE_BPS[p.dexId] ?? 30,
    liquidityUsd: p.liquidity?.usd ?? 0,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : undefined,
  };
}

async function dsFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) { log.warn('DexScreener 429 — skip cycle, do not stall'); return null; }
    if (!res.ok) { log.warn(`DexScreener ${res.status} ${path}`); return null; }
    return (await res.json()) as T;
  } catch (e) {
    log.warn('DexScreener fetch failed', String(e));
    return null;
  }
}

/** Token->pairs lookup. /tokens/v1 collapsed to 1 pair per token;
 *  /token-pairs/v1 returns the full pool list (≤30) per token — one
 *  call per token, deduped by pairAddress. */
export async function poolsForTokens(chain: ChainKey, tokenAddrs: string[]): Promise<PoolRef[]> {
  const seen = new Set<string>();
  const out: PoolRef[] = [];
  for (const addr of tokenAddrs) {
    const data = await dsFetch<DSPair[] | { pairs?: DSPair[] }>(`/token-pairs/v1/${dsChain(chain)}/${addr}`);
    const pairs = Array.isArray(data) ? data : data?.pairs ?? [];
    for (const p of pairs) {
      const k = p.pairAddress?.toLowerCase();
      // DS lists vault-style pools whose "pairAddress" is a bytes32 pool
      // ID, not an EVM contract — drop them, they can never answer calls
      if (!k || !/^0x[0-9a-f]{40}$/.test(k) || seen.has(k)) continue;
      seen.add(k);
      out.push(toPoolRef(chain, p));
    }
  }
  return out;
}

/** Leader scan: trending/top pools on a chain (one request). */
export async function topPools(chain: ChainKey, query: string): Promise<PoolRef[]> {
  const data = await dsFetch<{ pairs?: DSPair[] }>(
    `/latest/dex/search?q=${encodeURIComponent(query)}`,
  );
  return (data?.pairs ?? [])
    .filter((p) => p.chainId === dsChain(chain) && /^0x[0-9a-fA-F]{40}$/.test(p.pairAddress ?? ''))
    .map((p) => toPoolRef(chain, p));
}
