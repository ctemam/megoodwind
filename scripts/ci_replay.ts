/**
 * H-002 — pinned-block counterfactual replay of indeterminate attributions.
 * For each eligible case: fork Anvil at block-1, impersonate the original
 * sender, replay the ORIGINAL tx calldata. Success = the opportunity was
 * executable at that state (counterfactual feasibility evidence — still
 * estimated, not verified: we replay THEIR tx, not ours).
 * Run: npx tsx scripts/ci_replay.ts <chain> <maxCases>
 */
import { chainConfig, ChainKey } from '../src/config/index.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { CiStore } from '../src/ci/store.js';
import { attribute } from '../src/ci/attribute.js';
import { registry } from '../src/pools/registry.js';
import { fork_live_chain_state, execute_fork_dry_run } from '../test/anvil/forkSim.js';

const KEY = (process.argv[2] ?? 'eth') as ChainKey;
const MAX = Number(process.argv[3] ?? 3);
const chain = chainConfig(KEY);
const rpc = new RpcPool(chain);
const store = new CiStore();
try {
  const { Discovery } = await import('../src/discovery/discovery.js');
  await Promise.race([new Discovery(chain, rpc).boot(), new Promise((r) => setTimeout(r, 60_000))]);
} catch {}
const ourPools = new Set(registry.all(KEY).map((p: any) => p.address.toLowerCase()));

// eligible = indeterminate candidates: arb + in-registry/partial pools
const cases = store.trusted().filter((r) =>
  r.chain === KEY && r.kind === 'arb' && r.tx.startsWith('0x') &&
  r.pools?.length && r.pools.some((p) => ourPools.has(p.toLowerCase()))
).slice(0, MAX);
console.log(`[ci_replay] ${cases.length} eligible cases (of ${store.trusted().length} trusted)`);

let fork: Awaited<ReturnType<typeof fork_live_chain_state>> | null = null;
const results: { tx: string; block?: number; replayed: string; outcome: string; net?: number }[] = [];
try {
  for (const c of cases) {
    const tx = await rpc.call<any>('eth_getTransactionByHash', [c.tx]).catch(() => null);
    if (!tx || !c.block) { results.push({ tx: c.tx.slice(0, 10), block: c.block, replayed: 'no_tx_metadata', outcome: 'indeterminate' }); continue; }
    // fresh fork pinned at block-1 — state the searcher saw when deciding
    fork?.kill();
    fork = await fork_live_chain_state({ chain: KEY, blockNumber: c.block - 1, upstreamCups: 30 });
    // fund impersonated account deterministically + verify before replay
    await fork.rpc.send('anvil_impersonateAccount', [tx.from]).catch(() => {});
    for (const m of ['anvil_setBalance', 'hardhat_setBalance'])
      await fork.rpc.send(m, [tx.from, '0x56BC75E2D63100000']).catch(() => {});
    const bal = await fork.rpc.getBalance(tx.from).catch(() => 0n);
    if (bal === 0n) { results.push({ tx: c.tx.slice(0, 10), block: c.block, replayed: 'unfunded_env', outcome: 'indeterminate' }); console.log(`  ${c.tx.slice(0, 10)} — env funding failed, skipped`); continue; }
    const r = await execute_fork_dry_run(fork, { impersonate: tx.from, to: tx.to, data: tx.data ?? tx.input, valueWei: tx.value ? BigInt(tx.value) : 0n, gasLimit: tx.gas ? BigInt(tx.gas) : 3_000_000n, maxFeePerGas: 10_000_000_000n });
    const outcome = attribute({ rec: c, ourPools, ourMinProfitUsd: 2.5, replayed: { executable: r.status === 'PASS', netUsd: c.econ?.netUsd, reason: r.revertReason } }).outcome;
    results.push({ tx: c.tx.slice(0, 10), block: c.block, replayed: r.status, outcome, net: c.econ?.netUsd });
    console.log(`  ${c.tx.slice(0, 10)} blk=${c.block} replay=${r.status}${r.revertReason ? ' (' + r.revertReason.slice(0, 60) + ')' : ''} → ${outcome}`);
  }
} finally { fork?.kill(); }
console.log(`[ci_replay] done: ${results.map((r) => `${r.tx}=${r.outcome}`).join(' | ')}`);
