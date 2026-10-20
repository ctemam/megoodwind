import { ChainConfig, cfg } from '../config/index.js';
import { logger } from '../config/logger.js';
import { RpcPool } from '../providers/rpcPool.js';
import { multicall } from '../providers/multicall.js';
import { ethers } from 'ethers';

/**
 * Expansion vector #2 — All Tokens & Decimals (on-chain discovery).
 * Ingests unified token-list JSON streams (Uniswap Token List standard:
 * verified address/symbol/decimals per chainId) — the typefetch hook the
 * principal directive asks for. Entries missing decimals are resolved
 * on-chain via IERC20.decimals() in ONE batch.
 */

const log = logger('tokenLists');

export interface DiscoveredToken {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
}

interface TokenListEntry {
  chainId: number;
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
}
interface TokenListDoc { tokens?: TokenListEntry[] }

const DECIMALS_ABI = new ethers.Interface(['function decimals() view returns (uint8)']);

export async function fetchTokenList(url: string): Promise<TokenListDoc | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
    if (!res.ok) { log.warn(`token list ${url} -> ${res.status}`); return null; }
    return (await res.json()) as TokenListDoc;
  } catch (e) {
    log.warn(`token list ${url} fetch failed`, e);
    return null;
  }
}

/** All verified tokens for a chain, merged across every configured list.
 *  Ranked by aggregated DexScreener liquidity (dynamic indexing — the
 *  matrix's DefiLlama/DS vector) so a top-N cut reaches deep pools first. */
export async function tokensForChain(chain: ChainConfig, rpc: RpcPool): Promise<DiscoveredToken[]> {
  const seen = new Map<string, DiscoveredToken>();
  for (const url of cfg.TOKEN_LIST_URLS.split(',').map((s) => s.trim()).filter(Boolean)) {
    const doc = await fetchTokenList(url);
    for (const t of doc?.tokens ?? []) {
      if (t.chainId !== chain.chainId || !t.address) continue;
      const k = t.address.toLowerCase();
      if (!seen.has(k)) {
        seen.set(k, {
          address: ethers.getAddress(t.address),
          symbol: t.symbol ?? t.name ?? k.slice(0, 8),
          decimals: t.decimals ?? -1,
          chainId: t.chainId,
        });
      }
    }
  }

  // resolve missing decimals on-chain — ONE aggregate3 request for the
  // entire missing set (Multicall3, not N eth_calls)
  const missing = [...seen.values()].filter((t) => t.decimals < 0);
  if (missing.length) {
    const results = await multicall(
      rpc,
      missing.map((t) => ({ to: t.address, data: DECIMALS_ABI.encodeFunctionData('decimals') })),
    );
    results.forEach((value, i) => {
      if (value !== '0x') {
        try { missing[i].decimals = Number(DECIMALS_ABI.decodeFunctionResult('decimals', value)[0]); }
        catch { /* leave -1 */ }
      }
    });
    for (const t of missing) if (t.decimals < 0) seen.delete(t.address.toLowerCase());
  }

  const out = [...seen.values()];
  log.info(`${chain.key}: ${out.length} tokens from ${cfg.TOKEN_LIST_URLS.split(',').length} list(s)`);
  return rankByLiquidity(chain, out);
}

/** Sum DS pair liquidity per token — pure data ranking, no manual seeding. */
async function rankByLiquidity(chain: ChainConfig, tokens: DiscoveredToken[]): Promise<DiscoveredToken[]> {
  const DS_ID: Record<string, string> = {
    eth: 'ethereum', bsc: 'bsc', poly: 'polygon', arb: 'arbitrum', op: 'optimism',
    avax: 'avalanche', base: 'base', linea: 'linea', scroll: 'scroll', blast: 'blast',
  };
  const dsId = DS_ID[chain.key] ?? chain.key;
  const liq = new Map<string, number>();
  try {
    for (let i = 0; i < tokens.length; i += 30) {
      const chunk = tokens.slice(i, i + 30).map((t) => t.address).join(',');
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/${dsId}/${chunk}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429) break; // budget guard — ranking is best-effort
      if (!res.ok) break;
      const data = (await res.json()) as
        | { baseToken: { address: string }; quoteToken: { address: string }; liquidity?: { usd?: number } }[]
        | { pairs?: { baseToken: { address: string }; quoteToken: { address: string }; liquidity?: { usd?: number } }[] };
      const pairs = Array.isArray(data) ? data : data.pairs ?? [];
      for (const p of pairs) {
        const usd = p.liquidity?.usd ?? 0;
        for (const addr of [p.baseToken.address, p.quoteToken.address]) {
          liq.set(addr.toLowerCase(), (liq.get(addr.toLowerCase()) ?? 0) + usd);
        }
      }
    }
  } catch (e) {
    log.debug('liquidity ranking partial', e);
  }
  return tokens.sort(
    (a, b) => (liq.get(b.address.toLowerCase()) ?? 0) - (liq.get(a.address.toLowerCase()) ?? 0),
  );
}
