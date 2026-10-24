/**
 * COMPTOOL → discovery prioritization (Phase B-a, Commander-approved).
 * CONTRACT: reads visibility_failure records → emits {priorityPools, priorityTokens, meta}.
 * Consumer: discovery boot orders enumeration — priority pools/tokens FIRST.
 * Fallback: stale/missing/empty store → empty priority = current behavior (documented, not silent).
 * NO strategy weighting; discovery-priority ≠ profitability.
 */
import { CiStore } from './store.js';
import { existsSync, statSync } from 'fs';

export interface DiscoveryPriority {
  priorityPools: string[];      // addresses competitors used that we lack — enumerate first
  priorityTokens: string[];     // tokens inside those pools (needs on-chain resolve upstream)
  sourceRecords: number;        // visibility_failure count feeding this
  storeAgeMs: number;           // freshness of the store snapshot
  stale: boolean;               // >maxAge → fallback active
  verdict: 'evidence' | 'fallback_empty';
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // stale beyond 24h → fallback

export function discoveryPriority(store = new CiStore(), chain = 'eth', maxAgeMs = MAX_AGE_MS): DiscoveryPriority {
  const file = `data/ci/store.json`;
  const age = existsSync(file) ? Date.now() - statSync(file).mtimeMs : Infinity;
  const stale = age > maxAgeMs;
  const recs = store.trusted().filter((r) => r.chain === chain && r.receiptVerified && r.attribution?.outcome === 'visibility_failure');
  // pools touched by failing routes that we don't see = enumeration priority
  const priorityPools = [...new Set(recs.flatMap((r) => r.pools ?? []))];
  const priorityTokens = [...new Set(recs.flatMap((r) => [r.profitToken].filter((t): t is string => !!t)))];
  return {
    priorityPools, priorityTokens, sourceRecords: recs.length,
    storeAgeMs: Math.round(age), stale,
    verdict: stale || (!priorityPools.length && !priorityTokens.length) ? 'fallback_empty' : 'evidence',
  };
}
