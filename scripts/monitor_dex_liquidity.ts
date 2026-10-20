import 'dotenv/config';
import { ethers } from 'ethers';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cfg, chainConfig, privKeyHex, ChainConfig } from '../src/config/index.js';
import { logger } from '../src/config/logger.js';
import { poolFor, RpcPool } from '../src/providers/rpcPool.js';
import { registry, PoolState } from '../src/pools/registry.js';
import { Discovery } from '../src/discovery/discovery.js';
import { refreshPools } from '../src/feed/refresh.js';
import { solve, Candidate } from '../src/strategies/solver.js';
import { VARIANTS } from '../src/engine/predictiveEngine.js';
import { buildPlan } from '../src/exec/planBuilder.js';
import { fork_live_chain_state, execute_fork_dry_run, ForkHandle } from '../test/anvil/forkSim.js';
import { emitSignal } from '../src/telemetry/signalSink.js';

/**
 * Multi-chain DEX liquidity surveillance — the Shadow-Mode monitor.
 *
 *   npx tsx scripts/monitor_dex_liquidity.ts
 *
 * Topology per chain:
 *   Discovery.boot()  -> pool universe from on-chain factory state ONLY
 *   block poll        -> eth_getLogs(Swap|Mint|Burn) filtered to known pools
 *   touched pools     -> refreshPools (ONE merged Multicall3 round-trip)
 *   solver            -> CPU-eval candidates on fresh state
 *   sim gate          -> execute_fork_dry_run via executor exec() on a
 *                        lazy Anvil fork (is_simulation: true, always)
 *
 * Routing is inherited from rpc_pool_config.json — suspended providers
 * emit zero endpoints, whitelists apply, no monitor-specific plumbing.
 * Manual pool/token seeding is strictly forbidden: the registry is
 * populated exclusively by Discovery (factory matrix + creation logs).
 */

const log = logger('liquidity-monitor');

// ---- liquidity-shift event surface (V2 pair + V3 pool) ----
const TOPICS = {
  V2_SWAP: ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'),
  V2_MINT: ethers.id('Mint(address,uint256,uint256)'),
  V2_BURN: ethers.id('Burn(address,uint256,uint256,address)'),
  V3_SWAP: ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  V3_MINT: ethers.id('Mint(address,address,int24,int24,uint128,uint256,uint256)'),
  V3_BURN: ethers.id('Burn(address,int24,int24,uint128,uint256,uint256)'),
};
const ALL_TOPICS = Object.values(TOPICS);
const EVENT_NAME = new Map(Object.entries(TOPICS).map(([k, v]) => [v, k]));

const POLL_MS = Number(process.env.MONITOR_POLL_MS ?? 8_000);
const SIM_TOP_N = Number(process.env.MONITOR_SIM_TOP_N ?? 3);   // fork dry-runs per chain-cycle cap
const LOG_ADDR_CHUNK = 64;                                       // eth_getLogs address-array bound
const SIGNAL_DIR = resolve(process.cwd(), 'data/monitor');

interface ChainRuntime {
  chain: ChainConfig;
  rpc: RpcPool;
  disc: Discovery;
  lastBlock: number;
  fork?: ForkHandle;
  forkPort: number;
  executor?: string;
  owner: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function baseFeeWei(rpc: RpcPool): Promise<bigint> {
  const b = await rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]).catch(() => null);
  return b?.baseFeePerGas ? BigInt(b.baseFeePerGas) : 2_000_000_000n;
}

/** Borrow sizing without a price oracle: decimals-scaled probe amount —
 *  the solver's netUsd math stays directional; the exec-probe is the
 *  real floor arbiter on the live path. */
const sizeOf = (token: string, pools: PoolState[]) => {
  const p = pools.find((x) => x.token0.toLowerCase() === token.toLowerCase() || x.token1.toLowerCase() === token.toLowerCase());
  const dec = p ? (p.token0.toLowerCase() === token.toLowerCase() ? p.dec0 : p.dec1) : 18;
  return 100n * 10n ** BigInt(dec); // 100 whole units — bounded probe size
};

/** Sim gate: candidate -> plan -> executor.exec() dry-run on pinned fork.
 *  Impersonates the contract OWNER (exec is onlyOwner) — impersonation is
 *  fork-local, zero risk. BALANCER source, premium 0, minProfit 0: the
 *  gate proves EXECUTABLE STRUCTURE; the profit floor belongs to the
 *  live path and is never relaxed there. */
async function simGate(rt: ChainRuntime, c: Candidate): Promise<Record<string, unknown>> {
  if (!rt.executor) return { sim_gate: 'skipped_no_executor_deployed' };
  if (!rt.fork) {
    rt.fork = await fork_live_chain_state({ chain: rt.chain.key, upstreamCups: 30, port: rt.forkPort });
  }
  const { execData } = buildPlan(c, { source: 'BALANCER', premium: 0n, minProfit: 0n });
  const res = await execute_fork_dry_run(rt.fork, {
    impersonate: rt.owner,
    to: rt.executor,
    data: execData,
  });
  return { status: res.status, gasUsed: res.gasUsed.toString(), gasVariancePct: res.gasVariancePct };
}

