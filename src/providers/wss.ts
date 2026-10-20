import { ethers } from 'ethers';
import { ChainConfig } from '../config/index.js';
import { logger } from '../config/logger.js';

/**
 * Item #10 — high-throughput WSS telemetry.
 * WebSocket provider over the private keyed endpoint with keep-alive
 * pings and auto-reconnect. newHeads always; newPendingTransactions
 * only where the endpoint advertises it (eth/bsc/poly predictive lanes).
 */

export type HeadHandler = (blockNumber: number, ts: number) => void;
export type PendingHandler = (txHash: string) => void;

export class WssLane {
  private provider?: ethers.WebSocketProvider;
  private destroyed = false;
  private reconnectMs = 1_000;
  private consecutiveFails = 0;
  private urlIdx = 0;
  private log = logger('wss');
  private static MAX_FAILS = 6;

  constructor(
    private chain: ChainConfig,
    private onHead: HeadHandler,
    private onPending?: PendingHandler,
  ) {}

  /** Current WSS candidate — pool rotates on dead-lane/auth failures. */
  private get url(): string | undefined {
    const pool = this.chain.wssUrls?.length ? this.chain.wssUrls : [this.chain.wssUrl].filter(Boolean) as string[];
    return pool[this.urlIdx % pool.length];
  }

  private rotate(reason: string): boolean {
    const pool = this.chain.wssUrls ?? [];
    if (pool.length < 2) return false;
    this.urlIdx = (this.urlIdx + 1) % pool.length;
    this.consecutiveFails = 0;
    this.log.warn(`${this.chain.key} WSS rotate (${reason}) -> ${this.hostOf(this.url)}`);
    return true;
  }

  async start(): Promise<void> {
    if (!this.url) {
      this.log.warn(`${this.chain.key}: no WSS_URL — polling head via RPC pool`);
      return;
    }
    if (this.destroyed) return;
    try {
      const ws = new ethers.WebSocketProvider(this.url, this.chain.chainId, {
        staticNetwork: true,
      });
      this.provider = ws;
      await ws.getBlockNumber();

      ws.on('block', (n: number) => this.onHead(n, Date.now()));

      if (this.onPending) {
        try {
          await ws.send('eth_subscribe', ['newPendingTransactions']);
          ws.on('pending', (h: string) => this.onPending?.(h));
        } catch {
          this.log.warn(`${this.chain.key}: newPendingTransactions unsupported on this endpoint`);
        }
      }

      const socket = ws.websocket as unknown as {
        on?: (ev: string, fn: () => void) => void;
      };
      socket.on?.('close', () => this.scheduleReconnect());
      socket.on?.('error', () => this.scheduleReconnect());

      this.reconnectMs = 1_000;
      this.consecutiveFails = 0;
      this.log.info(`${this.chain.key} WSS connected`);
    } catch (e) {
      this.consecutiveFails++;
      this.log.error(`${this.chain.key} WSS connect failed (${this.consecutiveFails})`, e);
      this.scheduleReconnect(e);
    }
  }

  private scheduleReconnect(err?: unknown) {
    if (this.destroyed) return;
    const msg = String((err as { message?: string })?.message ?? err ?? '');
    const hardQuota = msg.includes('rate limit') || msg.includes('paid plan') || msg.includes('"code":15');
    const authDead = /not enabled|unauthorized|forbidden|403|401|invalid api/i.test(msg);
    // auth-fatal: this endpoint can never serve us — rotate, don't retry
    if (authDead && this.rotate('auth')) { setTimeout(() => void this.start(), 250); return; }
    // dead-lane circuit: persistent hard-quota failures mean the endpoint
    // can't serve this account — rotate to the next keyed WSS candidate;
    // only fall back to RPC polling once the whole pool is exhausted.
    if (this.consecutiveFails >= WssLane.MAX_FAILS && hardQuota) {
      if (this.rotate('quota')) { setTimeout(() => void this.start(), 500); return; }
      this.log.warn(`${this.chain.key} WSS dead-lane: all candidates quota-blocked, falling back to RPC poll`);
      this.destroyed = true;
      return;
    }
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    setTimeout(() => void this.start(), wait);
  }

  private hostOf(u?: string): string {
    try { return u ? new URL(u).hostname : '?'; } catch { return '?'; }
  }

  async stop() {
    this.destroyed = true;
    await this.provider?.destroy().catch(() => undefined);
  }
}
