/**
 * D8 — Gate-A replay corpus collector (shadow, read-only).
 * Runs refresh+solve on the chosen chain each tick; every emitted
 * candidate is pinned to the CURRENT block and appended to
 * data/replay_corpus_<chain>.jsonl. A Gate-A replay needs >=12 rows
 * with distinct `block` values — this loop builds that corpus.
 * NO execution, NO submits — solver screen only.
 */
import { mkdirSync, appendFileSync } from 'fs';
import { chainConfig, cfg, ChainKey } from '../src/config/index.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { refreshPools } from '../src/feed/refresh.js';
import { registry } from '../src/pools/registry.js';
import { Discovery } from '../src/discovery/discovery.js';
import { breaker } from '../src/forensics/baitPool.js';
import { solve } from '../src/strategies/solver.js';
import { VARIANTS } from '../src/engine/predictiveEngine.js';
import { TOKEN_USD, nativeUsdFor } from '../src/config/pricing.js';
import { logger } from '../src/config/logger.js';

const sizeOf = (token: string, dec: number): bigint => {
  const px = TOKEN_USD[token.toLowerCase()] ?? 1;
  return (BigInt(Math.floor((cfg.FLASH_BORROW_USD / px) * 1e6)) * 10n ** BigInt(dec)) / 10n ** 6n;
};

const log = logger('corpus');
const CHAIN_KEY = (process.env.CORPUS_CHAIN ?? 'base') as ChainKey;
const TICK_MS = Number(process.env.CORPUS_TICK_MS ?? 90_000);
const OUT = `data/replay_corpus_${CHAIN_KEY}.jsonl`;
const MAX_CYCLES = Number(process.env.CORPUS_MAX_CYCLES ?? 40); // ~1h at 90s

const chain = chainConfig(CHAIN_KEY);
const rpc = new RpcPool(chain);
breaker.load(CHAIN_KEY);
const discovery = new Discovery(chain, rpc);
await discovery.boot();
mkdirSync('data', { recursive: true });

let cyc = 0;
for (; cyc < MAX_CYCLES; cyc++) {
  try {
    const head = await rpc.blockNumber();
    await discovery.scanNewPools().catch(() => {});
    await refreshPools(rpc, registry.all(CHAIN_KEY));
    // sweep a few guard profiles so thin near-misses are captured too
    const block = head;
    for (const v of VARIANTS.slice(0, 6)) {
      const cands = solve(chain, v, {
        gasUnits: 450_000n,
        baseFeeWei: 0n,
        tokenUsd: new Map(Object.entries(TOKEN_USD)),
        sizeOf, nativeUsd: nativeUsdFor(CHAIN_KEY),
      });
      for (const c of cands.slice(0, 5)) {
        appendFileSync(OUT, JSON.stringify({
          ts: Date.now(), block, chain: CHAIN_KEY,
          strategy: c.strategy, variant: v.id, lane: c.lane,
          path: c.legs.map((l) => l.pool.address.toLowerCase()).join('>'),
          borrowToken: c.borrowToken, borrowAmount: c.borrowAmount.toString(),
          simOut: c.simOut.toString(), grossUsd: c.grossUsd, gasUsd: c.gasUsd,
          premiumUsd: c.premiumUsd, netUsd: c.netUsd, spreadPct: c.spreadPct,
          minProfitToken: c.minProfitToken.toString(),
        }) + '\n');
      }
    }
    log.info(`cycle ${cyc} block ${block} pools=${registry.all(CHAIN_KEY).length}`);
  } catch (e) { log.warn('cycle err', e); }
  await new Promise((r) => setTimeout(r, TICK_MS));
}
log.info('corpus window closed');
