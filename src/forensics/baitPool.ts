import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ChainKey } from '../config/index.js';
import { PoolState, registry } from '../pools/registry.js';
import { v2SpotPrice } from '../math/univ2.js';
import { v3SpotPrice } from '../math/univ3.js';
import { CREDIBILITY_CEILING_PCT } from '../math/profit.js';
import { logger } from '../config/logger.js';

/**
 * Bait-pool forensics (Nomiswap family signature).
 * Bait pools fake getReserves()/slot0() so quotes look profitable in sim;
 * the real swap reverts on-chain. Convictions stick at POOL level so a
 * suppressed path can't leave the pool free to poison other paths.
 *
 * Conviction triggers:
 *  a) simulated gap above credibility ceiling (~2%)
 *  b) exec-probe revert on live state (ErrorPayload, deterministic)
 *  c) >3x price divergence vs median of tracked same-pair peers
 *  d) fee outside sane tiers (V3 not in {1,5,30,100} bps-units → 100..=10000)
 */

const log = logger('baitPool');
const DATA_DIR = join(process.cwd(), 'data', 'leaders');
const V3_SANE_TIERS = new Set([100, 500, 3000, 10000]);

export interface Conviction {
  pool: string;
  chain: ChainKey;
  reason: string;
  at: number;
}

export class TokenCircuitBreaker {
  /** poolStats[chain][poolAddr] -> fail counts; convicted pools persisted. */
  poolStats = new Map<string, { probes: number; reverts: number; lastFail: number }>();
  private convicted = new Map<string, Conviction>(); // chain:addr -> conviction

  fileFor(chain: ChainKey): string {
    return join(DATA_DIR, chain, '_bait_pools.json');
  }

  load(chain: ChainKey) {
    const f = this.fileFor(chain);
    if (!existsSync(f)) return;
    try {
      const arr = JSON.parse(readFileSync(f, 'utf8')) as Conviction[];
      for (const c of arr) this.convicted.set(`${c.chain}:${c.pool.toLowerCase()}`, c);
      log.info(`${chain}: loaded ${arr.length} pool convictions`);
    } catch (e) {
      log.warn(`corrupt bait-pool file ${f}`, e);
    }
  }

  private persist(chain: ChainKey) {
    const f = this.fileFor(chain);
    mkdirSync(dirname(f), { recursive: true });
    const arr = [...this.convicted.values()].filter((c) => c.chain === chain);
    writeFileSync(f, JSON.stringify(arr, null, 2));
  }

  isConvicted(chain: ChainKey, pool: string): boolean {
    return this.convicted.has(`${chain}:${pool.toLowerCase()}`);
  }

  convictions(chain?: ChainKey): Conviction[] {
    return [...this.convicted.values()].filter((c) => !chain || c.chain === chain);
  }

  convict(chain: ChainKey, pool: string, reason: string) {
    const key = `${chain}:${pool.toLowerCase()}`;
    if (this.convicted.has(key)) return;
    this.convicted.set(key, { pool, chain, reason, at: Date.now() });
    registry.remove(key);
    this.persist(chain);
    log.warn(`CONVICTED ${chain}:${pool} — ${reason}`);
  }

  recordProbe(chain: ChainKey, pool: string, reverted: boolean) {
    const k = `${chain}:${pool.toLowerCase()}`;
    const s = this.poolStats.get(k) ?? { probes: 0, reverts: 0, lastFail: 0 };
    s.probes++;
    if (reverted) { s.reverts++; s.lastFail = Date.now(); }
    this.poolStats.set(k, s);
    if (reverted) this.convict(chain, pool, 'exec_probe_revert_errorpayload');
  }

  /** Screen a pool before it enters a candidate path. */
  screen(chain: ChainKey, p: PoolState): { ok: boolean; reason?: string } {
    if (this.isConvicted(chain, p.address)) return { ok: false, reason: 'convicted' };

    if (p.kind === 'v3' && p.feeBps && !V3_SANE_TIERS.has(p.feeBps * 100)) {
      return { ok: false, reason: `fee_outside_sane_tiers:${p.feeBps}` };
    }

    // peer divergence: >3x vs median of tracked same-pair pools
    const peers = registry.peers(chain, p.token0, p.token1).filter((x) => x.address !== p.address);
    if (peers.length >= 3) {
      const mine = poolPrice(p);
      const theirs = peers.map(poolPrice).filter((x) => x > 0).sort((a, b) => a - b);
      const median = theirs[Math.floor(theirs.length / 2)];
      if (mine > 0 && median > 0) {
        const div = Math.max(mine / median, median / mine);
        if (div > 3) return { ok: false, reason: `peer_divergence_${div.toFixed(1)}x` };
      }
    }
    return { ok: true };
  }

  /** Credibility ceiling check on a simulated gap. */
  gapSuspicious(simulatedSpreadPct: number): boolean {
    return simulatedSpreadPct > CREDIBILITY_CEILING_PCT;
  }
}

export function poolPrice(p: PoolState): number {
  if (p.kind === 'v2' && p.reserve0 && p.reserve1) {
    return v2SpotPrice({ reserveIn: p.reserve0, reserveOut: p.reserve1 }, p.dec0, p.dec1);
  }
  if (p.kind === 'v3' && p.sqrtPriceX96) {
    return v3SpotPrice(p.sqrtPriceX96, p.dec0, p.dec1);
  }
  return p.priceUsd ?? 0;
}

export const breaker = new TokenCircuitBreaker();
