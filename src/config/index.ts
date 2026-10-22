import 'dotenv/config';
import { z } from 'zod';
import * as providers from '../providers/providerCatalog.js';

/**
 * Item #13 — Environment Config (System Security Layer).
 * Single source of truth for env parsing. PRIVATE-keyed RPC only:
 * any URL without a key segment is rejected at boot.
 */

const csv = (s: string) => s.split(',').map((v) => v.trim()).filter(Boolean);

/** Env booleans are strings — z.coerce.boolean() applies Boolean(),
 *  which parses "false" as TRUE (non-empty string). That bug silently
 *  armed AUTO_EXECUTE whenever it was set to "false" — every historical
 *  "shadow" run was actually armed.
 *  Fail-closed: an unrecognized string (e.g. "flase", "") raises a zod
 *  issue and the process refuses to start — never silently disarmed OR
 *  armed on a typo. */
const boolEnv = (def: boolean) =>
  z.union([z.boolean(), z.string()])
    .transform((v, ctx) => {
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      if (/^(1|true|yes|on)$/.test(s)) return true;
      if (/^(0|false|no|off)$/.test(s)) return false;
      ctx.addIssue({ code: 'custom', message: `unrecognized boolean "${v}" (expected true/false/1/0/yes/no/on/off)` });
      return z.NEVER;
    })
    .default(def);

