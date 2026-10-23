/** WO-8 step 4 — live factory guard: every registered factory must have
 *  non-empty bytecode on its chain. Fails loudly on a dead entry (the
 *  class of bug that silently emptied base/arb discovery). Requires keyed
 *  RPCs; run: npx tsx test/factory_guard_test.ts */
import { FACTORIES } from '../src/discovery/factories.js';
import { chainConfig } from '../src/config/index.js';
import { poolFor } from '../src/providers/rpcPool.js';
import { test } from 'node:test';
import assert from 'node:assert';

const keyed = Object.keys(FACTORIES).filter((k) => {
  try { return chainConfig(k).rpcUrls.length > 0; } catch { return false; }
});

for (const ck of keyed) {
  for (const f of FACTORIES[ck]) {
    test(`${ck}/${f.name} has deployed code`, async () => {
      const rpc = poolFor(chainConfig(ck));
      const code = await rpc.call<string>('eth_getCode', [f.address, 'latest']);
      const bytes = Math.max(0, code.length - 2) / 2;
      assert.ok(bytes > 0, `${ck}/${f.name} ${f.address} has NO code (${bytes}B)`);
    });
  }
}
