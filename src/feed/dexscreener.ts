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

/**
 * Canonical token ordering for a pool.
 *
 * Uniswap V2/V3 store reserves as token0/token1 with token0 < token1
 * (lexicographic by lowercase address). DexScreener's baseToken/quoteToken
 * ordering is market convention, NOT canonical — it is inverted roughly a
 * quarter of the time. Copying it straight into PoolRef corrupts spot prices,
 * graph edge rates, forensics peer-divergence, and solver amountOut math.
 *
 * This is a pure function: DexScreener returns correct *addresses*, just the
 * wrong *order*, so the lowercase address sort is authoritative without an
 * on-chain call. Decimals are later re-asserted on-chain by
 * resolveTokenDecimals (refresh.ts), which runs against canonical token0/1.
 *
 * priceUsd from DexScreener is USD per BASE token. When BASE != canonical
 * token0 we invert it so priceUsd always = USD per token0.
 */
function canonicalOrder(
  a: { address: string; symbol: string; decimals?: number },
  b: { address: string; symbol: string; decimals?: number },
): { t0: typeof a; t1: typeof a; inverted: boolean } {
  const aLower = a.address.toLowerCase();
  const bLower = b.address.toLowerCase();
  const inverted = aLower > bLower; // canonical: token0 < token1
  return inverted ? { t0: b, t1: a, inverted: true } : { t0: a, t1: b, inverted: false };
}

export function toPoolRef(chain: ChainKey, p: DSPair): PoolRef {
  const kind = kindFromLabels(p);
  const { t0, t1, inverted } = canonicalOrder(p.baseToken, p.quoteToken);

  // DexScreener priceUsd = USD per BASE token. Canonical priceUsd = USD per
  // token0. If base is not token0, invert (1 / price). Guard zero/negative.
  let priceUsd: number | undefined;
  if (p.priceUsd != null) {
    const v = Number(p.priceUsd);
    priceUsd = Number.isFinite(v) && v > 0
      ? inverted
        ? 1 / v
        : v
      : undefined;
  }

  return {
    address: p.pairAddress,
    chain,
    dexId: p.dexId,
    kind,
    token0: t0.address,
    token1: t1.address,
    symbol0: t0.symbol,
    symbol1: t1.symbol,
    dec0: t0.decimals ?? 18,
    dec1: t1.decimals ?? 18,
    feeBps: kind === 'v3'
      ? Math.round((p.fee ?? 0.3) * 100)
      : DEFAULT_FEE_BPS[p.dexId] ?? 30,
    liquidityUsd: p.liquidity?.usd ?? 0,
    priceUsd,
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