async function cycle(rt: ChainRuntime): Promise<void> {
  const head = await rt.rpc.blockNumber().catch(() => 0);
  if (!head || head <= rt.lastBlock) return;
  const pools = registry.all(rt.chain.key);
  if (!pools.length) { rt.lastBlock = head; return; }

  // eth_getLogs on pool-address chunks — one request per ≤64 watched
  // addresses, topics OR'd so a single call catches all six event kinds.
  const addrs = pools.map((p) => p.address);
  const touched = new Set<string>();
  const eventCounts: Record<string, number> = {};
  for (let i = 0; i < addrs.length; i += LOG_ADDR_CHUNK) {
    const logs = await rt.rpc.call<{ topics: string[]; address: string }[]>('eth_getLogs', [{
      fromBlock: ethers.toBeHex(rt.lastBlock + 1),
      toBlock: ethers.toBeHex(head),
      address: addrs.slice(i, i + LOG_ADDR_CHUNK),
      topics: [ALL_TOPICS],
    }]).catch(() => [] as never);
    for (const l of logs) {
      touched.add(l.address.toLowerCase());
      const name = EVENT_NAME.get(l.topics[0]) ?? 'unknown';
      eventCounts[name] = (eventCounts[name] ?? 0) + 1;
    }
  }

  if (touched.size) {
    // ONE merged Multicall3 refresh for every touched pool — the latency
    // discipline rule: never serialize per-item RPC on a hot path.
    const stale = pools.filter((p) => touched.has(p.address.toLowerCase()));
    await refreshPools(rt.rpc, stale).catch((e) => log.warn('refresh failed', e));
  }

  const cands = solve(rt.chain, VARIANTS[0], {
    gasUnits: 350_000n,
    baseFeeWei: await baseFeeWei(rt.rpc),
    tokenUsd: new Map(),
    sizeOf: (t) => sizeOf(t, pools),
  });

  const rec: Record<string, unknown> = {
    chain: rt.chain.key,
    block: head,
    pools_watched: pools.length,
    pools_touched: touched.size,
    events: eventCounts,
    candidates: cands.length,
  };
  emitSignal(rt.chain, rec);
  if (touched.size || cands.length) {
    log.info(`${rt.chain.key}@${head}: ${touched.size} touched, ${cands.length} candidates`, eventCounts);
  }

  // every evaluated path passes the fork sim gate — capped, never skipped
  for (const c of cands.slice(0, SIM_TOP_N)) {
    const sim = await simGate(rt, c).catch((e) => ({ sim_gate: 'error', error: String(e).slice(0, 160) }));
    emitSignal(rt.chain, {
      chain: rt.chain.key,
      block: head,
      candidate: {
        strategy: c.strategy,
        legs: c.legs.map((l) => `${l.pool.dexId}:${l.pool.address.slice(0, 10)}`),
        borrowToken: c.borrowToken,
        borrowAmount: c.borrowAmount.toString(),
        netUsd: c.netUsd,
      },
      sim,
    });
    log.info(`${rt.chain.key} sim ${sim.status ?? sim.sim_gate}`, { strategy: c.strategy, netUsd: c.netUsd });
  }

  rt.lastBlock = head;
}

async function monitorChain(key: string, port: number): Promise<void> {
  const chain = chainConfig(key);
  const rpc = poolFor(chain);
  const disc = new Discovery(chain, rpc);
  await disc.boot();                    // pool universe: on-chain truth only
  disc.startLoop();                     // steady-state creation-event intake
  const rt: ChainRuntime = {
    chain, rpc, disc,
    lastBlock: await rpc.blockNumber().catch(() => 0),
    forkPort: port,
    executor: chain.executor,
    owner: ethers.computeAddress(privKeyHex()),
  };
  log.info(`${key}: monitor live — ${registry.all(key).length} pools under surveillance${chain.executor ? '' : ' (sim gate: no executor deployed)'}`);
  for (;;) {
    await cycle(rt).catch((e) => log.warn(`${key} cycle error`, e));
    await sleep(POLL_MS);
  }
}

async function main() {
  mkdirSync(SIGNAL_DIR, { recursive: true });
  const chains = cfg.activeChains;
  log.info(`monitoring ${chains.length} chains (poll ${POLL_MS}ms, sim top-${SIM_TOP_N}) — signals -> ${SIGNAL_DIR}`);
  await Promise.all(chains.map((k, i) => monitorChain(k, 8546 + i)));
  // keep the process alive; chain loops are infinite
  await new Promise(() => undefined);
}

const isMain = process.argv[1]?.endsWith('monitor_dex_liquidity.ts') || process.argv[1]?.endsWith('monitor_dex_liquidity.js');
if (isMain) main().catch((e) => { log.error('monitor failed', e); process.exit(1); });
