import { ChainKey } from '../config/index.js';

/**
 * Item #10/#12 — PRIVATE PROVIDER CATALOG (keyed free-tier universe).
 *
 * Verified 2026-10-19 against provider docs — NOT memorized:
 *   Alchemy  : 30M CU/mo, 300 CU/s (~15 req/s), token-bucket 10s window
 *   Ankr     : Freemium 30 req/s Node API, 200M credits/mo, HTTPS only on free
 *   dRPC     : 210M CU/30d, ~120k CU/min per IP (~100 eth_call/s nominal,
 *              min 50.4k CU/min under load), JSON-RPC batch capped at 3
 *   NodeFlare: ~2–3M CU/mo free (docs disagree — conservative bound used),
 *              10 req/s keyed; WSS only on eth/base/bnb/arb/op/avax
 *   Chainstack: Developer free 3M RU/mo, 25 RPS, 1 RU/req (archive 2 RU);
 *              `mt_` MULTICHAIN token = one auth token across every attached
 *              Global Node (one node per protocol+network). 401 "Access token
 *              missing or invalid" = node not deployed/not attached — fix is
 *              console: deploy Global Node + attach to multichain endpoint.
 *              Verified 2026-10-20 via mcp.chainstack.com + DNS.
 *
 * Doctrine: rate limits bind per ACCOUNT KEY, not per URL. Two same-key
 * URLs = zero extra headroom. Multi-PROVIDER pooling is the real capacity
 * lever — each provider's key is a separate quota pool.
 *
 * Public/keyless endpoints are forbidden (Commander protocol) — every
 * template here embeds the account key.
 */

export interface ProviderSpec {
  id: string;
  envKey: string;                 // *_API_KEY env var
  /** slug per chain key; absent => provider does not serve that chain */
  slugs: Partial<Record<ChainKey, string>>;
  http: (slug: string, key: string) => string;
  wss?: (slug: string, key: string) => string;
  /** documented free-tier request ceiling (req/s); SAFE_RPS = ×0.9 */
  rps: number;
  cuPerMonth: number;             // documented free compute budget
  /** CU cost per method (for budget accounting, not billing) */
  cuCost: Record<string, number> & { default: number };
  wssChains?: ChainKey[];         // chains where WSS is verified/doc'd on free tier
  /** JSON-RPC envelope batch limit (multicall contract calls unaffected) */
  batchLimit?: number;
  notes?: string;
}

export const PRIVATE_PROVIDERS: ProviderSpec[] = [
  {
    id: 'drpc',
    envKey: 'DRPC_API_KEY',
    slugs: {
      eth: 'ethereum', bsc: 'bsc', poly: 'polygon', arb: 'arbitrum', op: 'optimism',
      avax: 'avalanche', base: 'base', linea: 'linea', scroll: 'scroll', blast: 'blast',
    },
    http: (slug, key) => `https://lb.drpc.org/ogrpc?network=${slug}&dkey=${key}`,
    wss: (slug, key) => `wss://lb.drpc.org/ogws?network=${slug}&dkey=${key}`,
    rps: 40,                    // measured floor under load (min 50.4k CU/min ≈ 40 eth_call/s)
    cuPerMonth: 210_000_000,
    cuCost: { eth_call: 20, eth_getLogs: 30, eth_blockNumber: 10, eth_chainId: 0, default: 20 },
    wssChains: ['eth', 'bsc', 'poly', 'arb', 'op', 'avax', 'base', 'linea', 'scroll', 'blast'],
    batchLimit: 3,              // JSON-RPC envelope cap — multicall aggregate3 unaffected
    notes: 'free plan = public-node class behind keyed URL; WSS measured live though docs list it paid-only — capability, not guarantee',
  },
  {
    id: 'alchemy',
    envKey: 'ALCHEMY_API_KEY',
    slugs: {
      eth: 'eth-mainnet', bsc: 'bnb-mainnet', poly: 'polygon-mainnet',
      arb: 'arb-mainnet', op: 'opt-mainnet', avax: 'avax-mainnet',
      base: 'base-mainnet', linea: 'linea-mainnet', scroll: 'scroll-mainnet',
      blast: 'blast-mainnet',
    },
    http: (slug, key) => `https://${slug}.g.alchemy.com/v2/${key}`,
    wss: (slug, key) => `wss://${slug}.g.alchemy.com/v2/${key}`,
    rps: 15,
    cuPerMonth: 30_000_000,     // account-level; 300 CU/s throughput (10s token bucket)
    cuCost: { eth_call: 26, eth_getLogs: 75, eth_blockNumber: 10, eth_chainId: 0, default: 26 },
    wssChains: ['eth', 'bsc', 'poly', 'arb', 'op', 'avax', 'base', 'linea', 'scroll', 'blast'],
    notes: 'CU/s is account-wide across apps — one app consuming starves all',
  },
  {
    id: 'ankr',
    envKey: 'ANKR_API_KEY',
    slugs: {
      eth: 'eth', bsc: 'bsc', poly: 'polygon', arb: 'arbitrum', op: 'optimism',
      avax: 'avalanche', base: 'base', linea: 'linea', scroll: 'scroll', blast: 'blast',
    },
    http: (slug, key) => `https://rpc.ankr.com/${slug}/${key}`,
    rps: 30,
    cuPerMonth: 200_000_000,    // API credits — ~1 credit/simple request
    cuCost: { eth_call: 1, eth_getLogs: 1, eth_blockNumber: 1, eth_chainId: 0, default: 1 },
    notes: 'freemium is HTTPS-only per plan table (WSS on Premium) — do not derive wss URLs',
  },
  {
    id: 'nodeflare',
    envKey: 'NODEFLARE_API_KEY',
    slugs: {
      eth: 'eth', bsc: 'bnb', poly: 'polygon', arb: 'arb', op: 'op',
      avax: 'avax', base: 'base', linea: 'linea',
      // scroll/blast absent from their 23-chain list at this tier — excluded, not assumed
    },
    http: (slug, key) => `https://rpc.nodeflare.app/${slug}/v1/${key}`,
    wss: (slug, key) => `wss://rpc.nodeflare.app/${slug}/ws/v1/${key}`,
    rps: 10,
    cuPerMonth: 2_000_000,      // docs say 3M, llms.txt 2M — conservative bound
    cuCost: { eth_call: 1, eth_getLogs: 8, eth_blockNumber: 1, eth_chainId: 0, default: 1 },
    wssChains: ['eth', 'base', 'bsc', 'arb', 'op', 'avax'], // poly 404 measured on this tier
    notes: 'keyed requests exempt from UA policy; send a named UA anyway',
  },
  {
    id: 'chainstack',
    envKey: 'CHAINSTACK_API_KEY',
    slugs: {
      eth: 'ethereum-mainnet', bsc: 'bsc-mainnet', poly: 'polygon-mainnet',
      arb: 'arbitrum-mainnet', op: 'optimism-mainnet', avax: 'avalanche-mainnet',
      base: 'base-mainnet', linea: 'linea-mainnet', scroll: 'scroll-mainnet',
      blast: 'blast-mainnet',
    },
    http: (slug, key) => `https://${slug}.core.chainstack.com/${key}`,
    wss: (slug, key) => `wss://${slug}.core.chainstack.com/${key}`,
    rps: 25,
    cuPerMonth: 3_000_000,      // Developer free: 3M RU/mo; overage $20/1M (kept as budget, not spending)
    cuCost: { eth_call: 1, eth_getLogs: 1, eth_blockNumber: 1, eth_chainId: 0, default: 1 },
    wssChains: ['eth', 'bsc', 'poly', 'arb', 'op', 'avax', 'base', 'linea', 'scroll', 'blast'],
    notes: 'key = `mt_` multichain token (one token, all attached Global Nodes) OR per-node auth token — same URL slot. `401 Access token missing or invalid` = no Global Node attached, NOT a bad key. Slugs DNS-verified 2026-10-20.',
  },
];

