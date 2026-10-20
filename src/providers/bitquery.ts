import { ChainKey } from '../config/index.js';
import { logger } from '../config/logger.js';

/**
 * Bitquery v2 — GraphQL indexer (streaming.bitquery.io), `ory_at_` Bearer.
 * Indexed DEX-trade history — behavioral evidence RPC can't synthesize:
 * a pool with ZERO real trades but a quotable spread is a bait signature.
 *
 * Doctrine (docs-verified): ~5 points/query — batching is nearly free,
 * one `SmartContract in: [...]` filter costs the same as a single address.
 * Free dev: 10k pts first month (~2k queries). Free tier is REALTIME-only
 * (no archive; `dataset: realtime`). Rate limit ~30 req/min free class.
 * Streams (WSS subscriptions) are paid-tier — not derived here.
 */

const log = logger('bitquery');
const ENDPOINT = 'https://streaming.bitquery.io/graphql';
const UA = 'allbright/1.0 (+https://devin.ai)';

let queriesUsed = 0;
let authDead = false;

/** Bitquery v2 network names — 'eth' verified live 2026-10-20. */
const NET: Partial<Record<ChainKey, string>> = {
  eth: 'eth', bsc: 'bsc', poly: 'matic', arb: 'arbitrum', op: 'optimism',
  avax: 'avalanche', base: 'base', linea: 'linea', scroll: 'scroll', blast: 'blast',
};

export function bitqueryKey(): string | undefined {
  return process.env.BITQUERY_API_KEY;
}

async function gql<T>(query: string): Promise<T | null> {
  const key = bitqueryKey();
  if (!key || authDead) return null;
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': UA },
      body: JSON.stringify({ query }),
    });
    if (r.status === 401 || r.status === 403) { authDead = true; log.warn('bitquery auth rejected — lane disabled'); return null; }
    if (!r.ok) return null;
    queriesUsed++;
    const j = (await r.json()) as { data?: T; errors?: { message: string }[] };
    if (j.errors?.length) { log.warn('bitquery gql error', j.errors[0].message.slice(0, 120)); return null; }
    return j.data ?? null;
  } catch {
    return null;
  }
}

/** Set of pair addresses that saw >=1 real DEX trade in `hours` —
 *  ONE batched query for the whole address set (Bitquery batch doctrine).
 *  `null` = lane unavailable (caller must not infer zero-trades). */
export async function pairsWithRecentTrades(
  chain: ChainKey,
  pairAddrs: string[],
  hours = 24,
): Promise<Set<string> | null> {
  const net = NET[chain];
  if (!net || !pairAddrs.length) return null;
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const list = pairAddrs.map((a) => `"${a.toLowerCase()}"`).join(',');
  const d = await gql<{ EVM: { DEXTrades: { Trade: { Dex: { Pair: { SmartContract: string } } } }[] } }>(
    `{ EVM(network: ${net}, dataset: realtime) { DEXTrades(limit: {count: 1000}, ` +
    `where: {Trade: {Dex: {Pair: {SmartContract: {in: [${list}]}}}}, ` +
    `Block: {Time: {since: "${since}"}}}) { Trade { Dex { Pair { SmartContract } } } } } }`,
  );
  if (!d) return null;
  return new Set(d.EVM.DEXTrades.map((t) => t.Trade.Dex.Pair.SmartContract.toLowerCase()));
}

export function bitqueryStats() {
  return { queriesUsed };
}
