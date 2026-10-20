import 'dotenv/config';
import { z } from 'zod';

/**
 * Item #13 — Environment Config (System Security Layer).
 * Single source of truth for env parsing. PRIVATE-keyed RPC only:
 * any URL without a key segment is rejected at boot.
 */

const csv = (s: string) => s.split(',').map((v) => v.trim()).filter(Boolean);

const envSchema = z.object({
  // keyed provider keys (item #10) — used to template private endpoints
  ALCHEMY_API_KEY: z.string().optional(),
  INFURA_API_KEY: z.string().optional(),
  DRPC_API_KEY: z.string().optional(),
  ANKR_API_KEY: z.string().optional(),
  PIMLICO_API_KEY: z.string().min(1, 'PIMLICO_API_KEY required (ERC-4337 bundler/paymaster)'),
  ZERODEV_PROJECT_ID: z.string().optional(),
  VELORA_API_KEY: z.string().optional(),
  WHALE_ALERT_API_KEY: z.string().optional(),
  FLASHBOOTS_RELAY: z.string().default('https://relay.flashbots.net'),
  FLASHBOOTS_AUTH_KEY: z.string().optional(),

  // identity
  PRIVATE_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, 'PRIVATE_KEY must be 32-byte hex'),
  SMART_ACCOUNT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  PROFIT_WALLET: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  PROFIT_TRANSFER_MODE: z.enum(['AUTO', 'MANUAL']).default('AUTO'),
  PROFIT_TRANSFER_MIN_USD: z.coerce.number().default(100),

  // execution
  AUTO_EXECUTE: z.coerce.boolean().default(false),
  MIN_PROFIT_USD: z.coerce.number().default(5),
  SCAN_INTERVAL_SECS: z.coerce.number().default(12),
  ACTIVE_CHAINS: z.string().default('eth,bsc,poly'),
  STRATEGIES: z.string().default('TRACE,P01,P02'),
  NATIVE_USD: z.coerce.number().default(2600),
  PORT: z.coerce.number().default(3001),

  // ToR III predictive params
  PREDICTIVE_CHAINS: z.string().default('eth,bsc,poly'),
  BACKRUN_CHAINS: z.string().default('arb,op,base,avax,linea,scroll,blast'),
  MAX_TICK_DISTANCE: z.coerce.number().default(200),
  STRICT_PROFIT_FLOOR_GUARD: z.coerce.boolean().default(true),
  AUCTION_CHAINS: z.string().default('eth'),
  COINBASE_BRIBE_PCT: z.coerce.number().default(50),
  COINBASE_BRIBE_PCT_MAX: z.coerce.number().default(80),
  MAX_BASE_FEE_GWEI: z.coerce.number().default(300),
  PRIORITY_FEE_GWEI: z.coerce.number().default(5),
  SLIPPAGE_BPS: z.coerce.number().default(15),
  FOT_BLACKLIST_PATH: z.string().default('tools/fot_blacklist.json'),
  PEND_THROTTLE_MS: z.coerce.number().default(100),
  EV_CHAINS: z.string().default(''),
  P09_ENABLED: z.coerce.boolean().default(false),
  RPC_PRIVATE_CHAINS: z.string().default(''),

  // Discovery engine — automated multi-chain expansion (no manual registration)
  TOKEN_LIST_URLS: z.string().default('https://tokens.uniswap.org'),
  DISCOVERY_TOP_TOKENS: z.coerce.number().default(60),
  DISCOVERY_RESCAN_SECS: z.coerce.number().default(300),
  DISCOVERY_MAX_FACTORIES: z.coerce.number().default(8),
});

/** Generic chain key — any string. The 10 provisioned chains ship with
 *  known IDs; ANY additional chain joins the fleet by setting
 *  `CHAIN_ID_<KEY>` + keyed `<KEY>_RPC_URLS` in env — zero code edits. */
export type ChainKey = string;

export const KNOWN_CHAIN_ID: Record<string, number> = {
  eth: 1, bsc: 56, poly: 137, arb: 42161, op: 10,
  avax: 43114, base: 8453, linea: 59144, scroll: 534352, blast: 81457,
};

