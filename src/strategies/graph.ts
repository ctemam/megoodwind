import { PoolState } from '../pools/registry.js';
import { v3SpotPrice } from '../math/univ3.js';
import { Leg } from './solver.js';

/**
 * Dynamic Graph Discovery (skill.md — Bellman-Ford pathfinder).
 * Edges are built at RUNTIME from whatever the factory scan + refresh
 * produced — tokens and pool-weight edges are never hardcoded.
 *
 *   edge u->v weight = -ln( normalized_out_per_in * (1 - fee) )
 *   negative cycle  => product of rates > 1 => arbitrage cycle
 *
 * BF runs per anchor token with bounded depth (<=4 hops) — O(anchors*E)
 * per cycle, all CPU, zero RPC.
 */

export interface Edge {
  from: string;
  to: string;
  pool: PoolState;
  weight: number;
  rate: number;
}

const MAX_DEPTH = 4;
const EPS = 1e-9;

function edgeRate(p: PoolState, tokenIn: string): number {
  const inIs0 = p.token0.toLowerCase() === tokenIn.toLowerCase();
  const feeMul = 1 - p.feeBps / 10_000;
  if (p.kind === 'v2') {
    if (!p.reserve0 || !p.reserve1) return 0;
    const rIn = inIs0 ? p.reserve0 : p.reserve1;
    const rOut = inIs0 ? p.reserve1 : p.reserve0;
    const dIn = inIs0 ? p.dec0 : p.dec1;
    const dOut = inIs0 ? p.dec1 : p.dec0;
    if (rIn === 0n) return 0;
    return (Number(rOut) / 10 ** dOut) / (Number(rIn) / 10 ** dIn) * feeMul;
  }
  if (!p.sqrtPriceX96) return 0;
  const px = v3SpotPrice(p.sqrtPriceX96, p.dec0, p.dec1);
  const rate = inIs0 ? px : (px > 0 ? 1 / px : 0);
  return rate * feeMul;
}

export function buildEdges(pools: PoolState[]): Edge[] {
  const out: Edge[] = [];
  for (const p of pools) {
    for (const [from, to] of [[p.token0, p.token1], [p.token1, p.token0]] as const) {
      const rate = edgeRate(p, from);
      if (rate > 0 && Number.isFinite(rate)) {
        out.push({ from: from.toLowerCase(), to: to.toLowerCase(), pool: p, weight: -Math.log(rate), rate });
      }
    }
  }
  return out;
}

/** Top-degree anchor tokens keep BF bounded on large graphs. */
function anchors(edges: Edge[], limit = 25): string[] {
  const degree = new Map<string, number>();
  for (const e of edges) degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
  return [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}

/** Extract the cycle a parent-chain lands on. */
function extractCycle(parent: Map<string, { edge: Edge; from: string }>, start: string): Leg[] | null {
  // Walk back until we revisit a node — that loop is the cycle.
  const seen = new Map<string, number>();
  const path: { node: string; edge: Edge }[] = [];
  let cur = start;
  for (let i = 0; i <= MAX_DEPTH + 1; i++) {
    if (seen.has(cur)) {
      const legs: Leg[] = [];
      for (let k = seen.get(cur)!; k < path.length; k++) {
        legs.push({ pool: path[k].edge.pool, tokenIn: path[k].edge.from, tokenOut: path[k].edge.to });
      }
      return legs.length >= 2 ? legs : null;
    }
    seen.set(cur, path.length);
    const p = parent.get(cur);
    if (!p) return null;
    path.push({ node: cur, edge: p.edge });
    cur = p.from;
  }
  return null;
}

const cycleSig = (legs: Leg[]): string => {
  const pools = legs.map((l) => l.pool.address.toLowerCase()).sort();
  return pools.join('>');
};

/** Bellman-Ford negative-cycle detection — returns unique cyclic Leg[]. */
export function findCycles(edges: Edge[]): Leg[][] {
  const cycles: Leg[][] = [];
  const seen = new Set<string>();
  const byFrom = new Map<string, Edge[]>();
  for (const e of edges) {
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from)!.push(e);
  }

  for (const src of anchors(edges)) {
    const dist = new Map<string, number>([[src, 0]]);
    const parent = new Map<string, { edge: Edge; from: string }>();

    // relax up to MAX_DEPTH times — bounded-hop cycles only
    let changed = true;
    for (let i = 0; i < MAX_DEPTH && changed; i++) {
      changed = false;
      for (const e of edges) {
        const d = dist.get(e.from);
        if (d === undefined) continue;
        const nd = d + e.weight;
        if (nd < (dist.get(e.to) ?? Infinity) - EPS) {
          dist.set(e.to, nd);
          parent.set(e.to, { edge: e, from: e.from });
          changed = true;
        }
      }
    }

    // one more pass — any improvable node sits on/behind a negative cycle
    for (const e of edges) {
      const d = dist.get(e.from);
      if (d === undefined) continue;
      if (d + e.weight < (dist.get(e.to) ?? Infinity) - EPS) {
        const legs = extractCycle(parent, e.to);
        if (!legs) continue;
        const sig = cycleSig(legs);
        if (seen.has(sig)) continue;
        // confirm the cycle actually returns to its start token
        if (legs[0].tokenIn !== legs[legs.length - 1].tokenOut) continue;
        seen.add(sig);
        cycles.push(legs);
      }
    }
  }
  return cycles;
}
