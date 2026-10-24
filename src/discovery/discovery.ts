import { ethers } from 'ethers';
import { ChainConfig, cfg } from '../config/index.js';
import { logger } from '../config/logger.js';
import { RpcPool } from '../providers/rpcPool.js';
import { multicall } from '../providers/multicall.js';
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
  private abandonedChunks = 0;

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

    // Phase 0: COMPTOOL discovery priority — visibility-failure pools enumerated FIRST
    // (Phase B-a consumer; empty/stale evidence → fallback = normal order, documented)
    try {
      const { discoveryPriority } = await import('../ci/discoveryPriority.js');
      const pri = discoveryPriority(undefined, this.chain.key);
      if (pri.verdict === 'evidence') {
        const missing = pri.priorityPools.filter((p) => !registry.all(this.chain.key).some((x: any) => x.address.toLowerCase() === p.toLowerCase()));
        log.info(`${this.chain.key} COMPTOOL priority: ${missing.length}/${pri.priorityPools.length} visibility-gap pools (n=${pri.sourceRecords} recs, age=${(pri.storeAgeMs / 3600000).toFixed(1)}h)`);
        // verify each priority pool exists + resolve tokens before registering — evidence ≠ eligibility
        const T_ABI = new (await import('ethers')).Interface(['function token0() view returns (address)', 'function token1() view returns (address)']);
        for (const p of missing.slice(0, 50)) {
          const code = await this.rpc.call<string>('eth_getCode', [p, 'latest']).catch(() => '0x');
          if (code === '0x') continue;
          try {
            const t0 = T_ABI.decodeFunctionResult('token0', await this.rpc.call<string>('eth_call', [{ to: p, data: T_ABI.encodeFunctionData('token0') }, 'latest']))[0];
            const t1 = T_ABI.decodeFunctionResult('token1', await this.rpc.call<string>('eth_call', [{ to: p, data: T_ABI.encodeFunctionData('token1') }, 'latest']))[0];
            registry.upsert({ chain: this.chain.key, address: p.toLowerCase(), token0: t0, token1: t1, source: 'comptool_priority' } as any);
            found++;
          } catch { /* non-standard pool shape → skip, not a failure */ }
        }
      }
    } catch { /* COMPTOOL absent → normal boot; never blocks discovery */ }

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

    log.info(`${this.chain.key} discovery boot: ${tokens.length} tokens, ${found} pools, ${(performance.now() - t0).toFixed(0)}ms${this.abandonedChunks ? ` abandonedChunks=${this.abandonedChunks}` : ''}`);
    // WO-7: zero pools with live tokens+factories is a BOOT FAILURE, not
    // a quiet empty universe — log loudly and retry boot up to 3 times
    // with backoff; steady-state scanNewPools keeps re-seeding after.
    if (found === 0 && tokens.length > 0 && factories.length > 0) {
      for (let retry = 1; retry <= 3 && registry.all(this.chain.key).length === 0; retry++) {
        const wait = retry * 30_000;
        log.error(`${this.chain.key} DISCOVERY_BOOT_EMPTY — 0 pools on ${tokens.length} tokens × ${factories.length} factories; retry ${retry}/3 in ${wait / 1000}s`);
        await sleep(wait);
        for (const f of factories) {
          found += await this.verifyPairs(f, candidatePairs);
          found += await this.factoryMatrix(f, tokens.slice(0, 12));
        }
        if (found > 0) log.info(`${this.chain.key} discovery boot recovered on retry ${retry}: ${found} pools`);
      }
      if (found === 0) log.error(`${this.chain.key} DISCOVERY_BOOT_EMPTY persists after retries — universe stays empty; steady-state scan will re-seed`);
    }
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
      // velodrome probes BOTH slots (volatile + stable) per pair — track
      // which call belongs to which combo for the results walk.
      const calls: { to: string; data: string; ci: number; stable?: boolean }[] = [];
      for (let ci = 0; ci < chunk.length; ci++) {
        const c = chunk[ci];
        const enc = (frag: string, stable?: boolean) => calls.push({ to: f.address, data: frag, ci, stable });
        if (f.kind === 'v3') enc(FACTORY_ABI.encodeFunctionData('getPool(address,address,uint24)', [c.a.address, c.b.address, c.fee]));
        else if (f.kind === 'velodrome') {
          enc(FACTORY_ABI.encodeFunctionData('getPool(address,address,bool)', [c.a.address, c.b.address, false]), false);
          enc(FACTORY_ABI.encodeFunctionData('getPool(address,address,bool)', [c.a.address, c.b.address, true]), true);
        } else if (f.kind === 'algebra') enc(FACTORY_ABI.encodeFunctionData('poolByPair', [c.a.address, c.b.address]));
        else enc(FACTORY_ABI.encodeFunctionData('getPair', [c.a.address, c.b.address]));
      }
      // Multicall3: the whole chunk is ONE aggregate3 eth_call — ~200x
      // fewer requests on the factory matrix. WO-7: a majority-transport-
      // failed chunk is RETRIED with exponential backoff (each attempt
      // lands on a different provider account via the budget scheduler) —
      // returning '0x' for rate-limited chunks made a dead-universe look
      // like an empty one (base discovered "0 pools" this way).
      let results: string[] | null = null;
      let transportFail = 0;
      for (let attempt = 0; attempt <= 4 && results === null; attempt++) {
        transportFail = 0;
        const r = await multicall(this.rpc, calls, calls.length, () => transportFail++);
        if (transportFail <= calls.length * 0.5) { results = r; break; }
        if (attempt < 4) await sleep(Math.min(500 * 2 ** attempt, 8_000));
      }
      if (results === null) {
        this.abandonedChunks++;
        log.warn(`${this.chain.key} discovery chunk abandoned after 5 tries (${calls.length} combos, ${f.address.slice(0, 10)})`);
        continue; // skip the chunk, don't abort the boot
      }
      let failures = transportFail;
      const chunkPools: string[] = [];
      results.forEach((value, k) => {
        if (value === '0x' || value.length < 66) return;
        const pool = ethers.getAddress(`0x${value.slice(-40)}`);
        if (pool === ZERO) return;
        const { a, b, fee } = chunk[calls[k].ci];
        this.upsertPool(f, pool, a, b, fee, calls[k].stable);
        chunkPools.push(pool);
        found++;
      });
      breaker.checkRealVolumes(this.chain.key, chunkPools); // ONE batched Bitquery query per chunk
      // WO-9: velodrome pools get their REAL per-pool fee on-chain —
      // factory.getFee(pool, stable) returns bps (100 = 1%); the 30bps
      // default produced 3x out-demand and K() reverts.
      if (f.kind === 'velodrome' && chunkPools.length) await this.readRealFees(f, chunkPools);
      // Adaptive throttle — delay doubles while batches keep failing,
      // decays back to base on clean batches. Cap 2s.
      delay = failures > 10
        ? Math.min(delay * 2, 2_000)
        : Math.max(cfg.DISCOVERY_BATCH_DELAY_MS, Math.floor(delay / 2));
      if (i + cfg.DISCOVERY_BATCH_SIZE < combos.length) await sleep(delay);
    }
    return found;
  }

  private upsertPool(f: FactoryRef, pool: string, a: DiscoveredToken, b: DiscoveredToken, fee?: number, stable?: boolean) {
    if (breaker.isConvicted(this.chain.key, pool)) return;
    breaker.checkReputation(this.chain.key, pool); // async explorer verdict — convicts scam-flagged addresses
    const [t0, t1] = [a, b].sort((x, y) => x.address.toLowerCase().localeCompare(y.address.toLowerCase()));
    registry.upsert({
      address: pool,
      chain: this.chain.key,
      dexId: f.name,
      kind: f.kind === 'v3' || f.kind === 'algebra' ? 'v3' : 'v2',
      token0: t0.address, token1: t1.address,
      symbol0: t0.symbol, symbol1: t1.symbol,
      dec0: t0.decimals, dec1: t1.decimals,
      feeBps: f.kind === 'v3' ? (fee ?? 3000) / 100 : f.defaultFeeBps,
      stable: f.kind === 'velodrome' ? stable : undefined,
      selfQuote: f.kind === 'velodrome' ? true : undefined,
      liquidityUsd: 0, // unknown until a feed enriches; graph still quotes it
    });
  }

  /** WO-9 — real per-pool fee for velodrome-kind pools, one multicall. */
  private async readRealFees(f: FactoryRef, pools: string[]): Promise<void> {
    const GET_FEE = 'function getFee(address,bool) view returns (uint256)';
    const iface = new ethers.Interface([GET_FEE]);
    const keyed = pools.map((p) => {
      const st = registry.get(`${this.chain.key}:${p.toLowerCase()}`);
      return { pool: p, stable: st?.stable ?? false };
    });
    const calls = keyed.map((k) => ({ to: f.address, data: iface.encodeFunctionData('getFee', [k.pool, k.stable]), ci: 0 }));
    const res = await multicall(this.rpc, calls, calls.length).catch(() => null);
    if (!res) return;
    res.forEach((v, i) => {
      if (v.length < 66) return;
      const fee = Number(BigInt(v));
      const st = registry.get(`${this.chain.key}:${keyed[i].pool.toLowerCase()}`);
      if (st && fee > 0 && fee < 10_000) st.feeBps = fee;
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
      const [dec, sym] = await multicall(this.rpc, [
        { to: addr, data: ABI.encodeFunctionData('decimals') },
        { to: addr, data: ABI.encodeFunctionData('symbol') },
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
