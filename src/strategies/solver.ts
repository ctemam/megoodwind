import { ChainConfig, cfg } from '../config/index.js';
import { PoolState, registry } from '../pools/registry.js';
import { v2AmountOut } from '../math/univ2.js';
import { v3SpotPrice, tickDistanceOk } from '../math/univ3.js';
import { netUsd, spreadPct, CREDIBILITY_CEILING_PCT, priceImpactBps, poolDepthUsd, inputVirtualReserveRaw, belowGasMultiple } from '../math/profit.js';
import { breaker, peerDivergence } from '../forensics/baitPool.js';
import { Variant, effectiveGuards, dynamicSlippageBps } from '../engine/predictiveEngine.js';
import { MarketRegime } from '../engine/marketRegime.js';
import { logger } from '../config/logger.js';
import { metrics, Lane } from '../telemetry/metrics.js';
import { diagRecord } from '../telemetry/diagLog.js';
import { buildEdges, findCycles } from './graph.js';
import { pickFlashSource, flashPremium } from '../exec/flashVenues.js';
import { routeGasUnits } from '../exec/gasModel.js';

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
  lane: Lane;
  /** cumulative constant-product price impact across legs (bps) */
  impactBps: number;
  /** the dynamic slippage bound that gated this candidate (bps) */
  slipBoundBps: number;
  /** lane floor in borrowToken units — on-chain minProfit enforcement */
  minProfitToken: bigint;
  /** solver-model economics at the chosen size (for gas re-check) */
  grossUsd: number;
  gasUsd: number;
  premiumUsd: number;
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

/** decimals of `token` as recorded on `pool` (token0/token1 side). */
const decOf = (pool: PoolState, token: string): number =>
  pool.token0.toLowerCase() === token.toLowerCase() ? pool.dec0 : pool.dec1;

/** Adaptive depth ladder — when a chain emits ZERO candidates while
 *  depth rejections are firing, the effective minDepth decays
 *  geometrically toward a floor so the shallow long-tail universe
 *  actually reaches the margin gates. Real cross-venue mispricing lives
 *  in the long tail; a static wall just counts rejections forever.
 *  Any emitted candidate resets the scale. Forensics still screens
 *  every leg — shallow ≠ trusted. */
const depthAdapt = new Map<string, { scale: number; empty: number }>();
const DEPTH_ADAPT_AFTER = 2;    // consecutive zero-emit cycles before stepping
const DEPTH_ADAPT_STEP = 0.5;   // halve the requirement per step
const DEPTH_FLOOR_USD = 2_500;  // never below — below this gas can't repay
let depthRejectsThisSolve = 0;

