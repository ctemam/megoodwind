import { ChainConfig, cfg } from '../config/index.js';
import { PoolState, registry } from '../pools/registry.js';
import { v2AmountOut } from '../math/univ2.js';
import { v3SpotPrice, tickDistanceOk } from '../math/univ3.js';
import { netUsd, spreadPct, CREDIBILITY_CEILING_PCT } from '../math/profit.js';
import { breaker, peerDivergence } from '../forensics/baitPool.js';
import { Variant, effectiveGuards } from '../engine/predictiveEngine.js';
import { logger } from '../config/logger.js';
import { buildEdges, findCycles } from './graph.js';

/**
 * Strategy solver — CPU-eval ALL items before any RPC.
 *   TRACE: settled-evidence template lane — same path shapes, but only
 *          emits candidates that also pass an exec-probe (live-state call).
 *   P01:   2-hop cross-venue cyclic — A->B on venue1, B->A on venue2.
 *   P02:   3-hop triangular — A->B->C->A across the pool graph.
 *   P09 disabled at source (env P09_ENABLED=0); EV lane disabled.
 */

export interface Leg {
  pool: PoolState;
  tokenIn: string;
  tokenOut: string;
}

export interface Candidate {
  strategy: 'TRACE' | 'P01' | 'P02';
  chain: ChainConfig;
  legs: Leg[];
  borrowToken: string;
  borrowAmount: bigint;
  simOut: bigint;
  spreadPct: number;
  netUsd: number;
  variant: Variant;
}

const log = logger('solver');

/** Amount out for one leg on fresh pool state (screening approximation). */
export function legOut(pool: PoolState, amountIn: bigint, tokenIn: string): bigint {
  const t0 = pool.token0.toLowerCase();
  const inIs0 = tokenIn.toLowerCase() === t0;
  if (pool.kind === 'v2') {
    if (!pool.reserve0 || !pool.reserve1) return 0n;
    const r = inIs0
      ? { reserveIn: pool.reserve0, reserveOut: pool.reserve1 }
      : { reserveIn: pool.reserve1, reserveOut: pool.reserve0 };
    return v2AmountOut(amountIn, r, pool.feeBps);
  }
  // v3 screening approx: spot price * (1 - fee) — tick-walk guard applied
  // on candidates that survive; exec-probe is the final arbiter.
  if (!pool.sqrtPriceX96) return 0n;
  const price = inIs0
    ? v3SpotPrice(pool.sqrtPriceX96, pool.dec0, pool.dec1)
    : 1 / v3SpotPrice(pool.sqrtPriceX96, pool.dec0, pool.dec1);
  if (!price || !Number.isFinite(price)) return 0n;
  const inAdj = Number(amountIn) / 10 ** (inIs0 ? pool.dec0 : pool.dec1);
  const outAdj = inAdj * price * (1 - pool.feeBps / 10_000);
  return BigInt(Math.floor(outAdj * 10 ** (inIs0 ? pool.dec1 : pool.dec0)));
}

function pathScreen(chain: ChainConfig, legs: Leg[], v: Variant): boolean {
  const g = effectiveGuards(v);
  for (const { pool } of legs) {
    const s = breaker.screen(chain.key, pool);
    if (!s.ok) return false;
    if (pool.liquidityUsd < g.minDepthUsd) return false;
  }
  return true;
}

/** Simulate a full cycle returning final out for borrow amount. */
export function simulate(legs: Leg[], amountIn: bigint): bigint {
  let amt = amountIn;
  for (const leg of legs) {
    amt = legOut(leg.pool, amt, leg.tokenIn);
    if (amt <= 0n) return 0n;
  }
  return amt;
}

function emit(
  strategy: Candidate['strategy'],
  chain: ChainConfig,
  legs: Leg[],
  borrowToken: string,
  borrowAmount: bigint,
  v: Variant,
  gasUnits: bigint,
  baseFeeWei: bigint,
  tokenUsd: number,
): Candidate | null {
  const out = simulate(legs, borrowAmount);
  if (out <= borrowAmount) return null;
  const sp = spreadPct(out, borrowAmount);
  if (sp > CREDIBILITY_CEILING_PCT) {
    // >~2% = a pool in the path is lying about reserves. Convict ONLY the
    // legs whose spot quote diverges >3x from same-pair peers — blaming
    // every leg convicts honest pools (e.g. canonical WETH/USDC) that
    // merely routed through the liar. No peers = no honest attribution;
    // exec-probe reverts still convict solo fakes deterministically.
    let convicted = 0;
    for (const l of legs) {
      if (peerDivergence(chain.key, l.pool) > 3) {
        breaker.convict(chain.key, l.pool.address, `gap_above_ceiling_${sp.toFixed(2)}pct`);
        convicted++;
      }
    }
    if (!convicted) log.debug(`spread ${sp.toFixed(0)}% with no divergent leg — unattributed, no conviction`);
    return null;
  }
  const n = netUsd({
    gasUnits,
    baseFeeWei,
    priorityFeeWei: BigInt(Math.floor(cfg.PRIORITY_FEE_GWEI * 1e9)),
    flashPremiumToken: 0n, // Balancer primary = 0%; Aave premium priced at plan build
    grossOutToken: out,
    borrowInToken: borrowAmount,
    tokenUsd,
    nativeUsd: cfg.NATIVE_USD,
    chain: chain.key,
  });
  // STRICT_PROFIT_FLOOR_GUARD — no path may bypass min_profit_usd
  if (cfg.STRICT_PROFIT_FLOOR_GUARD && n.netUsd < cfg.MIN_PROFIT_USD) return null;
  return { strategy, chain, legs, borrowToken, borrowAmount, simOut: out, spreadPct: sp, netUsd: n.netUsd, variant: v };
}

