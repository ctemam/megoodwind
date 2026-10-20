import { ChainKey } from '../config/index.js';

/**
 * Pool registry — canonical venue state for the solver.
 * dexId does NOT encode AMM version (DexScreener "pancakeswap" = v2 AND v3);
 * version comes from `labels` — mislabeled protocol = guaranteed exec revert.
 */

export type DexKind = 'v2' | 'v3';

export interface PoolRef {
  address: string;
  chain: ChainKey;
  dexId: string;        // pancakeswap, uniswap, sushiswap, nomiswap...
  kind: DexKind;        // from labels — NEVER inferred from dexId
  token0: string;
  token1: string;
  symbol0: string;
  symbol1: string;
  dec0: number;
  dec1: number;
  feeBps: number;       // v2 swap fee or v3 tier in bps (5/30/100)
  liquidityUsd: number;
  priceUsd?: number;
}

export interface PoolState extends PoolRef {
  reserve0?: bigint;
  reserve1?: bigint;          // v2
  sqrtPriceX96?: bigint;      // v3
  tick?: number;
  liquidity?: bigint;         // v3 in-range
  updatedAt: number;
}

export class PoolRegistry {
  private pools = new Map<string, PoolState>(); // key = chain:address
  private byPair = new Map<string, Set<string>>(); // chain:t0:t1 (sorted) -> pool keys

  static pairKey(chain: ChainKey, t0: string, t1: string): string {
    const [a, b] = [t0.toLowerCase(), t1.toLowerCase()].sort();
    return `${chain}:${a}:${b}`;
  }

  upsert(p: PoolRef): PoolState {
    const key = `${p.chain}:${p.address.toLowerCase()}`;
    const existing = this.pools.get(key);
    const state: PoolState = { ...existing, ...p, updatedAt: Date.now() };
    this.pools.set(key, state);
    const pk = PoolRegistry.pairKey(p.chain, p.token0, p.token1);
    if (!this.byPair.has(pk)) this.byPair.set(pk, new Set());
    this.byPair.get(pk)!.add(key);
    return state;
  }

  updateState(key: string, patch: Partial<PoolState>) {
    const s = this.pools.get(key);
    if (s) Object.assign(s, patch, { updatedAt: Date.now() });
  }

  get(key: string) { return this.pools.get(key); }

  /** Peer pools quoting the same unordered pair on this chain. */
  peers(chain: ChainKey, t0: string, t1: string): PoolState[] {
    const keys = this.byPair.get(PoolRegistry.pairKey(chain, t0, t1));
    if (!keys) return [];
    return [...keys].map((k) => this.pools.get(k)!).filter(Boolean);
  }

  remove(key: string) { this.pools.delete(key); }

  all(chain: ChainKey): PoolState[] {
    return [...this.pools.values()].filter((p) => p.chain === chain);
  }

  get size() { return this.pools.size; }
}

export const registry = new PoolRegistry();