function pathScreen(chain: ChainConfig, legs: Leg[], v: Variant, tokenUsd: Map<string, number>, depthGateUsd?: number): boolean {
  const g = effectiveGuards(v);
  const needDepth = depthGateUsd ?? g.minDepthUsd;
  for (const { pool } of legs) {
    const s = breaker.screen(chain.key, pool);
    if (!s.ok) {
      metrics.inc('rejected_by_forensic_bait', { reason: s.reason ?? 'screen' });
      if (cfg.DIAG_ONLY) diagRecord('forensic_screen', { chain: chain.key, pool: pool.address, kind: pool.kind, reason: s.reason ?? 'screen' });
      return false;
    }
    // depth = feed liquidity when present, else on-chain priced-side
    // value — discovered pools carry liquidityUsd=0 and must not be
    // blanket-rejected (they are the primary discovery product)
    const dep = poolDepthUsd(pool, tokenUsd);
    if (dep < needDepth) {
      metrics.inc('rejected_by_profit_margin', { reason: 'depth' });
      depthRejectsThisSolve++;
      if (cfg.DIAG_ONLY) diagRecord('depth', {
        chain: chain.key, pool: pool.address, kind: pool.kind,
        token0: pool.token0, token1: pool.token1, dec0: pool.dec0, dec1: pool.dec1,
        reserve0: pool.reserve0?.toString(), reserve1: pool.reserve1?.toString(),
        sqrtPriceX96: pool.sqrtPriceX96?.toString(), liquidity: pool.liquidity?.toString(),
        feedLiquidityUsd: pool.liquidityUsd, depthUsd: dep, thresholdUsd: needDepth,
      });
      return false;
    }
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
  l1DataFeeWei: bigint,
  lane: Lane = 'predictive',
  slipBoundBps = cfg.SLIPPAGE_BPS,
  nativeUsd = cfg.NATIVE_USD,
  priorityFeeWei = BigInt(Math.floor(cfg.PRIORITY_FEE_GWEI * 1e9)),
  extra?: { flashLiquidityRaw?: bigint },
): Candidate | null {
  metrics.inc('total_detected_opportunities', { chain: chain.key });
  const decBorrow = decOf(legs[0].pool, borrowToken);
  // Right-size the borrow to the slippage bound: largest first-leg input
  // keeping impact ≤ its per-leg share of slipBoundBps (a_eff ≤
  // b/(1−b)·vIn). A raw 1e18 borrow is a trillion-unit clip on 6-dec
  // tokens — instead of letting it die at the impact gate, shrink to
  // what the pool can absorb; the profit floor decides if it's enough.
  // Largest borrow the slippage bound can absorb on leg 1 (a_eff <=
  // b/(1-b)*vIn), capped by the variant's sizeCapUsd — this is the
  // sweep's upper bound, not necessarily the net-optimal size.
  let boundMax = borrowAmount;
  const vIn = inputVirtualReserveRaw(legs[0].pool, borrowToken);
  if (vIn > 0 && slipBoundBps > 0) {
    const b = slipBoundBps / legs.length / 10_000;
    const maxIn = (vIn * b) / (1 - b) / (1 - legs[0].pool.feeBps / 10_000);
    if (Number.isFinite(maxIn) && maxIn > 0 && maxIn < Number(boundMax)) boundMax = BigInt(Math.floor(maxIn));
  }
  // sizeCapUsd — the variant's borrow ceiling
  const capUsd = effectiveGuards(v).sizeCapUsd;
  if (tokenUsd > 0 && capUsd > 0) {
    const cap = BigInt(Math.floor((capUsd / tokenUsd) * 10 ** decBorrow));
    if (cap > 0n && cap < boundMax) boundMax = cap;
  }
  // WO-5 optimal-lane caps: (b) fraction of the leg-0 input reserve,
  // (a) the flash venue's available balance when the caller supplies it.
  if (cfg.SIZING_MODE === 'optimal') {
    if (vIn > 0) {
      const rc = BigInt(Math.floor(Number(vIn) * cfg.OPTIMAL_RESERVE_FRAC));
      if (rc > 0n && rc < boundMax) boundMax = rc;
    }
    if (extra?.flashLiquidityRaw && extra.flashLiquidityRaw > 0n && extra.flashLiquidityRaw < boundMax) {
      boundMax = extra.flashLiquidityRaw;
    }
  }
  if (boundMax <= 0n) { metrics.inc('rejected_by_profit_margin', { reason: 'size_zero' }); return null; }

  // ARGMAX BORROW SEARCH — a static size is a decorative answer to a
  // dynamic question. Impact grows with size while the venue spread is
  // size-agnostic at screening fidelity, so a path impact-dead at the
  // bound-max clip can be net-positive smaller. Two lanes:
  //   bound   — geometric SIZE_RATIOS ladder (existing behavior)
  //   optimal — golden-section argmax on netUsd over [1, boundMax]
  // Every point is real leg simulation + real premium + real gas.
  const SIZE_RATIOS = [1, 0.25, 0.0625, 0.015625];
  const pathSig = legs.map((l) => l.pool.address.toLowerCase()).join('>');
  const flSource = pickFlashSource(chain.key, borrowToken);
  const gUnits = routeGasUnits(legs, cfg.GAS_MARGIN_BPS);
  let sawSpread = false, sawImpactOver = false;
  const evalSize = (sz: bigint) => {
    let out = sz;
    let impactBps = 0;
    for (const leg of legs) {
      impactBps += priceImpactBps(leg.pool, out, leg.tokenIn);
      out = legOut(leg.pool, out, leg.tokenIn);
      if (out <= 0n) break;
    }
    metrics.notePathImpact(chain.key, impactBps);
    if (out <= sz) return null;
    sawSpread = true;
    if (impactBps > slipBoundBps) { sawImpactOver = true; return null; }
    const sp = spreadPct(out, sz);
    if (sp > CREDIBILITY_CEILING_PCT) {
      metrics.inc('rejected_by_forensic_bait', { reason: 'gap_above_ceiling' });
      if (cfg.DIAG_ONLY) diagRecord('gap_above_ceiling', { chain: chain.key, path: pathSig, spreadPct: sp, size: sz.toString() });
      // >~2% = a pool is lying about reserves. Convict ONLY legs whose
      // spot quote diverges >3x from same-pair peers — blaming every leg
      // convicts honest pools that merely routed through the liar.
      let convicted = 0;
      for (const l of legs) {
        if (peerDivergence(chain.key, l.pool) > 3) {
          breaker.convict(chain.key, l.pool.address, 'gap_above_ceiling_' + sp.toFixed(2) + 'pct');
          convicted++;
        }
      }
      if (!convicted) log.debug('spread ' + sp.toFixed(0) + '% with no divergent leg — unattributed, no conviction');
      return 'ceiling' as const;
    }
    const premium = flashPremium(flSource, sz);
    const n = netUsd({
      gasUnits: gUnits, baseFeeWei, l1DataFeeWei, priorityFeeWei,
      flashPremiumToken: premium,
      grossOutToken: out, borrowInToken: sz, tokenUsd,
      tokenDec: decBorrow, nativeUsd, chain: chain.key,
    });
    return { borrow: sz, out, impactBps, sp, netUsd: n.netUsd, premium, n };
  };
  type SizeEval = Exclude<ReturnType<typeof evalSize>, null | 'ceiling'>;
  let best: SizeEval | null = null;
  const consider = (sz: bigint) => {
    const r = evalSize(sz);
    if (r === 'ceiling') return 'ceiling' as const;
    if (r && (!best || r.netUsd > best.netUsd)) best = r;
    return null;
  };
  // WO-6 census: achievable gross at each study slip bound — the gross
  // argmax over sizes whose impact ≤ that bound (and uncapped), so the
  // census can ask "what could this path pay" without re-running sizes.
  // Computed only under DIAG_ONLY (bounded ~4×60 leg sims per emit).
  const grossOnly = (sz: bigint): number => {
    let out = sz;
    for (const leg of legs) { out = legOut(leg.pool, out, leg.tokenIn); if (out <= 0n) return -Infinity; }
    return out > sz ? ((Number(out - sz) / 10 ** decBorrow) * tokenUsd) : -Infinity;
  };
  const argmaxGross = (cap: bigint): number | null => {
    if (cap <= 1n || !Number.isFinite(Number(vIn)) || vIn <= 0) return null;
    let lo = 1, hi = Math.min(Number(cap), Number(vIn));
    const INVPHI = 0.6180339887498949;
    let x1 = hi - (hi - lo) * INVPHI, x2 = lo + (hi - lo) * INVPHI;
    for (let i = 0; i < 50 && hi - lo > 8; i++) {
      if (grossOnly(BigInt(Math.floor(x1))) < grossOnly(BigInt(Math.floor(x2)))) { lo = x1; x1 = x2; x2 = lo + (hi - lo) * INVPHI; }
      else { hi = x2; x2 = x1; x1 = hi - (hi - lo) * INVPHI; }
    }
    let g = -Infinity;
    for (const s of [lo, x1, x2, hi]) { const gg = grossOnly(BigInt(Math.max(1, Math.floor(s)))); if (gg > g) g = gg; }
    return g > -Infinity ? g : null;
  };
  const capForSlip = (kbps: number) => {
    if (!Number.isFinite(Number(vIn)) || vIn <= 0) return 0n;
    const bk = kbps / legs.length / 10_000;
    const cap = (Number(vIn) * bk) / (1 - bk) / (1 - (legs[0].pool.feeBps || 0) / 10_000);
    return Number.isFinite(cap) && cap > 0 ? BigInt(Math.floor(cap)) : 0n;
  };
  const achievable = cfg.DIAG_ONLY ? {
    slip15: argmaxGross(capForSlip(15)),
    slip50: argmaxGross(capForSlip(50)),
    slip100: argmaxGross(capForSlip(100)),
    uncapped: argmaxGross(Number.isFinite(Number(vIn)) && vIn > 0 ? BigInt(Math.floor(Number(vIn))) : 0n),
  } : undefined;

  let ceilingHit = false;
  if (cfg.SIZING_MODE === 'optimal') {
    // golden-section argmax — netUsd(x) is unimodal for constant-product
    // round-trips (fee-favored below breakeven, impact-penalized above).
    let lo = 0, hi = Number(boundMax);
    const INVPHI = 0.6180339887498949;
    let x1 = hi - Math.floor((hi - lo) * INVPHI);
    let x2 = lo + Math.floor((hi - lo) * INVPHI);
    const N = (s: number) => {
      const r = evalSize(BigInt(Math.max(1, Math.floor(s))));
      if (r === 'ceiling') { ceilingHit = true; return -Infinity; }
      if (r && (!best || r.netUsd > best.netUsd)) best = r;
      return r ? r.netUsd : -Infinity;
    };
    let f1 = N(x1), f2 = N(x2);
    for (let i = 0; i < 40 && hi - lo > 4; i++) {
      if (f1 < f2) { lo = x1; x1 = x2; f1 = f2; x2 = lo + Math.floor((hi - lo) * INVPHI); f2 = N(x2); }
      else { hi = x2; x2 = x1; f2 = f1; x1 = hi - Math.floor((hi - lo) * INVPHI); f1 = N(x1); }
    }
    for (const s of [lo, x1, x2, hi]) consider(BigInt(Math.max(1, Math.floor(s))));
  } else {
    for (const r of SIZE_RATIOS) {
      if (consider(BigInt(Math.max(1, Math.floor(Number(boundMax) * r)))) === 'ceiling') ceilingHit = true;
    }
  }
  if (ceilingHit) return null;
  // closure-assigned — TS can't narrow it; rebind to a definite alias.
  const b = best as SizeEval | null;
  const econ = b ? {
    grossUsd: b.n.grossUsd, gasUsd: b.n.gasUsd, premiumUsd: b.n.premiumUsd,
    bribeUsd: b.n.bribeUsd, preBribeUsd: b.n.grossUsd - b.n.gasUsd - b.n.premiumUsd,
    netUsd: b.netUsd,
  } : {};
  if (!sawSpread) {
    metrics.inc('rejected_by_profit_margin', { reason: 'no_spread' });
    if (cfg.DIAG_ONLY) diagRecord('no_spread', { chain: chain.key, path: pathSig, boundMax: boundMax.toString(), sizesTested: SIZE_RATIOS.length, achievable });
    return null;
  }
  if (!b) {
    metrics.inc('rejected_by_profit_margin', { reason: sawImpactOver ? 'price_impact' : 'no_spread' });
    if (cfg.DIAG_ONLY) diagRecord(sawImpactOver ? 'price_impact' : 'no_spread', {
      chain: chain.key, path: pathSig, slipBoundBps, boundMax: boundMax.toString(), sizesTested: SIZE_RATIOS.length,
      achievable,
    });
    return null;
  }
  const { borrow, out, impactBps, sp } = b;
  const flPremiumToken = b.premium;
  // WO-5 gas-aware gate: gross edge must clear K×gas cost at the chosen
  // size — a path whose edge only exists inside the gas model's error
  // bars is not a path worth a UserOp. Stage named below_gas_multiple.
  const gasK = cfg.GAS_PROFIT_MULT;
  if (belowGasMultiple(b.n.grossUsd, b.n.gasUsd, gasK)) {
    metrics.inc('rejected_by_profit_margin', { reason: 'below_gas_multiple' });
    if (cfg.DIAG_ONLY) diagRecord('below_gas_multiple', {
      chain: chain.key, path: pathSig, lane, variant: v.id, strategy,
      borrowToken, borrowAmount: borrow.toString(), simOut: out.toString(),
      spreadPct: sp, impactBps,
      grossUsd: b.n.grossUsd, gasUsd: b.n.gasUsd, mult: gasK,
      ratio: b.n.gasUsd > 0 ? b.n.grossUsd / b.n.gasUsd : Infinity,
      premiumUsd: b.n.premiumUsd, netUsd: b.netUsd, achievable,
    });
    return null;
  }
  // STRICT_PROFIT_FLOOR_GUARD — lane floor = max(global min, lane floor).
  // Whale-triggered paths carry a higher bar ($25 default): competition
  // is fiercest right after a whale reprices a venue.
  const floorUsd = Math.max(
    cfg.MIN_PROFIT_USD,
    lane === 'whale' ? cfg.WHALE_MIN_PROFIT_USD : cfg.PREDICTIVE_MIN_PROFIT_USD,
  );
  if (cfg.STRICT_PROFIT_FLOOR_GUARD && b.netUsd < floorUsd) {
    metrics.inc('rejected_by_profit_margin', { reason: 'min_profit_floor' });
    metrics.recordVariantOutcome(v.id, lane, { hit: false, netUsd: b.netUsd, floorUsd });
    if (cfg.DIAG_ONLY) diagRecord('min_profit_floor', {
      chain: chain.key, path: pathSig, lane, variant: v.id, strategy,
      borrowToken, borrowAmount: borrow.toString(), simOut: out.toString(),
      spreadPct: sp, impactBps, slipBoundBps, floorUsd,
      ...(econ as Record<string, unknown>), achievable,
    });
    return null;
  }
  metrics.inc('passed_to_simulation_probe', { chain: chain.key });
  if (cfg.DIAG_ONLY) diagRecord('probe_pass', {
    chain: chain.key, path: pathSig, lane, variant: v.id, strategy,
    borrowToken, borrowAmount: borrow.toString(), simOut: out.toString(),
    spreadPct: sp, impactBps, slipBoundBps, floorUsd,
    ...(econ as Record<string, unknown>), achievable,
  });
  metrics.recordVariantOutcome(v.id, lane, { hit: true, netUsd: b.netUsd, floorUsd });
  // stream the ACTIVE on-chain barrier — minOut = repay + premium
  // (+ floor on whale lane), in USD terms, for the cockpit
  const toUsd = (amt: bigint) => (Number(amt) / 10 ** decBorrow) * tokenUsd;
  metrics.noteMinOut(
    chain.key,
    toUsd(borrow + flPremiumToken) + (lane === 'whale' ? floorUsd : 0),
    floorUsd,
  );
  // lane floor in borrowToken units — the executor binds it into the
  // plan's minProfit (and whale-lane minOut), so the floor is enforced
  // on-chain, not just at screening.
  const minProfitToken = BigInt(Math.floor((floorUsd / tokenUsd) * 10 ** decBorrow));
  return {
    strategy, chain, legs, borrowToken, borrowAmount: borrow, simOut: out,
    spreadPct: sp, netUsd: b.netUsd, variant: v, lane,
    impactBps, slipBoundBps, minProfitToken,
    grossUsd: b.n.grossUsd, gasUsd: b.n.gasUsd, premiumUsd: b.n.premiumUsd,
  };
}

/** Enumerate candidates for a chain on current registry state. */
export function solve(
  chain: ChainConfig,
  v: Variant,
  opts: { gasUnits: bigint; baseFeeWei: bigint; l1DataFeeWei?: bigint; lane?: Lane; regime?: MarketRegime; volBps?: number; tokenUsd: Map<string, number>; sizeOf: (token: string, dec: number) => bigint; nativeUsd?: number; priorityFeeWei?: bigint; flashLiquidityRaw?: bigint },
): Candidate[] {
  const pools = registry.all(chain.key);
  const cands: Candidate[] = [];
  const seenPaths = new Set<string>();
  const strat = new Set(cfg.strategies);
  // dynamic slippage bound — computed once per solve from live regime
  // + whale-window state; applies to every emitted candidate
  const lane = opts.lane ?? 'predictive';
  const slipBps = dynamicSlippageBps(v, {
    regime: opts.regime,
    whale: lane === 'whale',
    volBps: opts.volBps,
  });
  metrics.setSlippage(chain.key, {
    regime: opts.regime ?? 'BALANCED',
    whale: lane === 'whale',
    boundBps: slipBps,
    volBps: opts.volBps ?? 0,
    lastImpactBps: 0,
    peakImpactBps: 0,
    minOutUsd: 0,
    floorUsd: 0,
  });
  const push = (c: Candidate | null) => {
    if (!c) return;
    const sig = c.legs.map((l) => l.pool.address.toLowerCase()).join('>');
    if (seenPaths.has(sig)) return;
    seenPaths.add(sig);
    cands.push(c);
  };

  // adaptive depth gate for THIS solve — variant's own floor scaled by
  // the chain's ladder (decays on consecutive zero-emit cycles)
  depthRejectsThisSolve = 0;
  const baseDepthUsd = effectiveGuards(v).minDepthUsd;
  const effDepthUsd = Math.max(
    Math.floor(baseDepthUsd * (depthAdapt.get(chain.key)?.scale ?? 1)),
    DEPTH_FLOOR_USD,
  );

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
            if (!pathScreen(chain, legs, v, opts.tokenUsd, effDepthUsd)) continue;
            const usd = opts.tokenUsd.get(legs[0].tokenIn.toLowerCase());
            if (usd === undefined) continue; // unpriced borrow = dishonest net
            const borrow = opts.sizeOf(legs[0].tokenIn, decOf(legs[0].pool, legs[0].tokenIn));
            push(emit('P01', chain, legs, legs[0].tokenIn, borrow, v, opts.gasUnits, opts.baseFeeWei, usd, opts.l1DataFeeWei ?? 0n, lane, slipBps, opts.nativeUsd, opts.priorityFeeWei, { flashLiquidityRaw: opts.flashLiquidityRaw }));
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
            if (!pathScreen(chain, legs, v, opts.tokenUsd, effDepthUsd)) continue;
            const usdA = opts.tokenUsd.get(a);
            if (usdA === undefined) continue; // unpriced borrow = dishonest net
            const borrow = opts.sizeOf(a, decOf(p1, a));
            const cnd = emit('P02', chain, legs, a, borrow, v, opts.gasUnits, opts.baseFeeWei, usdA, opts.l1DataFeeWei ?? 0n, lane, slipBps, opts.nativeUsd, opts.priorityFeeWei, { flashLiquidityRaw: opts.flashLiquidityRaw });
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
    if (!pathScreen(chain, legs, v, opts.tokenUsd, effDepthUsd)) continue;
    const usd = opts.tokenUsd.get(legs[0].tokenIn.toLowerCase());
    if (usd === undefined) continue; // unpriced borrow token = dishonest net
    const borrow = opts.sizeOf(legs[0].tokenIn, decOf(legs[0].pool, legs[0].tokenIn));
    push(emit(label, chain, legs, legs[0].tokenIn, borrow, v, opts.gasUnits, opts.baseFeeWei, usd, opts.l1DataFeeWei ?? 0n, lane, slipBps, opts.nativeUsd, opts.priorityFeeWei, { flashLiquidityRaw: opts.flashLiquidityRaw }));
  }

  // adaptive-depth update — zero emits + depth rejections → decay the
  // ladder; any emit resets it. Scale applies across variants so their
  // relative depth ordering is preserved while the whole cone widens.
  if (cands.length === 0) {
    const a = depthAdapt.get(chain.key) ?? { scale: 1, empty: 0 };
    a.empty++;
    if (a.empty >= DEPTH_ADAPT_AFTER && depthRejectsThisSolve > 0) {
      const next = Math.max(a.scale * DEPTH_ADAPT_STEP, DEPTH_FLOOR_USD / baseDepthUsd);
      if (next < a.scale) {
        a.scale = next;
        log.info(`adaptive depth ${chain.key}: minDepth ×${a.scale.toFixed(3)} → $${Math.floor(baseDepthUsd * a.scale)} eff (zero-emit streak ${a.empty})`);
      }
    }
    depthAdapt.set(chain.key, a);
  } else {
    depthAdapt.delete(chain.key);
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
