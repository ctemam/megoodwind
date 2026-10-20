import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../config/logger.js';

/**
 * Item #21 — Persistent RPC endpoint registry.
 * Endpoint state (latency, verified chain, dead marks) survives restarts
 * in data/rpc_registry.json so a reboot doesn't pay the re-probe penalty:
 * members marked dead inside DEAD_TTL_MS hydrate as dead and never get a
 * boot handshake. Dead marks EXPIRE — a provider-side fix (key enabled,
 * quota window reset) self-heals on the next boot after TTL.
 */

const FILE = process.env.RPC_REGISTRY_PATH ?? join('data', 'rpc_registry.json');
const DEAD_TTL_MS = 60 * 60 * 1000;  // skip deads for 60 min, then re-qualify
const FLUSH_MS = 5_000;

export interface EndpointRecord {
  url: string;
  provider: string;
  account: string;
  chainId?: number;      // verified — mismatches are permanent defects, not flaps
  ewmaMs?: number;
  lastOk?: number;       // ts of last successful call
  deadUntil?: number;    // auth/config-fatal mark, expires for re-qualification
  deadReason?: string;
}

interface RegistryShape { endpoints: Record<string, EndpointRecord> } // key: chain:url

const log = logger('rpcRegistry');
let store: RegistryShape = { endpoints: {} };
let dirty = false;
let timer: NodeJS.Timeout | null = null;

function load() {
  try {
    const raw = readFileSync(FILE, 'utf8');
    store = JSON.parse(raw) as RegistryShape;
    log.info(`registry loaded: ${Object.keys(store.endpoints).length} endpoint records`);
  } catch { store = { endpoints: {} }; }
}
load();

function flush() {
  if (!dirty) return;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(store, null, 1));
    dirty = false;
  } catch (e) {
    log.warn('registry flush failed', e);
  }
}
function scheduleFlush() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
  timer.unref();
}
process.on('beforeExit', flush);

const key = (chain: string, url: string) => `${chain}:${url}`;

export const rpcRegistry = {
  /** Boot hydration — known-dead within TTL hydrates dead (no handshake). */
  isDead(chain: string, url: string): boolean {
    const r = store.endpoints[key(chain, url)];
    return !!r?.deadUntil && r.deadUntil > Date.now();
  },

  ewmaSeed(chain: string, url: string): number | undefined {
    const r = store.endpoints[key(chain, url)];
    return r?.deadUntil && r.deadUntil > Date.now() ? undefined : r?.ewmaMs;
  },

  upsert(chain: string, url: string, patch: Partial<Omit<EndpointRecord, 'url'>>) {
    const k = key(chain, url);
    const base: EndpointRecord = { url, provider: 'unknown', account: 'unknown' };
    store.endpoints[k] = { ...base, ...store.endpoints[k], ...patch };
    scheduleFlush();
  },

  markOk(chain: string, url: string, ewmaMs: number, chainId?: number, provider?: string, account?: string) {
    this.upsert(chain, url, { ewmaMs, lastOk: Date.now(), deadUntil: undefined, deadReason: undefined, chainId, provider, account });
  },

  /** Auth/config-fatal — dead until TTL expiry (60 min), then re-qualified. */
  markDead(chain: string, url: string, reason: string, provider?: string, account?: string) {
    this.upsert(chain, url, { deadUntil: Date.now() + DEAD_TTL_MS, deadReason: reason, provider, account });
  },

  stats() {
    const eps = Object.values(store.endpoints);
    const now = Date.now();
    return {
      total: eps.length,
      dead: eps.filter((e) => e.deadUntil && e.deadUntil > now).length,
      providers: [...new Set(eps.map((e) => e.provider))],
    };
  },
};
