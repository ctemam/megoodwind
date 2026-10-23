/**
 * WO-11 — MEV-Share hint stream (Ethereum mainnet only, SSE).
 * Emits normalized hints: tx hash + calldata + to + mevGasPrice + log
 * metadata the searcher can act on (pool touched, fn selector).
 * Shadow-only: feeds the planner; never sends without the exec path's
 * eth_callBundle gate + Commander arming.
 */
import { EventEmitter } from 'events';
import { logger } from '../config/logger.js';
import { appendFileSync, mkdirSync } from 'fs';

const log = logger('mevshare');
const MEV_SHARE_URL = process.env.MEV_SHARE_STREAM ?? 'https://mev-share.flashbots.net';

export interface MevHint {
  ts: number;
  hash: string;
  to?: string;
  fnSelector?: string;
  gasUsed?: string;
  mevGasPrice?: string;
  logs?: { address: string; topics: string[] }[];
  /** pools we could resolve to registry addresses (filled downstream) */
  touchedPools?: string[];
}

export class MevShareHints extends EventEmitter {
  private abort?: AbortController;
  private seen = new Set<string>();

  /** Start the SSE reader; emits 'hint'. */
  async start(): Promise<void> {
    this.abort = new AbortController();
    try {
      const r = await fetch(MEV_SHARE_URL, { headers: { accept: 'text/event-stream' }, signal: this.abort.signal });
      if (!r.ok || !r.body) throw new Error(`hint stream http ${r.status}`);
      const rd = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data || data === '{}') continue;
          this.handle(data);
        }
      }
    } catch (e) {
      if (!(e as Error).name?.includes('Abort')) log.warn('hint stream error', String((e as Error).message ?? e));
    }
  }

  private handle(raw: string) {
    try {
      const j = JSON.parse(raw);
      const hash: string = j.hash ?? j.txHash ?? j.tx_hash;
      if (!hash || this.seen.has(hash)) return;
      this.seen.add(hash);
      if (this.seen.size > 100_000) this.seen.clear();
      const hint: MevHint = {
        ts: Date.now(), hash,
        to: j.to ?? j.txs?.[0]?.to,
        fnSelector: j.function_selector ?? j.callData?.slice(0, 10) ?? j.txs?.[0]?.data?.slice(0, 10),
        gasUsed: j.gas_used?.toString(),
        mevGasPrice: j.mevGasPrice?.toString(),
        logs: j.logs?.map((l: { address?: string; topics?: string[] }) => ({ address: l.address ?? '', topics: l.topics ?? [] })),
      };
      mkdirSync('data/private', { recursive: true });
      appendFileSync('data/private/mev_hints.jsonl', JSON.stringify(hint) + '\n');
      this.emit('hint', hint);
    } catch { /* malformed frame — drop */ }
  }

  stop() { this.abort?.abort(); }
}
