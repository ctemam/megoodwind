import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ChainKey } from '../config/index.js';
import { PoolState, registry } from '../pools/registry.js';
import { v2SpotPrice } from '../math/univ2.js';
import { v3SpotPrice } from '../math/univ3.js';
import { CREDIBILITY_CEILING_PCT } from '../math/profit.js';
import { addressReputation } from '../providers/blockscout.js';
import { pairsWithRecentTrades } from '../providers/bitquery.js';
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
  /** Blockscout explorer verdicts — 1 REST call per address, cached for the boot. */
  private repCache = new Map<string, { scam: boolean; at: number }>();
  /** Bitquery volume checks — one batched query covers a whole chunk; addr set dedupes. */
  private volChecked = new Set<string>();

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
    // 3-strikes: a pool whose EVERY probe reverts is a deterministic fake;
    // a single plan revert may be unrelated to this leg. The caller
    // additionally convicts peer-divergent legs immediately.
    if (reverted && s.probes >= 3 && s.reverts === s.probes) {
      this.convict(chain, pool, 'exec_probe_revert_errorpayload');
    }
  }

  /** Async explorer-reputation check — fire-and-forget from discovery.
   *  `is_scam` convicts immediately (explorer verdict = strong evidence);
   *  clean verdicts cache so screen() can read them at zero call cost. */
  checkReputation(chain: ChainKey, address: string) {
    const k = `${chain}:${address.toLowerCase()}`;
    if (this.repCache.has(k) || this.isConvicted(chain, address)) return;
    this.repCache.set(k, { scam: false, at: Date.now() }); // in-flight marker — dedupes repeat discoveries
    void addressReputation(chain, address).then((rep) => {
      if (!rep) { this.repCache.delete(k); return; } // transport fail — don't poison the cache
      this.repCache.set(k, { scam: rep.isScam, at: Date.now() });
      if (rep.isScam) this.convict(chain, address, 'explorer_scam_flag');
    });
  }

  /** Batched real-volume check (Bitquery) — ONE query per chunk of pools.
   *  Convicts `0 real trades in 72h AND >3x peer-divergent` — zero trades
   *  alone is legal for new pools, divergence alone is already screened;
   *  the combination is the bait signature. */
  checkRealVolumes(chain: ChainKey, addrs: string[]) {
    const fresh = addrs.filter((a) => {
      const k = `${chain}:${a.toLowerCase()}`;
      if (this.volChecked.has(k)) return false;
      this.volChecked.add(k);
      return true;
    });
    if (!fresh.length) return;
    void pairsWithRecentTrades(chain, fresh, 72).then((live) => {
      if (!live) return; // lane down — no inference allowed
      for (const addr of fresh) {
        if (live.has(addr.toLowerCase())) continue;
        const p = registry.get(`${chain}:${addr.toLowerCase()}`);
        if (p && peerDivergence(chain, p) > 3) {
          this.convict(chain, addr, 'zero_real_trades_divergent');
        }
      }
    });
  }

  /** Screen a pool before it enters a candidate path. */
  screen(chain: ChainKey, p: PoolState): { ok: boolean; reason?: string } {
    if (this.isConvicted(chain, p.address)) return { ok: false, reason: 'convicted' };
    if (this.repCache.get(`${chain}:${p.address.toLowerCase()}`)?.scam) {
      return { ok: false, reason: 'explorer_scam_flag' };
    }

    if (p.kind === 'v3' && p.feeBps && !V3_SANE_TIERS.has(p.feeBps * 100)) {
      return { ok: false, reason: 'fee_outside_sane_tiers' };
    }

    // peer divergence: >3x vs median of tracked same-pair pools.
    // Physically-impossible divergence (>=1000x) is corrupt state, not a
    // depeg — convict permanently instead of re-screening it every cycle.
    // Reasons are metric labels — the raw div value must NOT be embedded
    // (each distinct value mints a new counter key: unbounded cardinality
    // grows the counters map, the persisted JSON, and every /api/metrics
    // snapshot). Severity survives in bounded buckets.
    const div = peerDivergence(chain, p);
    if (div > 3) {
      if (div >= 1000) this.convict(chain, p.address, `corrupt_price_state_${div.toExponential(1)}x`);
      return { ok: false, reason: `peer_divergence_${divBucket(div)}` };
    }
    return { ok: true };
  }

  /** Credibility ceiling check on a simulated gap. */
  gapSuspicious(simulatedSpreadPct: number): boolean {
    return simulatedSpreadPct > CREDIBILITY_CEILING_PCT;
  }
}

/** Bounded severity buckets for the divergence metric label. */
const divBucket = (d: number): string =>
  d >= 1e6 ? 'ge1e6' : d >= 1e3 ? 'ge1e3' : d >= 1e2 ? 'ge1e2' : d >= 1e1 ? 'ge1e1' : 'ge3';

/** Divergence ratio vs median of tracked same-pair peers (1 = aligned). */
export function peerDivergence(chain: ChainKey, p: PoolState): number {
  const peers = registry.peers(chain, p.token0, p.token1).filter((x) => x.address !== p.address);
  if (peers.length < 3) return 1;
  const mine = poolPrice(p);
  const theirs = peers.map(poolPrice).filter((x) => x > 0).sort((a, b) => a - b);
  const median = theirs[Math.floor(theirs.length / 2)];
  if (mine <= 0 || median <= 0) return 1;
  return Math.max(mine / median, median / mine);
}

export function poolPrice(p: PoolState): number {
  if (p.kind === 'v2' && p.reserve0 && p.reserve1) {
    return v2SpotPrice({ reserveIn: p.reserve0, reserveOut: p.reserve1 }, p.dec0, p.dec1);
  }
  if (p.kind === 'v3' && p.sqrtPriceX96) {
    return v3SpotPrice(p.sqrtPriceX96, p.dec0, p.dec1);
  }
  // no on-chain state — never fall back to priceUsd: it is USD-per-token
  // while peers quote reserve RATIOS; mixing units produced e+23x
  // divergences and false convictions on pools that merely missed a refresh
  return 0;
}

export const breaker = new TokenCircuitBreaker();
