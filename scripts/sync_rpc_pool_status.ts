import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRIVATE_PROVIDERS } from '../src/providers/providerCatalog.js';
import { chainIdFor } from '../src/config/index.js';

/**
 * Status sync — promotes SUSPENDED providers in rpc_pool_config.json the
 * moment their endpoints answer. The console-side event (e.g. Chainstack
 * Global Node attach) flips routing WITHOUT a code change; the pool's
 * mtime-aware loader hot-picks the new status within ~30s.
 *
 *   npx tsx scripts/sync_rpc_pool_status.ts          # one-shot check
 *   npx tsx scripts/sync_rpc_pool_status.ts --watch  # recheck every 60s
 */

const CONFIG_PATH = resolve(process.cwd(), 'rpc_pool_config.json');
const isSuspended = (s: string | undefined) => /^SUSPENDED|^QUARANTINED|^DISABLED/i.test(s ?? '');

async function probe(url: string, expectedChainId: number): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { result?: string };
    return j.result === `0x${expectedChainId.toString(16)}`;
  } catch {
    return false;
  }
}

async function syncOnce(): Promise<boolean> {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
    provider_catalog?: Record<string, { status?: string; supported_chains?: string[]; daily_budget?: number; priority?: number }>;
  };
  let promoted = false;
  for (const spec of PRIVATE_PROVIDERS) {
    const entry = cfg.provider_catalog?.[spec.id];
    if (!entry || !isSuspended(entry.status)) continue;
    const key = process.env[spec.envKey];
    if (!key) continue;
    const liveChains: string[] = [];
    for (const [chain, slug] of Object.entries(spec.slugs)) {
      const ok = await probe(spec.http(slug, key), chainIdFor(chain));
      if (ok) liveChains.push(chain);
      console.log(`  ${spec.id}/${chain}: ${ok ? 'LIVE' : 'dead'}`);
    }
    if (liveChains.length) {
      entry.status = 'LIVE';
      entry.supported_chains = liveChains;
      entry.daily_budget = Math.floor(spec.cuPerMonth / 30 / spec.cuCost.default);
      entry.priority = 2;
      promoted = true;
      console.log(`PROMOTED ${spec.id}: ${liveChains.length}/${Object.keys(spec.slugs).length} chains live -> status=LIVE`);
    }
  }
  if (promoted) {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`rpc_pool_config.json updated — pool hot-picks within ~30s`);
  } else {
    console.log('no suspended provider answered — config unchanged');
  }
  return promoted;
}

if (process.argv.includes('--watch')) {
  for (;;) {
    if (await syncOnce()) break;
    await new Promise((r) => setTimeout(r, 60_000));
  }
} else {
  await syncOnce();
}