/** Multi-app key schema — <P>_API_KEY plus <P>_API_KEY_2.._5. Every key is
 *  a SEPARATE provider account = a separate quota pool (the rotational
 *  schema: when app-1's bucket drains, app-2's is still full). */
const keysFor = (envKey: string): string[] =>
  [process.env[envKey], ...[2, 3, 4, 5].map((n) => process.env[`${envKey}_${n}`])]
    .filter((k): k is string => !!k);

/** All keyed HTTP endpoints a chain gets from configured provider keys.
 *  Returns {url, providerId} — the caller dedupes against explicit env URLs. */
export function keyedEndpointsFor(chain: ChainKey): { url: string; provider: string }[] {
  const out: { url: string; provider: string }[] = [];
  for (const p of PRIVATE_PROVIDERS) {
    const slug = p.slugs[chain];
    if (!slug) continue;
    for (const key of keysFor(p.envKey)) out.push({ url: p.http(slug, key), provider: p.id });
  }
  return out;
}

export function keyedWssFor(chain: ChainKey): { url: string; provider: string }[] {
  const out: { url: string; provider: string }[] = [];
  for (const p of PRIVATE_PROVIDERS) {
    const slug = p.slugs[chain];
    if (!slug || !p.wss) continue;
    if (p.wssChains && !p.wssChains.includes(chain)) continue;
    for (const key of keysFor(p.envKey)) out.push({ url: p.wss(slug, key), provider: p.id });
  }
  return out;
}

/** Provider identification for a URL — used to group members by account
 *  (quota pools bind per account key, not per endpoint). */
export function providerOf(url: string): { id: string; account: string } {
  try {
    const u = new URL(url);
    const h = u.hostname;
    let id = 'unknown';
    if (h.endsWith('drpc.org') || h.endsWith('drpc.live')) id = 'drpc';
    else if (h.endsWith('g.alchemy.com') || h.endsWith('alchemyapi.io')) id = 'alchemy';
    else if (h === 'rpc.ankr.com') id = 'ankr';
    else if (h === 'rpc.nodeflare.app') id = 'nodeflare';
    else if (h.endsWith('core.chainstack.com')) id = 'chainstack';
    else if (h.endsWith('infura.io')) id = 'infura';
    const spec = PRIVATE_PROVIDERS.find((p) => p.id === id);
    // account token: dkey query / last path segment / v2 token
    const account =
      u.searchParams.get('dkey') ??
      u.searchParams.get('key') ??
      u.pathname.split('/').filter(Boolean).pop() ??
      h;
    return { id: spec ? id : `other:${h}`, account: `${id}:${account.slice(0, 12)}` };
  } catch {
    return { id: 'unknown', account: url.slice(0, 24) };
  }
}

export function specOf(id: string): ProviderSpec | undefined {
  return PRIVATE_PROVIDERS.find((p) => p.id === id);
}