export function chainIdFor(key: ChainKey): number {
  const envKey = `CHAIN_ID_${key.toUpperCase()}`;
  const fromEnv = process.env[envKey];
  if (fromEnv) return Number(fromEnv);
  const known = KNOWN_CHAIN_ID[key];
  if (known) return known;
  throw new Error(`unknown chain '${key}' — set ${envKey}=<eip155 chainId>`);
}

export const CHAIN_BY_ID: Record<number, ChainKey> = Object.fromEntries(
  Object.entries(KNOWN_CHAIN_ID).map(([k, v]) => [v, k]),
);

/** Env var prefix for a chain — convention is the uppercase key. */
export const envPrefixFor = (key: ChainKey): string => key.toUpperCase();

const raw = envSchema.parse(process.env);

/** PUBLIC-RPC LOCK (Commander protocol): a URL is "private keyed" iff it
 *  carries a credential — path segment, ?dkey=/?key=/?token= query, or
 *  userinfo. Everything else is rejected so it can never enter a pool. */
const KEYED_URL = /^https?:\/\/[^/]*(:[^@/]+@)?[^/]*\/[^/]+|dkey=|key=|token=|apikey=/i;
const KEYED_WSS = /^wss:\/\/[^/]*(:[^@/]+@)?[^/]*\/[^/]+|dkey=|key=|token=|apikey=/i;

export function assertPrivateUrl(url: string, wss = false): string {
  const ok = wss ? KEYED_WSS.test(url) : KEYED_URL.test(url);
  if (!ok) throw new Error(`PUBLIC_RPC_FORBIDDEN: unkeyed endpoint rejected: ${url}`);
  return url;
}

function collect(kind: 'RPC_URLS' | 'RPC_URL' | 'WSS_URL', chain: ChainKey): string[] {
  const val = process.env[`${envPrefixFor(chain)}_${kind}`];
  if (!val) return [];
  return csv(val).map((u) => assertPrivateUrl(u, kind === 'WSS_URL'));
}

export interface ChainConfig {
  key: ChainKey;
  chainId: number;
  rpcUrls: string[];   // pool (rotated on 429/timeout)
  fallbackRpcUrl?: string; // single-endpoint fallback pool member
  wssUrl?: string;
  executor?: string;
  role: 'predictive' | 'backrun' | 'inactive';
}

export const cfg = {
  ...raw,
  activeChains: csv(raw.ACTIVE_CHAINS),
  predictiveChains: csv(raw.PREDICTIVE_CHAINS),
  backrunChains: csv(raw.BACKRUN_CHAINS),
  auctionChains: csv(raw.AUCTION_CHAINS),
  strategies: csv(raw.STRATEGIES),
  evChains: csv(raw.EV_CHAINS),
  privateChains: csv(raw.RPC_PRIVATE_CHAINS),
};

export function chainConfig(chain: ChainKey): ChainConfig {
  const role: ChainConfig['role'] = cfg.predictiveChains.includes(chain)
    ? 'predictive'
    : cfg.backrunChains.includes(chain)
      ? 'backrun'
      : 'inactive';
  const pool = collect('RPC_URLS', chain);
  const fallback = collect('RPC_URL', chain);
  const wss = collect('WSS_URL', chain);
  return {
    key: chain,
    chainId: chainIdFor(chain),
    rpcUrls: pool.length ? pool : fallback,
    fallbackRpcUrl: fallback[0],
    wssUrl: wss[0],
    executor: process.env[`ALLBRIGHT_EXECUTOR_${envPrefixFor(chain)}`],
    role,
  };
}

export const activeChainConfigs = (): ChainConfig[] =>
  cfg.activeChains.map(chainConfig);

export const privKeyHex = (): `0x${string}` =>
  (raw.PRIVATE_KEY.startsWith('0x') ? raw.PRIVATE_KEY : `0x${raw.PRIVATE_KEY}`) as `0x${string}`;
