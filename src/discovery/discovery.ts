import { ethers } from 'ethers';
import { ChainConfig, cfg } from '../config/index.js';
import { logger } from '../config/logger.js';
import { RpcPool } from '../providers/rpcPool.js';
import { registry } from '../pools/registry.js';
import { breaker } from '../forensics/baitPool.js';
import { tokensForChain, DiscoveredToken } from './tokenLists.js';
import {
  factoriesFor, FACTORY_ABI, FactoryRef,
  POOL_CREATED_TOPIC, PAIR_CREATED_TOPIC, POOL_CREATED_ABI, PAIR_CREATED_ABI,
} from './factories.js';

/**
 * Scout Discovery Phase — asynchronous, per agents.md.
 * Boot: token-list tokens -> factory matrix getPool/getPair -> registry.
 * Steady-state: PoolCreated/PairCreated log scan every rescan tick —
 * newly deployed pairs enter the solver without a restart.
 * Manual pool/token registration is strictly forbidden.
 */

const log = logger('discovery');
const ZERO = '0x0000000000000000000000000000000000000000';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Discovery {
  private tokens = new Map<string, DiscoveredToken>(); // addr -> token
  private lastFactoryBlock = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(private chain: ChainConfig, private rpc: RpcPool) {}

  /** Boot phase — build the initial pool universe from on-chain state.
   *  Call-budget disciplined: DS pair feed supplies CANDIDATE pairs (cheap
   *  host), factory getPool/getPair VERIFY existence on-chain (truth).
   *  Full-brute matrix only for top-12 tokens to catch what feeds miss. */
  async boot(): Promise<void> {
    const t0 = performance.now();
    const tokens = (await tokensForChain(this.chain, this.rpc))
      .slice(0, cfg.DISCOVERY_TOP_TOKENS);
    for (const t of tokens) this.tokens.set(t.address.toLowerCase(), t);

    const factories = factoriesFor(this.chain.key).slice(0, cfg.DISCOVERY_MAX_FACTORIES);
    let found = 0;

    // Phase 1: candidate-pair verify — token pairs observed by the feed
    // (one factory call per pair, not the full Cartesian matrix)
    const candidatePairs = await this.feedPairs(tokens);
    for (const f of factories) {
      found += await this.verifyPairs(f, candidatePairs);
    }

    // Phase 2: bounded matrix over top-12 — on-chain discovery for pairs
    // the feed never listed (new/unindexed pools)
    const matrixCap = tokens.slice(0, 12);
    for (const f of factories) {
      found += await this.factoryMatrix(f, matrixCap);
    }

    log.info(`${this.chain.key} discovery boot: ${tokens.length} tokens, ${found} pools, ${(performance.now() - t0).toFixed(0)}ms`);
  }

  /** Candidate (tokenA,tokenB,fee?) tuples from the pair feed. */
  private async feedPairs(tokens: DiscoveredToken[]): Promise<Map<string, { a: DiscoveredToken; b: DiscoveredToken; fee?: number }>> {
    const { poolsForTokens } = await import('../feed/dexscreener.js');
    const out = new Map<string, { a: DiscoveredToken; b: DiscoveredToken; fee?: number }>();
    const byAddr = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
    const refs = await poolsForTokens(this.chain.key, tokens.map((t) => t.address));
    for (const r of refs) {
      const a = byAddr.get(r.token0.toLowerCase());
      const b = byAddr.get(r.token1.toLowerCase());
      if (!a || !b) continue;
      const sig = `${r.token0.toLowerCase()}:${r.token1.toLowerCase()}:${r.feeBps}`;
      if (!out.has(sig)) out.set(sig, { a, b, fee: r.kind === 'v3' ? r.feeBps * 100 : undefined });
    }
    return out;
  }

  private async verifyPairs(f: FactoryRef, pairs: Map<string, { a: DiscoveredToken; b: DiscoveredToken; fee?: number }>): Promise<number> {
    const combos = [...pairs.values()].flatMap((p) =>
      f.kind === 'v3'
        ? (p.fee !== undefined ? [{ ...p, fee: p.fee }] : f.feeTiers.map((fee) => ({ ...p, fee })))
        : [{ a: p.a, b: p.b, fee: undefined as number | undefined }],
    );
    return this.runCombos(f, combos);
  }

  /** Pair matrix against one factory — chunked batched eth_calls. */
  private async factoryMatrix(f: FactoryRef, tokens: DiscoveredToken[]): Promise<number> {
    const combos: { a: DiscoveredToken; b: DiscoveredToken; fee?: number }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        if (f.kind === 'v3') for (const fee of f.feeTiers) combos.push({ a: tokens[i], b: tokens[j], fee });
        else combos.push({ a: tokens[i], b: tokens[j] });
      }
    }
    return this.runCombos(f, combos);
  }

  private async runCombos(
    f: FactoryRef,
    combos: { a: DiscoveredToken; b: DiscoveredToken; fee?: number }[],
  ): Promise<number> {
    let found = 0;
    let delay = cfg.DISCOVERY_BATCH_DELAY_MS;
    for (let i = 0; i < combos.length; i += cfg.DISCOVERY_BATCH_SIZE) {
      const chunk = combos.slice(i, i + cfg.DISCOVERY_BATCH_SIZE);
      const calls = chunk.map((c) => ({
        to: f.address,
        data: f.kind === 'v3'
          ? FACTORY_ABI.encodeFunctionData('getPool', [c.a.address, c.b.address, c.fee])
          : FACTORY_ABI.encodeFunctionData('getPair', [c.a.address, c.b.address]),
      }));
      const results = await Promise.allSettled(calls.map((c) => this.rpc.callContract(c.to, c.data)));
      let failures = 0;
      results.forEach((r, k) => {
        if (r.status !== 'fulfilled' || r.value === '0x' || r.value.length < 66) {
          if (r.status === 'rejected') failures++;
          return;
        }
        const pool = ethers.getAddress(`0x${r.value.slice(-40)}`);
        if (pool === ZERO) return;
        const { a, b, fee } = chunk[k];
        this.upsertPool(f, pool, a, b, fee);
        found++;
      });
      // Adaptive throttle — delay doubles while batches keep failing,
      // decays back to base on clean batches. Cap 2s.
      delay = failures > 10
        ? Math.min(delay * 2, 2_000)
        : Math.max(cfg.DISCOVERY_BATCH_DELAY_MS, Math.floor(delay / 2));
      if (i + cfg.DISCOVERY_BATCH_SIZE < combos.length) await sleep(delay);
    }
    return found;
  }

  private upsertPool(f: FactoryRef, pool: string, a: DiscoveredToken, b: DiscoveredToken, fee?: number) {
    if (breaker.isConvicted(this.chain.key, pool)) return;
    const [t0, t1] = [a, b].sort((x, y) => x.address.toLowerCase().localeCompare(y.address.toLowerCase()));
    registry.upsert({
      address: pool,
      chain: this.chain.key,
      dexId: f.name,
      kind: f.kind,
      token0: t0.address, token1: t1.address,
      symbol0: t0.symbol, symbol1: t1.symbol,
      dec0: t0.decimals, dec1: t1.decimals,
      feeBps: f.kind === 'v3' ? (fee ?? 3000) / 100 : f.defaultFeeBps,
      liquidityUsd: 0, // unknown until a feed enriches; graph still quotes it
    });
  }

  /** Steady-state phase — scan factory creation events since last block. */
  async scanNewPools(): Promise<number> {
    const factories = factoriesFor(this.chain.key);
    if (!factories.length) return 0;
    const head = await this.rpc.blockNumber().catch(() => 0);
    const last = this.lastFactoryBlock.get(this.chain.key) ?? head - 50;
    if (head <= last) return 0;
    this.lastFactoryBlock.set(this.chain.key, head);

    const logs = await this.rpc.call<{ topics: string[]; address: string; data: string }[]>(
      'eth_getLogs',
      [{
        fromBlock: ethers.toBeHex(last),
        toBlock: ethers.toBeHex(head),
        address: factories.map((f) => f.address),
        topics: [[POOL_CREATED_TOPIC, PAIR_CREATED_TOPIC]],
      }],
    ).catch(() => [] as never);

    let added = 0;
    for (const l of logs) {
      try {
        const factory = factories.find((f) => f.address.toLowerCase() === l.address.toLowerCase());
        if (!factory) continue;
        if (l.topics[0] === POOL_CREATED_TOPIC) {
          const ev = POOL_CREATED_ABI.decodeEventLog('PoolCreated', l.data, l.topics);
          const a = this.token(ev.token0); const b = this.token(ev.token1);
          if (!a || !b) { await this.learnToken(ev.token0); await this.learnToken(ev.token1); }
          const ta = this.tokens.get(ev.token0.toLowerCase()); const tb = this.tokens.get(ev.token1.toLowerCase());
          if (ta && tb) { this.upsertPool(factory, ev.pool, ta, tb, Number(ev.fee)); added++; }
        } else {
          const ev = PAIR_CREATED_ABI.decodeEventLog('PairCreated', l.data, l.topics);
          await this.learnToken(ev.token0); await this.learnToken(ev.token1);
          const ta = this.tokens.get(ev.token0.toLowerCase()); const tb = this.tokens.get(ev.token1.toLowerCase());
          if (ta && tb) { this.upsertPool(factory, ev.pair, ta, tb); added++; }
        }
      } catch (e) {
        log.debug('creation-log decode failed', e);
      }
    }
    if (added) log.info(`${this.chain.key}: ${added} new pools discovered on-chain`);
    return added;
  }

  private token(addr: string) { return this.tokens.get(addr.toLowerCase()); }

  /** Learn an unknown token on-chain (decimals+symbol) when a new pool
   *  references one not yet in any list. */
  private async learnToken(addr: string): Promise<void> {
    const k = addr.toLowerCase();
    if (this.tokens.has(k)) return;
    const ABI = new ethers.Interface([
      'function decimals() view returns (uint8)',
      'function symbol() view returns (string)',
    ]);
    try {
      const [dec, sym] = await Promise.all([
        this.rpc.callContract(addr, ABI.encodeFunctionData('decimals')),
        this.rpc.callContract(addr, ABI.encodeFunctionData('symbol')).catch(() => '0x'),
      ]);
      const decimals = Number(ABI.decodeFunctionResult('decimals', dec)[0]);
      let symbol = k.slice(0, 8);
      try { symbol = ABI.decodeFunctionResult('symbol', sym)[0] as string; } catch { /* keep short */ }
      this.tokens.set(k, { address: addr, symbol, decimals, chainId: this.chain.chainId });
    } catch { /* untradeable token — ignore */ }
  }

  /** Periodic rescan driver. */
  startLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scanNewPools(), cfg.DISCOVERY_RESCAN_SECS * 1000);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  get tokenCount() { return this.tokens.size; }
}
