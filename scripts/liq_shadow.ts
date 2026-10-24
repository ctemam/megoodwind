/**
 * D5 — liquidation shadow lane. Runs LiquidationIndexer (+MorphoIndexer)
 * against live RPC every ~10 min, records HF-band positions + timing to
 * data/liq_shadow_<chain>.jsonl. NO transactions, NO arming — read-only.
 * Row fields: ts, chain, protocol, user, hf, debtBase, liquidatable,
 * detectedBlock — enough to measure time-to-liquidatable + later score
 * competing-liquidator closure rate (a re-check finds the position gone).
 */
import { ethers } from 'ethers';
import { appendFileSync, mkdirSync } from 'fs';
import { LiquidationIndexer, HF_LIQUIDATABLE, MorphoIndexer } from '../src/liquidation/lane.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { chainConfig, ChainKey } from '../src/config/index.js';
import { logger } from '../src/config/logger.js';

const log = logger('liqShadow');
const TICK_MS = Number(process.env.LIQ_TICK_MS ?? 10 * 60_000);
const chains = (process.env.LIQ_SHADOW_CHAINS ?? 'eth,base').split(',') as ChainKey[];

const idx: { key: ChainKey; aave: LiquidationIndexer; morpho: MorphoIndexer; rpc: RpcPool; lastSync: number }[] = [];
for (const key of chains) {
  const chain = chainConfig(key);
  const rpc = new RpcPool(chain);
  idx.push({ key, aave: new LiquidationIndexer({ chain, rpc }), morpho: new MorphoIndexer(chain, rpc), rpc, lastSync: 0 });
  log.info(`${key}: liq shadow armed (read-only)`);
}
mkdirSync('data', { recursive: true });
const row = (key: string, r: object) =>
  appendFileSync(`data/liq_shadow_${key}.jsonl`, JSON.stringify({ ts: Date.now(), chain: key, ...r }) + '\n');

const H1 = 3600_000;
for (;;) {
  for (const e of idx) {
    try {
      const head = await e.rpc.blockNumber();
      if (Date.now() - e.lastSync > H1) {
        const added = await e.aave.syncBorrowers(Math.max(0, head - 30_000), head).catch(() => 0);
        e.lastSync = Date.now();
        row(e.key, { kind: 'sync', borrowers: e.aave.borrowers.size, added, head });
      }
      // Aave band — HF < 1.5 watchlist
      const band = await e.aave.watchBand(0.5).catch(() => []);
      for (const p of band) {
        row(e.key, {
          kind: 'aave_position', user: p.user, hf: (Number(p.hf) / 1e18).toFixed(4),
          debtBase: p.totalDebtBase.toString(), liquidatable: p.hf < HF_LIQUIDATABLE, head,
        });
      }
      // Morpho liquidatable set
      if (e.morpho.enabled()) {
        const l = await e.morpho.liquidatable().catch(() => []);
        for (const p of l) row(e.key, { kind: 'morpho_liquidatable', id: p.id.slice(0, 18), user: p.user, borrowed: p.borrowed.toString(), head });
      }
      log.info(`${e.key} tick: ${band.length} aave band (${band.filter((b) => b.hf < HF_LIQUIDATABLE).length} liq), borrowers=${e.aave.borrowers.size}`);
    } catch (err) { log.warn(`${e.key} tick err`, err); }
  }
  await new Promise((r) => setTimeout(r, TICK_MS));
}
