import { EventEmitter } from 'node:events';
import { ChainConfig, cfg } from '../config/index.js';
import { logger } from '../config/logger.js';
import { WssLane } from '../providers/wss.js';
import { RpcPool } from '../providers/rpcPool.js';

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
  private log = logger('scout');

  constructor(
    private chains: ChainConfig[],
    private rpcs: Map<string, RpcPool>,
  ) {
    super();
  }

  async start(): Promise<void> {
    for (const chain of this.chains) {
      const isPredictive = cfg.predictiveChains.includes(chain.key);
      const lane = new WssLane(
        chain,
        (blockNumber) => this.handleHead(chain, blockNumber),
        isPredictive ? (hash) => this.handlePending(chain, hash) : undefined,
      );
      this.lanes.push(lane);
      void lane.start();
    }
    this.log.info(`scout online: ${this.chains.map((c) => c.key).join(', ')}`);
  }

  private handleHead(chain: ChainConfig, n: number) {
    const prev = this.lastHead.get(chain.key) ?? 0;
    if (n <= prev) return;
    this.lastHead.set(chain.key, n);
    this.emit('head', chain, n);
  }

  private handlePending(chain: ChainConfig, hash: string) {
    // PEND_THROTTLE_MS — cap intake so a mempool burst can't flood the loop
    const now = Date.now();
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

  async stop() { await Promise.all(this.lanes.map((l) => l.stop())); }
}
