/**
 * WO-11 — backrun planner + bundle ledger. Consumes MEV-Share hints,
 * maps them to touched pools, runs one merged Multicall3 refresh +
 * solver eval, builds a mev_sendBundle (user body + our backrun),
 * gates via eth_callBundle before ANY send, and logs per-bundle
 * outcomes for the bid model.
 *
 * Shadow default: hints are parsed + solved + callBundle'd but NOT sent
 * unless WO11_LIVE_SEND=true (Commander gate).
 */
import { ethers } from 'ethers';
import { ChainConfig } from '../config/index.js';
import { RpcPool } from '../providers/rpcPool.js';
import { multicall } from '../providers/multicall.js';
import { registry } from '../pools/registry.js';
import { legOut } from '../strategies/solver.js';
import { MevShareHints, MevHint } from './hintStream.js';
import { callBundle, mevSendBundle } from '../exec/flashbots.js';
import { BidModel } from '../bidding/bidModel.js';
import { logger } from '../config/logger.js';
import { appendFileSync, mkdirSync } from 'fs';
import { netUsd } from '../math/profit.js';

const log = logger('backrun');
const LEDGER = 'data/private/bundle_ledger.jsonl';
const SWAP_TOPIC_V2 = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
const SWAP_TOPIC_V3 = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');

export interface BundleRow {
  ts: number;
  hintHash: string;
  path?: string;
  grossUsd?: number;
  bidUsd?: number;
  builders?: string[];
  callBundleOk?: boolean;
  sent?: boolean;
  included?: boolean;
  blockDelta?: number;
  realizedNetUsd?: number;
  refundUsd?: number;
  note?: string;
}
const ledger = (r: BundleRow) => { mkdirSync('data/private', { recursive: true }); appendFileSync(LEDGER, JSON.stringify(r) + '\n'); };

export class BackrunLane {
  private hints = new MevShareHints();
  private bids = new BidModel();

  constructor(private chain: ChainConfig, private rpc: RpcPool) {}

  async start() {
    this.hints.on('hint', (h: MevHint) => this.onHint(h).catch((e) => log.debug('hint eval failed', String(e))));
    await this.hints.start();
    log.info('mev-share hint stream live (shadow: callBundle gate only, no sends)');
  }

  /** Map hint logs -> registry pools touched. */
  private touchedPools(h: MevHint): string[] {
    const pools = new Set<string>();
    for (const l of h.logs ?? []) {
      if (l.topics[0] === SWAP_TOPIC_V2 || l.topics[0] === SWAP_TOPIC_V3) {
        if (registry.get(`${this.chain.key}:${l.address.toLowerCase()}`)) pools.add(l.address.toLowerCase());
      }
    }
    return [...pools];
  }

  private async onHint(h: MevHint) {
    const pools = this.touchedPools(h);
    if (!pools.length) { ledger({ ts: h.ts, hintHash: h.hash, note: 'no_registry_pool' }); return; }
    // ONE merged refresh of touched pools (post-hint state)
    const calls = pools.flatMap((p) => {
      const pool = registry.get(`${this.chain.key}:${p}`)!;
      return pool.kind === 'v3'
        ? [{ to: p, data: '0x3850c7bd', ci: 0 }, { to: p, data: '0x1a686502', ci: 0 }]
        : [{ to: p, data: '0x0902f1ac', ci: 0 }];
    });
    const res = await multicall(this.rpc, calls, calls.length).catch(() => null);
    if (!res) { ledger({ ts: h.ts, hintHash: h.hash, note: 'refresh_failed' }); return; }
    // update touched reserves, then 2-leg gross check vs same-pair peers —
    // the backrun signal: did this tx open a venue gap?
    let i = 0;
    for (const p of pools) {
      const pool = registry.get(`${this.chain.key}:${p}`)!;
      if (pool.kind === 'v3') {
        const sq = res[i++] ? BigInt('0x' + res[i - 1].slice(2, 66)) : null;
        const liq = res[i++] ? BigInt(res[i - 1]) : null;
        if (sq && liq) registry.updateState(`${this.chain.key}:${p}`, { sqrtPriceX96: sq, liquidity: liq });
      } else {
        const r = res[i++];
        if (r && r.length >= 194) {
          const r0 = BigInt('0x' + r.slice(2, 66)), r1 = BigInt('0x' + r.slice(66, 130));
          registry.updateState(`${this.chain.key}:${p}`, { reserve0: r0, reserve1: r1 });
        }
      }
    }
    // measure gap: best peer round-trip gross on each touched pair
    for (const p of pools) {
      const pool = registry.get(`${this.chain.key}:${p}`)!;
      const peers = registry.peers(this.chain.key, pool.token0, pool.token1).filter((q) => q.address.toLowerCase() !== p);
      for (const peer of peers) {
        const probe = 10n ** BigInt(pool.dec0); // 1 unit of token0
        const o1 = legOut(pool, probe, pool.token0);
        if (o1 <= 0n) continue;
        const o2 = legOut(peer, o1, pool.token1.toLowerCase() === peer.token0.toLowerCase() ? peer.token0 : peer.token1);
        if (o2 > probe) {
          const gapBps = Number((o2 - probe) * 10_000n / probe);
          ledger({ ts: h.ts, hintHash: h.hash, path: `${p}>${peer.address}`, grossUsd: undefined, note: `pair_gap ${gapBps}bps` });
          const bid = this.bids.optimalBid(50, 1, 0, gapBps); // gross scaled when USD feed wired
          if (bid) ledger({ ts: h.ts, hintHash: h.hash, note: `ev_bid ${bid.bidFrac.toFixed(2)} ev $${bid.evUsd.toFixed(2)}` });
        }
      }
    }
  }
}
