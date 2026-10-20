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
  private log = logger('wss');
  private static MAX_FAILS = 6;

  constructor(
    private chain: ChainConfig,
    private onHead: HeadHandler,
    private onPending?: PendingHandler,
  ) {}

  async start(): Promise<void> {
    if (!this.chain.wssUrl) {
      this.log.warn(`${this.chain.key}: no WSS_URL — polling head via RPC pool`);
      return;
    }
    if (this.destroyed) return;
    try {
      const ws = new ethers.WebSocketProvider(this.chain.wssUrl, this.chain.chainId, {
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
    // dead-lane circuit: persistent hard-quota failures mean the endpoint
    // can't serve this account — stop hammering, runner polls instead.
    if (this.consecutiveFails >= WssLane.MAX_FAILS && hardQuota) {
      this.log.warn(`${this.chain.key} WSS dead-lane: quota-blocked, falling back to RPC poll`);
      this.destroyed = true;
      return;
    }
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    setTimeout(() => void this.start(), wait);
  }

  async stop() {
    this.destroyed = true;
    await this.provider?.destroy().catch(() => undefined);
  }
}
