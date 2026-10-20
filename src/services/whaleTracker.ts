import { ethers } from 'ethers';
import { ChainConfig, cfg } from '../config/index.js';
import { logger } from '../config/logger.js';
import { RpcPool } from '../providers/rpcPool.js';

/**
 * Item #17 — Whale Tracking Module (early-warning ingestion pipe).
 * Tracks single transfers > $500K. Two sources:
 *   1) Whale Alert API (when WHALE_ALERT_API_KEY is set)
 *   2) Free on-chain fallback: ERC-20 Transfer logs over the private WSS/
 *      RPC endpoints on watched tokens (native + wrapped native + majors)
 * Identified token addresses are piped to the Scout loop for targeted
 * pool refresh.
 */

const log = logger('whale');
const THRESHOLD_USD = 500_000;
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

export type WhaleHandler = (chain: ChainConfig, tokenAddr: string, usd: number) => void;

interface WatchedToken { address: string; decimals: number; usd: number; symbol: string }

export class WhaleTracker {
  private watched = new Map<string, WatchedToken[]>(); // chain -> tokens
  private pollTimer?: NodeJS.Timeout;
  private logCursor = new Map<string, number>(); // chain -> last scanned block

  constructor(
    private chains: ChainConfig[],
    private rpcs: Map<string, RpcPool>,
    private onWhale: WhaleHandler,
  ) {}

  watchToken(chain: ChainConfig, t: WatchedToken) {
    const arr = this.watched.get(chain.key) ?? [];
    if (!arr.some((x) => x.address.toLowerCase() === t.address.toLowerCase())) arr.push(t);
    this.watched.set(chain.key, arr);
  }

  async start(): Promise<void> {
    if (cfg.WHALE_ALERT_API_KEY) {
      this.pollTimer = setInterval(() => void this.pollWhaleAlert(), 30_000);
      log.info('whale pipe: Whale Alert API mode');
    } else {
      this.pollTimer = setInterval(() => void this.scanLogs(), cfg.SCAN_INTERVAL_SECS * 1000);
      log.info('whale pipe: on-chain Transfer-log mode (no API key)');
    }
  }

  stop() { if (this.pollTimer) clearInterval(this.pollTimer); }

  // ---- source 1: Whale Alert ----
  private async pollWhaleAlert() {
    try {
      const url = `https://api.whale-alert.io/v1/transactions?api_key=${cfg.WHALE_ALERT_API_KEY}&min_value=${THRESHOLD_USD}&limit=20`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const data = (await res.json()) as {
        transactions?: { blockchain: string; symbol: string; amount_usd: number; to?: { address?: string } }[];
      };
      for (const tx of data.transactions ?? []) {
        const chain = this.chains.find((c) => chainMatches(c.key, tx.blockchain));
        if (!chain || !tx.to?.address) continue;
        if (tx.amount_usd >= THRESHOLD_USD) this.onWhale(chain, tx.to.address, tx.amount_usd);
      }
    } catch (e) {
      log.debug('whale-alert poll failed', e);
    }
  }

  // ---- source 2: on-chain Transfer scan (free, private RPC) ----
  private async scanLogs() {
    for (const chain of this.chains) {
      const rpc = this.rpcs.get(chain.key);
      const tokens = this.watched.get(chain.key) ?? [];
      if (!rpc || !tokens.length) continue;
      try {
        const head = await rpc.blockNumber();
        const from = this.logCursor.get(chain.key) ?? head - 20;
        if (from >= head) { this.logCursor.set(chain.key, head); continue; }
        const logs = await rpc.call<{ topics: string[]; address: string; data: string }[]>(
          'eth_getLogs',
          [{
            fromBlock: ethers.toBeHex(from),
            toBlock: ethers.toBeHex(head),
            topics: [TRANSFER_TOPIC],
          }],
        );
        this.logCursor.set(chain.key, head);
        const byToken = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
        for (const l of logs.slice(0, 500)) {
          const t = byToken.get(l.address.toLowerCase());
          if (!t) continue;
          const amount = Number(ethers.toBigInt(l.data)) / 10 ** t.decimals;
          const usd = amount * t.usd;
          if (usd >= THRESHOLD_USD) this.onWhale(chain, t.address, usd);
        }
      } catch (e) {
        log.debug(`${chain.key} log scan failed`, e);
      }
    }
  }
}

const chainMatches = (key: string, blockchain: string): boolean => {
  const b = blockchain.toLowerCase();
  return (
    (key === 'eth' && b === 'ethereum') ||
    (key === 'bsc' && b === 'binance') ||
    (key === 'poly' && b === 'polygon') ||
    (key === 'arb' && b === 'arbitrum') ||
    (key === 'op' && b === 'optimism') ||
    (key === 'avax' && b === 'avalanche') ||
    (key === 'base' && b === 'base')
  );
};
