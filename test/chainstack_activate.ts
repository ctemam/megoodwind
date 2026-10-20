import 'dotenv/config';
import { PRIVATE_PROVIDERS, keyedEndpointsFor } from '../src/providers/providerCatalog.js';
import { KNOWN_CHAIN_ID, ChainKey } from '../src/config/index.js';

/**
 * Chainstack activation verifier — probes every slug the `mt_` token can
 * serve and reports live / not-attached per chain. Run AFTER attaching
 * Global Nodes in the console to confirm the lane came alive.
 *
 *   npx tsx test/chainstack_activate.ts
 */

const spec = PRIVATE_PROVIDERS.find((p) => p.id === 'chainstack')!;
const rows: string[] = [];
let live = 0;

for (const [chain, slug] of Object.entries(spec.slugs) as [ChainKey, string][]) {
  const url = `https://${slug}.core.chainstack.com/${process.env.CHAINSTACK_API_KEY}`;
  try {
    const t0 = performance.now();
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      signal: AbortSignal.timeout(12_000),
    });
    const ms = Math.round(performance.now() - t0);
    const j = (await r.json()) as { result?: string };
    const got = j.result ? parseInt(j.result, 16) : null;
    const want = KNOWN_CHAIN_ID[chain];
    const ok = got === want;
    if (ok) live++;
    const status = r.status === 401 ? '401-no-nodes' : `http-${r.status}`;
    rows.push(`| ${chain.padEnd(6)} | ${slug.padEnd(20)} | ${ok ? `LIVE chainId=${got} ${ms}ms` : status} |`);
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e).slice(0, 30);
    rows.push(`| ${chain.padEnd(6)} | ${slug.padEnd(20)} | transport:${msg} |`);
  }
}

console.log('| chain  | slug                 | status |');
console.log('|--------|----------------------|--------|');
rows.forEach((r) => console.log(r));
console.log(`\n${live}/${rows.length} chains live — ${live ? 'lane ACTIVE' : 'awaiting Global Node attach (console.chainstack.com)'}`);