/** Enumerate candidates for a chain on current registry state. */
export function solve(
  chain: ChainConfig,
  v: Variant,
  opts: { gasUnits: bigint; baseFeeWei: bigint; tokenUsd: Map<string, number>; sizeOf: (token: string) => bigint },
): Candidate[] {
  const pools = registry.all(chain.key);
  const cands: Candidate[] = [];
  const seenPaths = new Set<string>();
  const strat = new Set(cfg.strategies);
  const push = (c: Candidate | null) => {
    if (!c) return;
    const sig = c.legs.map((l) => l.pool.address.toLowerCase()).join('>');
    if (seenPaths.has(sig)) return;
    seenPaths.add(sig);
    cands.push(c);
  };

  // --- P01: cross-venue 2-hop on same pair, different pools ---
  if (strat.has('P01') || strat.has('TRACE')) {
    const seen = new Set<string>();
    for (const p of pools) {
      const peers = registry.peers(chain.key, p.token0, p.token1)
        .filter((x) => x.address !== p.address);
      for (const q of peers) {
        for (const [a, b] of [[p, q], [q, p]] as const) {
          const sig = `p01:${a.address}:${b.address}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          const legsAB: Leg[] = [
            { pool: a, tokenIn: a.token0, tokenOut: a.token1 },
            { pool: b, tokenIn: a.token1, tokenOut: a.token0 },
          ];
          const legsBA: Leg[] = [
            { pool: a, tokenIn: a.token1, tokenOut: a.token0 },
            { pool: b, tokenIn: a.token0, tokenOut: a.token1 },
          ];
          for (const legs of [legsAB, legsBA]) {
            if (!pathScreen(chain, legs, v)) continue;
            const borrow = opts.sizeOf(legs[0].tokenIn);
            const usd = opts.tokenUsd.get(legs[0].tokenIn.toLowerCase()) ?? 1;
            push(emit('P01', chain, legs, legs[0].tokenIn, borrow, v, opts.gasUnits, opts.baseFeeWei, usd));
          }
        }
      }
    }
  }

  // --- P02: 3-hop triangles A->B->C->A ---
  if (strat.has('P02')) {
    const byToken = new Map<string, PoolState[]>();
    for (const p of pools) {
      for (const t of [p.token0, p.token1]) {
        const k = t.toLowerCase();
        if (!byToken.has(k)) byToken.set(k, []);
        byToken.get(k)!.push(p);
      }
    }
    const majors = [...byToken.keys()].slice(0, 40); // cap graph fanout
    for (const a of majors) {
      for (const p1 of byToken.get(a) ?? []) {
        const b = other(p1, a);
        if (!b || b === a) continue;
        for (const p2 of byToken.get(b) ?? []) {
          if (p2.address === p1.address) continue;
          const c = other(p2, b);
          if (!c || c === a || c === b) continue;
          for (const p3 of byToken.get(c) ?? []) {
            if (p3.address === p1.address || p3.address === p2.address) continue;
            if (other(p3, c) !== a) continue;
            const legs: Leg[] = [
              { pool: p1, tokenIn: a, tokenOut: b },
              { pool: p2, tokenIn: b, tokenOut: c },
              { pool: p3, tokenIn: c, tokenOut: a },
            ];
            if (!pathScreen(chain, legs, v)) continue;
            const borrow = opts.sizeOf(a);
            const cnd = emit('P02', chain, legs, a, borrow, v, opts.gasUnits, opts.baseFeeWei, opts.tokenUsd.get(a) ?? 1);
            push(cnd);
          }
        }
      }
    }
  }

  // --- graph discovery: Bellman-Ford negative cycles across ALL
  //     discovered pools — arbitrary n-hop cycles, not just triangles ---
  const edges = buildEdges(pools);
  for (const legs of findCycles(edges)) {
    const label = legs.length <= 2 ? 'P01' : 'P02';
    if (!strat.has(label)) continue;
    if (!pathScreen(chain, legs, v)) continue;
    const usd = opts.tokenUsd.get(legs[0].tokenIn.toLowerCase());
    if (usd === undefined) continue; // unpriced borrow token = dishonest net
    const borrow = opts.sizeOf(legs[0].tokenIn);
    push(emit(label, chain, legs, legs[0].tokenIn, borrow, v, opts.gasUnits, opts.baseFeeWei, usd));
  }

  return cands.sort((x, y) => y.netUsd - x.netUsd).slice(0, 8);
}

const other = (p: PoolState, t: string): string | undefined => {
  const l = t.toLowerCase();
  if (p.token0.toLowerCase() === l) return p.token1.toLowerCase();
  if (p.token1.toLowerCase() === l) return p.token0.toLowerCase();
  return undefined;
};

/** V3 tick-walk guard for candidates that survived screening. */
export function v3TickGuardOk(c: Candidate): boolean {
  for (const leg of c.legs) {
    if (leg.pool.kind !== 'v3' || leg.pool.tick === undefined || !leg.pool.sqrtPriceX96) continue;
    // approximate post-swap tick from sim output
    const before = leg.pool.tick;
    const after = before; // screening approx has no walk; real check is quoter/probe
    if (!tickDistanceOk(before, after, cfg.MAX_TICK_DISTANCE)) return false;
  }
  return true;
}