const envSchema = z.object({
  // keyed provider keys (item #10) — used to template private endpoints
  ALCHEMY_API_KEY: z.string().optional(),
  INFURA_API_KEY: z.string().optional(),
  DRPC_API_KEY: z.string().optional(),
  ANKR_API_KEY: z.string().optional(),
  NODEFLARE_API_KEY: z.string().optional(),
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
  AUTO_EXECUTE: boolEnv(false),
  // diagnostics-only profile — forced AUTO_EXECUTE=false at load AND
  // refused at executeCandidate; cannot reach the send path.
  DIAG_ONLY: boolEnv(false),
  // fail-closed arming: AUTO_EXECUTE=true only arms a chain whose numeric
  // chainId is explicitly listed here (e.g. ARM_LIVE=1,56,137).
  // Missing or malformed (any non-integer token) => disarmed everywhere.
  ARM_LIVE: z.string().optional(),
  MIN_PROFIT_USD: z.coerce.number().default(5),
  // USD-target flash borrow before per-path right-sizing (emit() shrinks
  // it to the slippage bound and the variant's sizeCapUsd)
  FLASH_BORROW_USD: z.coerce.number().default(10_000),
  // lane-specific floors — a whale-triggered path must clear a higher bar
  // (competition is fiercest right after a big transfer reprices a venue)
  PREDICTIVE_MIN_PROFIT_USD: z.coerce.number().default(2.5),
  WHALE_MIN_PROFIT_USD: z.coerce.number().default(25),
  SCAN_INTERVAL_SECS: z.coerce.number().default(12),
  ACTIVE_CHAINS: z.string().default('eth,bsc,poly'),
  STRATEGIES: z.string().default('TRACE,P01,P02'),
  NATIVE_USD: z.coerce.number().default(2600),
  PORT: z.coerce.number().default(3001),

  // ToR III predictive params
  PREDICTIVE_CHAINS: z.string().default('eth,bsc,poly'),
  BACKRUN_CHAINS: z.string().default('arb,op,base,avax,linea,scroll,blast'),
  MAX_TICK_DISTANCE: z.coerce.number().default(200),
  STRICT_PROFIT_FLOOR_GUARD: boolEnv(true),
  AUCTION_CHAINS: z.string().default('eth'),
  COINBASE_BRIBE_PCT: z.coerce.number().default(50),
  COINBASE_BRIBE_PCT_MAX: z.coerce.number().default(80),
  MAX_BASE_FEE_GWEI: z.coerce.number().default(300),
  PRIORITY_FEE_GWEI: z.coerce.number().default(5),
  SLIPPAGE_BPS: z.coerce.number().default(15),
  // dynamic slippage auto-tuning — bounds, not a static wall
  SLIPPAGE_LOW_VOL_BPS: z.coerce.number().default(10),    // 0.1% protective on dead tape
  SLIPPAGE_BASELINE_BPS: z.coerce.number().default(10),   // 0.1% frontrun-protective baseline on standard (BALANCED) loops
  WHALE_SLIPPAGE_BPS: z.coerce.number().default(150),     // alpha-window width (transient spreads)
  SLIPPAGE_CEILING_BPS: z.coerce.number().default(200),   // absolute cap — never beyond
  FOT_BLACKLIST_PATH: z.string().default('tools/fot_blacklist.json'),
  PEND_THROTTLE_MS: z.coerce.number().default(100),
  EV_CHAINS: z.string().default(''),
  P09_ENABLED: boolEnv(false),
  RPC_PRIVATE_CHAINS: z.string().default(''),

  // Discovery engine — automated multi-chain expansion (no manual registration)
  TOKEN_LIST_URLS: z.string().default('https://tokens.uniswap.org'),
  DISCOVERY_TOP_TOKENS: z.coerce.number().default(30),      // conservative: majors cut only
  DISCOVERY_RESCAN_SECS: z.coerce.number().default(300),
  DISCOVERY_MAX_FACTORIES: z.coerce.number().default(8),
  DISCOVERY_BATCH_DELAY_MS: z.coerce.number().default(35),  // inter-batch throttle vs 429s
  DISCOVERY_BATCH_SIZE: z.coerce.number().default(200),
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
// DIAG_ONLY hard-gate — enforced at load, not honored by convention.
if (raw.DIAG_ONLY) raw.AUTO_EXECUTE = false;

/** Armed chainIds — AUTO_EXECUTE=true only arms chains whose chainId is
 *  explicitly listed in ARM_LIVE. ANY malformed token disarms the whole
 *  value (fail-closed, never partially parsed). */
const armTokens = (raw.ARM_LIVE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const armParsed = armTokens.map(Number);
const armedChains = new Set<number>(
  raw.ARM_LIVE !== undefined && armTokens.length > 0 && armParsed.every((n) => Number.isInteger(n) && n > 0)
    ? armParsed
    : [],
);

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
  wssUrls?: string[];  // full WSS candidate pool — rotated on dead-lane
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
  armedChains: [...armedChains],
};

/** The ONLY place live sends are authorized: AUTO_EXECUTE parsed true
 *  AND this chain's chainId is in ARM_LIVE. Everything else is shadow. */
export function armedFor(chainId: number): boolean {
  return cfg.AUTO_EXECUTE && armedChains.has(chainId);
}

export function chainConfig(chain: ChainKey): ChainConfig {
  const role: ChainConfig['role'] = cfg.predictiveChains.includes(chain)
    ? 'predictive'
    : cfg.backrunChains.includes(chain)
      ? 'backrun'
      : 'inactive';
  const pool = collect('RPC_URLS', chain);
  const fallback = collect('RPC_URL', chain);
  const wss = collect('WSS_URL', chain);
  // Provider-key expansion: every configured *_API_KEY contributes its
  // keyed endpoint — distinct accounts = distinct quota pools (the real
  // headroom). Explicit env URLs keep precedence; expansion is deduped.
  const { keyedEndpointsFor, keyedWssFor } = providers;
  for (const e of keyedEndpointsFor(chain)) if (!pool.includes(e.url)) pool.push(e.url);
  const wssPool = [...wss, ...keyedWssFor(chain).map((e) => e.url)];
  return {
    key: chain,
    chainId: chainIdFor(chain),
    rpcUrls: pool.length ? pool : fallback,
    fallbackRpcUrl: fallback[0],
    wssUrl: wssPool[0],
    wssUrls: wssPool,
    executor: process.env[`ALLBRIGHT_EXECUTOR_${envPrefixFor(chain)}`],
    role,
  };
}

export const activeChainConfigs = (): ChainConfig[] =>
  cfg.activeChains.map(chainConfig);

export const privKeyHex = (): `0x${string}` =>
  (raw.PRIVATE_KEY.startsWith('0x') ? raw.PRIVATE_KEY : `0x${raw.PRIVATE_KEY}`) as `0x${string}`;
