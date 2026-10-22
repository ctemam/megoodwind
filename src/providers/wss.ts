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

/** memWatch gauge — live WebSocketProvider instances across all lanes.
 *  Healthy value = number of configured lanes (3 on eth); growth beyond
 *  that is zombie providers from reconnect churn. */
let liveProviders = 0;
export function wssLiveProviders(): number { return liveProviders; }

export class WssLane {
  private provider?: ethers.WebSocketProvider;
  private destroyed = false;
  private reconnectMs = 1_000;
  private consecutiveFails = 0;
  private urlIdx = 0;
  private log = logger('wss');
  private reconnectTimer?: NodeJS.Timeout; // single-flight reconnect — never stacked
  private starting = false;                // overlapping start() guard
  private static MAX_FAILS = 6;

  constructor(
    private chain: ChainConfig,
    private onHead: HeadHandler,
    private onPending?: PendingHandler,
    /** Union mode: pin this lane to ONE endpoint — the caller owns the
     *  union across accounts; rotation is disabled when pinned. */
    private pinnedUrl?: string,
  ) {}

  /** Current WSS candidate — pool rotates on dead-lane/auth failures
   *  (single-candidate lanes when pinned). */
  private get url(): string | undefined {
    if (this.pinnedUrl) return this.pinnedUrl;
    const pool = this.chain.wssUrls?.length ? this.chain.wssUrls : [this.chain.wssUrl].filter(Boolean) as string[];
    return pool[this.urlIdx % pool.length];
  }

  private rotate(reason: string): boolean {
    if (this.pinnedUrl) return false; // union lanes never rotate — dead is dead
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
    if (this.destroyed || this.starting) return;
    this.starting = true;
    try {
      // destroy the previous provider BEFORE replacing it — an abandoned
      // provider keeps its socket + newPendingTransactions subscription
      // alive, still feeding onPending: zombie lanes accumulate mempool
      // streams forever (the OOM evidence: heap grew with registry=0).
      const old = this.provider;
      this.provider = undefined;
      if (old) { liveProviders--; await old.destroy().catch(() => undefined); }
      const ws = new ethers.WebSocketProvider(this.url, this.chain.chainId, {
        staticNetwork: true,
      });
      this.provider = ws;
      liveProviders++;
      // Attach socket handlers BEFORE any await — a handshake failure
      // (e.g. HTTP 502) emits 'error' on the underlying socket during
      // getBlockNumber; an unhandled socket error crashes the process.
      const socket = ws.websocket as unknown as {
        on?: (ev: string, fn: () => void) => void;
      };
      socket.on?.('close', () => this.scheduleReconnect());
      socket.on?.('error', () => this.scheduleReconnect());
      // belt: provider-level errors (socket swaps on reconnect create
      // fresh instances our socket handlers never saw)
      ws.on('error', (e: unknown) => this.scheduleReconnect(e));
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

      this.reconnectMs = 1_000;
      this.consecutiveFails = 0;
      this.log.info(`${this.chain.key} WSS connected`);
    } catch (e) {
      this.consecutiveFails++;
      this.log.error(`${this.chain.key} WSS connect failed (${this.consecutiveFails})`, e);
      this.scheduleReconnect(e);
    } finally {
      this.starting = false;
    }
  }

  private scheduleReconnect(err?: unknown) {
    if (this.destroyed) return;
    // single-flight: socket 'close' + socket 'error' + provider 'error'
    // can all fire for one failure — without this guard each schedules
    // its own start() and lanes multiply.
    if (this.reconnectTimer) return;
    const msg = String((err as { message?: string })?.message ?? err ?? '');
    const hardQuota = msg.includes('rate limit') || msg.includes('paid plan') || msg.includes('"code":15');
    const authDead = /not enabled|unauthorized|forbidden|403|401|invalid api/i.test(msg);
    // auth-fatal: this endpoint can never serve us — rotate, don't retry
    if (authDead && this.rotate('auth')) { this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.start(); }, 250); return; }
    // dead-lane circuit: persistent hard-quota failures mean the endpoint
    // can't serve this account — rotate to the next keyed WSS candidate;
    // only fall back to RPC polling once the whole pool is exhausted.
    if (this.consecutiveFails >= WssLane.MAX_FAILS && hardQuota) {
      if (this.rotate('quota')) { this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.start(); }, 500); return; }
      this.log.warn(`${this.chain.key} WSS dead-lane: ${this.pinnedUrl ? 'union member' : 'all candidates'} quota-blocked, ${this.pinnedUrl ? 'lane retired' : 'falling back to RPC poll'}`);
      this.destroyed = true;
      return;
    }
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.start(); }, wait);
  }

  private hostOf(u?: string): string {
    try { return u ? new URL(u).hostname : '?'; } catch { return '?'; }
  }

  async stop() {
    this.destroyed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    const p = this.provider;
    this.provider = undefined;
    if (p) { liveProviders--; await p.destroy().catch(() => undefined); }
  }
}
