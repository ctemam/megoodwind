import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChainKey } from '../config/index.js';

/**
 * Routing-config overlay — `rpc_pool_config.json` is the live source of
 * truth for provider STATUS + per-chain reachability. The TypeScript
 * catalog owns URL templates and documented budgets; this file owns the
 * operational state (LIVE / RESERVE / SUSPENDED) so a console-side event
 * (e.g. Chainstack Global Node attach) flips routing without a code
 * change — `scripts/sync_rpc_pool_status.ts` promotes automatically.
 *
 * Rules enforced here:
 *  - status SUSPENDED*            => emit zero endpoints (no probe, no retry)
 *  - supported_chains = ["all"]   => wildcard; explicit list = whitelist
 *  - empty supported_chains       => serves nothing
 * Missing file => permissive (catalog defaults rule) — never a boot wedge.
 */

interface ProviderEntry {
  safe_rps?: number;
  daily_budget?: number;
  supports_wss?: boolean;
  supported_chains?: string[];
  status?: string;
  priority?: number;
}

interface PoolConfig {
  system_mode?: string;
  provider_catalog?: Record<string, ProviderEntry>;
}

// RPC_POOL_CONFIG_PATH lets tests/tooling point at a scratch config so a
// state-transition probe can never race the live file the sync daemon owns.
const CONFIG_PATH = resolve(process.env.RPC_POOL_CONFIG_PATH ?? 'rpc_pool_config.json');
const RELOAD_MS = 30_000; // mtime poll cadence — hot-picks promote/demote edits

let cfg: PoolConfig | null = null;
let loaded = false;
let lastCheck = 0;
let lastMtime = 0;

function load(force = false) {
  const now = Date.now();
  if (!force && loaded && now - lastCheck < RELOAD_MS) return;
  lastCheck = now;
  try {
    const mtime = statSync(CONFIG_PATH).mtimeMs;
    if (!force && loaded && mtime === lastMtime) return;
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as PoolConfig;
    lastMtime = mtime;
    loaded = true;
  } catch {
    // Partial-write safe: a torn JSON (manual edit racing the sync daemon's
    // writeFileSync) keeps the LAST GOOD config in memory — never drops to
    // permissive or wedges. Only a first-boot failure falls back to null.
    if (!loaded) cfg = null;
  }
}

export function providerEntry(id: string): ProviderEntry | undefined {
  load();
  return cfg?.provider_catalog?.[id];
}

/** Suspended/quarantined providers emit NOTHING — pre-emptive skip, not
 *  a dead-lane fallback. The endpoint never reaches the pool. */
export function isSuspended(id: string): boolean {
  const s = providerEntry(id)?.status ?? '';
  return /^SUSPENDED|^QUARANTINED|^DISABLED/i.test(s);
}

/** Chain-level gate: whitelist in the config beats the catalog slug map —
 *  Alchemy emits `eth` only until dashboard toggles flip, regardless of
 *  the full slug table. Absent entry => catalog decides (permissive). */
export function providerServesChain(id: string, chain: ChainKey): boolean {
  const entry = providerEntry(id);
  if (!entry?.supported_chains) return true;
  const chains = entry.supported_chains;
  return chains.includes('all') || chains.includes(chain);
}

/** Routing priority from the config (1 = primary). Used as an ordering
 *  hint; EWMA latency still arbitrates between same-priority lanes. */
export function providerPriority(id: string): number {
  return providerEntry(id)?.priority ?? 50;
}

/** Force re-read — the sync script calls this after promoting a provider. */
export function reloadPoolConfig() { load(true); }
