import { EventEmitter } from 'node:events';
import { ChainConfig, cfg } from '../config/index.js';
import { logger } from '../config/logger.js';
import { WssLane } from '../providers/wss.js';
import { RpcPool } from '../providers/rpcPool.js';
import { providerOf } from '../providers/providerCatalog.js';

/**
 * Item #14 — TypeScript Live Listener (the Scout Agent).
 * Subscribes newHeads on every active chain and newPendingTransactions
 * on the predictive lanes (public-mempool chains only — sequencer chains
 * have no visible mempool, so pending feeds are skipped there).
 *
 * Emits:
 *   'head'   (chain, blockNumber)         -> triggers one refresh+eval cycle
 *   'pending'(chain, txHash)              -> predictive intake (throttled)
 *   'whale'  (chain, tokenAddr)           -> targeted refresh request
 */

export interface ScoutEvents {
  head: (chain: ChainConfig, blockNumber: number) => void;
  pending: (chain: ChainConfig, txHash: string) => void;
}

export class ScoutListener extends EventEmitter {
  private lanes: WssLane[] = [];
  private lastHead = new Map<string, number>();
  private pendingThrottle = new Map<string, number>();
  /** Mempool-union dedupe — rolling bounded sets per chain. A pending tx
   *  arriving on two provider lanes is processed ONCE; different accounts
   *  see different mempool slices, which is the whole point of the union. */
  private seenPending = new Map<string, { cur: Set<string>; prev: Set<string>; rotatedAt: number }>();
  private log = logger('scout');
  private static PEND_SET_CAP = 200_000;
  private static PEND_ROTATE_MS = 120_000;

  constructor(
    private chains: ChainConfig[],
    private rpcs: Map<string, RpcPool>,
  ) {
    super();
    liveScouts.add(this);
  }

  async start(): Promise<void> {
    for (const chain of this.chains) {
      const isPredictive = cfg.predictiveChains.includes(chain.key);
      // UNION MODE — one pinned lane per distinct provider ACCOUNT.
      // Same-account URLs subscribe to the same mempool view (no gain);
      // different accounts = different node sets = genuinely new slices.
      const urls = chain.wssUrls?.length ? chain.wssUrls : [chain.wssUrl].filter(Boolean) as string[];
      const byAccount = new Map<string, string>();
      for (const u of urls) {
        const { account } = providerOf(u);
        if (!byAccount.has(account)) byAccount.set(account, u);
      }
      for (const [account, url] of byAccount) {
        const lane = new WssLane(
          chain,
          (blockNumber) => this.handleHead(chain, blockNumber),
          isPredictive ? (hash) => this.handlePending(chain, hash) : undefined,
          url,
        );
        this.lanes.push(lane);
        void lane.start();
        this.log.info(`${chain.key} WSS union member: ${account}`);
      }
      if (!byAccount.size) {
        this.log.warn(`${chain.key}: no WSS endpoints — head polling only`);
      }
    }
    this.log.info(`scout online: ${this.chains.map((c) => c.key).join(', ')} (${this.lanes.length} union lanes)`);
  }

  private handleHead(chain: ChainConfig, n: number) {
    const prev = this.lastHead.get(chain.key) ?? 0;
    if (n <= prev) return;
    this.lastHead.set(chain.key, n);
    this.emit('head', chain, n);
  }

  private handlePending(chain: ChainConfig, hash: string) {
    const now = Date.now();
    // rolling two-set dedupe — bounded, no unbounded growth under floods
    let s = this.seenPending.get(chain.key);
    if (!s) { s = { cur: new Set(), prev: new Set(), rotatedAt: now }; this.seenPending.set(chain.key, s); }
    if (now - s.rotatedAt > ScoutListener.PEND_ROTATE_MS || s.cur.size > ScoutListener.PEND_SET_CAP) {
      s.prev = s.cur; s.cur = new Set(); s.rotatedAt = now;
    }
    if (s.cur.has(hash) || s.prev.has(hash)) return; // same tx on another lane
    s.cur.add(hash);
    // PEND_THROTTLE_MS — cap intake so a mempool burst can't flood the loop
    const last = this.pendingThrottle.get(chain.key) ?? 0;
    if (now - last < cfg.PEND_THROTTLE_MS) return;
    this.pendingThrottle.set(chain.key, now);
    this.emit('pending', chain, hash);
  }

  /** Targeted refresh demand from the whale pipe (item #17). */
  requestTargetedRefresh(chain: ChainConfig, tokenAddr: string) {
    this.emit('whale', chain, tokenAddr);
  }

  /** Head height for a chain (fallback to RPC poll when WSS absent). */
  async headHeight(chain: ChainConfig): Promise<number> {
    const cached = this.lastHead.get(chain.key);
    if (cached) return cached;
    const rpc = this.rpcs.get(chain.key);
    return rpc ? rpc.blockNumber() : 0;
  }

  /** memWatch sampler — pending-dedupe set sizes per chain. */
  pendingSetSizes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, s] of this.seenPending) out[k] = s.cur.size + s.prev.size;
    return out;
  }

  async stop() { liveScouts.delete(this); await Promise.all(this.lanes.map((l) => l.stop())); }
}

/** Module-level sampler — sums across live ScoutListener instances. */
export function pendingSetSizes(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of liveScouts) {
    for (const [k, v] of Object.entries(s.pendingSetSizes())) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

const liveScouts = new Set<ScoutListener>();
