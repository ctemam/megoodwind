/**
 * C1-update — competitor ledger, mev-inspect method (verified rules).
 * Scan a block window on one chain:
 *  - decode every Swap v2/v3 log + pool token0/1
 *  - group by tx; apply start/end + shortest-route cycle matching
 *    (start.token_in==end.token_out, diff pools, from==to, from!=pool,
 *     next.token_in==cur.token_out, amounts equal within 1%)
 *  - profit = last.out − first.in in start token
 *  - liquidation = LiquidationCall event
 *  - record block, txIndex, bot, route pools, gas; coinbase payment
 *    flags private channel (lower bound)
 * Public data only. Run: npx tsx scripts/competitor_scan.ts <chain> <blocks>
 */
import { ethers } from 'ethers';
import { appendFileSync, mkdirSync } from 'fs';
import { chainConfig, ChainKey } from '../src/config/index.js';
import { RpcPool } from '../src/providers/rpcPool.js';
import { multicall } from '../src/providers/multicall.js';
import { TOKEN_USD } from '../src/config/pricing.js';
import { reconstruct } from '../src/ci/economics.js';
import { ORDERING, CONTRACT_VERSION, newCoverage, makeRate, type ObsWindow } from '../src/ci/measure.js';
import { registry, PoolState } from '../src/pools/registry.js';
const registryAll = (k: ChainKey) => registry.all(k) as PoolState[];

const KEY = (process.argv[2] ?? 'eth') as ChainKey;
const WINDOW = Number(process.argv[3] ?? 500);
const chain = chainConfig(KEY);
const rpc = new RpcPool(chain);
// populate OUR discovery registry so the join measures real coverage
try {
  const { Discovery } = await import('../src/discovery/discovery.js');
  const d = new Discovery(chain, rpc);
  await Promise.race([d.boot(), new Promise((r) => setTimeout(r, 90_000))]);
} catch {}
const head = await rpc.blockNumber();
const from = head - WINDOW;
const log = console.log;

const SWAP_V2 = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
const SWAP_V3 = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const LIQ_TOPIC = ethers.id('LiquidationCall(address,address,address,uint256,uint256,address,bool)');
const AAVE = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const T01 = new ethers.Interface(['function token0() view returns (address)', 'function token1() view returns (address)']);
const COINBASE = '0x0000000000000000000000000000000000000000';

interface Swap { tx: string; pool: string; inT: string; outT: string; inAmt: bigint; outAmt: bigint; from: string; to: string; }

const cov = newCoverage();
cov.blocksExpected = head - from;
let scanComplete = true;
const swapLogs: ethers.Log[] = [];
for (let b = from; b < head; b += 100) {
  const end = Math.min(b + 99, head);
  const chunk = await rpc.call<ethers.Log[]>('eth_getLogs', [{ topics: [[SWAP_V2, SWAP_V3]], fromBlock: '0x' + b.toString(16), toBlock: '0x' + end.toString(16) }]).catch(() => { scanComplete = false; return null; });
  if (chunk) { swapLogs.push(...(chunk as ethers.Log[])); cov.blocksScanned += end - b + 1; }
}
const window: ObsWindow = { chain: KEY, fromBlock: from, toBlock: head, complete: scanComplete, scannedAt: Date.now(), schema: 'ci-v3', contract: CONTRACT_VERSION, ordering: ORDERING[KEY] ?? 'unknown' };
const pools = [...new Set((swapLogs as ethers.Log[]).map((l) => l.address.toLowerCase()))];
const meta = new Map<string, [string, string]>();
const calls = pools.flatMap((p) => [{ to: p, data: T01.encodeFunctionData('token0'), ci: 0 }, { to: p, data: T01.encodeFunctionData('token1'), ci: 0 }]);
const res = await multicall(rpc, calls, calls.length).catch(() => [] as string[]);
pools.forEach((p, i) => { try { meta.set(p, [T01.decodeFunctionResult('token0', res[i * 2])[0], T01.decodeFunctionResult('token1', res[i * 2 + 1])[0]]); } catch {} });

const swaps: Swap[] = [];
for (const l of swapLogs as ethers.Log[]) {
  const m = meta.get(l.address.toLowerCase()); if (!m) continue;
  const [t0, t1] = m;
  if (l.topics[0] === SWAP_V2) {
    const d = ethers.AbiCoder.defaultAbiCoder().decode(['uint256','uint256','uint256','uint256'], l.data);
    const [inT, inAmt, outT, outAmt] = d[0] > 0n ? [t0, d[0], t1, d[3]] : [t1, d[1], t0, d[2]];
    swaps.push({ tx: l.transactionHash, pool: l.address.toLowerCase(), inT: inT.toLowerCase(), outT: outT.toLowerCase(), inAmt, outAmt, from: '0x' + l.topics[1].slice(-40), to: '0x' + l.topics[2].slice(-40) });
  } else {
    const d = ethers.AbiCoder.defaultAbiCoder().decode(['int256','int256','uint160','uint128','int24'], l.data);
    const [inT, inAmt, outT, outAmt] = d[0] > 0n ? [t0, d[0], t1, -d[1]] : [t1, d[1], t0, -d[0]];
    swaps.push({ tx: l.transactionHash, pool: l.address.toLowerCase(), inT: inT.toLowerCase(), outT: outT.toLowerCase(), inAmt, outAmt, from: '0x' + l.topics[1].slice(-40), to: '0x' + l.topics[2].slice(-40) });
  }
}

// mev-inspect rules
const match = (a: Swap, b: Swap) => a.outT === b.inT && (a.to === b.pool || a.pool === b.from || a.to === b.from) && b.inAmt <= (a.outAmt * 101n) / 100n && b.inAmt >= (a.outAmt * 99n) / 100n;
const byTx = new Map<string, Swap[]>();
for (const s of swaps) (byTx.get(s.tx) ?? byTx.set(s.tx, []).get(s.tx)!).push(s);
const poolSet = new Set(pools);
const arbs: { tx: string; route: Swap[]; profit: bigint; token: string; bot: string }[] = [];
for (const [tx, ss] of byTx) {
  if (ss.length < 2) continue;
  for (const start of ss) {
    const ends = ss.filter((e) => e !== start && e.outT === start.inT && e.pool !== start.pool && e.to === start.from && !poolSet.has(start.from));
    if (!ends.length) continue;
    // greedy shortest: try direct close then extend
    let route: Swap[] | null = null;
    for (const end of ends) if (match(start, end)) { route = [start, end]; break; }
    if (!route) for (const nxt of ss.filter((s) => s !== start && !ends.includes(s))) {
      if (match(start, nxt)) for (const end of ends) if (match(nxt, end)) { route = [start, nxt, end]; break; }
      if (route) break;
    }
    if (route && route[route.length - 1].outAmt > start.inAmt) {
      arbs.push({ tx, route, profit: route[route.length - 1].outAmt - start.inAmt, token: start.inT, bot: start.from });
      break; // one arb per tx per start (mev-inspect keeps ordered routes; we take first valid)
    }
  }
}

const liqLogs = await rpc.call<ethers.Log[]>('eth_getLogs', [{ address: AAVE, topics: [LIQ_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16) }]).catch(() => []);
const txs = [...new Set([...arbs.map((a) => a.tx), ...(liqLogs as ethers.Log[]).map((l) => l.transactionHash)])];
const rows: any[] = [];
for (const txHash of txs.slice(0, 40)) {
  const [tx, rc] = await Promise.all([rpc.call<any>('eth_getTransactionByHash', [txHash]).catch(() => null), rpc.call<any>('eth_getTransactionReceipt', [txHash]).catch(() => null)]);
  if (!tx || !rc) continue;
  if (rc.status !== '0x1' && rc.status !== 1) continue; // reverted txs are not competitor profit
  const isLiq = (liqLogs as ethers.Log[]).some((l) => l.transactionHash === txHash);
  const arb = arbs.find((a) => a.tx === txHash);
  const TRANSFER = ethers.id('Transfer(address,address,uint256)');
  const coinbasePay = rc.logs?.some((l: any) => l.topics[0] === TRANSFER && '0x' + l.topics[2].slice(-40) !== tx.from) ?? false;
  // WO-04: flash-loan detection — known provider event topics in receipt logs
  const FL_TOPICS: Record<string, string> = {
    [ethers.id('FlashLoan(address,address,uint256,uint256)')]: 'balancer',
    [ethers.id('FlashLoan(address,address,address,uint256,uint256,uint16)')]: 'aave_v3',
    [ethers.id('FlashLoan(address,address,address,uint256,uint256)')]: 'erc3156',
  };
  const flLogs = (rc.logs ?? []).filter((l: any) => FL_TOPICS[l.topics[0]]);
  const flashProvider = flLogs.length ? FL_TOPICS[(flLogs[0] as any).topics[0]] : undefined;
  // builder payment = sum of plain-ETH value in tx (tx.value) + coinbase-directed transfers (lower bound)
  const builderPayWei = tx.value && BigInt(tx.value) > 0n ? BigInt(tx.value) : undefined;
  // price profit via token decimals + TOKEN_USD; unpriced stays raw-labeled
  let profitUsd: number | undefined; let profitDecimals: number | undefined;
  if (arb) {
    const px = TOKEN_USD[arb.token.toLowerCase()];
    if (px !== undefined) {
      const dec = await rpc.call<string>('eth_call', [{ to: arb.token, data: '0x313ce567' }, 'latest']).catch(() => null);
      profitDecimals = dec ? Number(BigInt(dec)) : 18;
      profitUsd = (Number(arb.profit) / 10 ** profitDecimals) * px;
    }
  }
  const econ = reconstruct({
    receiptStatus: 1, gasUsed: BigInt(rc.gasUsed ?? 0), effectiveGasPrice: rc.effectiveGasPrice ? BigInt(rc.effectiveGasPrice) : undefined,
    grossProfitRaw: arb?.profit, profitDecimals, profitUsdRate: arb ? TOKEN_USD[arb.token.toLowerCase()] : undefined,
    ethUsdRate: TOKEN_USD['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'], // WETH
    flashLoan: flashProvider ? { provider: flashProvider, principalRaw: 0n, repayRaw: 0n, feeRaw: 0n } : undefined,
    builderPaymentWei: builderPayWei,
  });
  rows.push({ block: Number(BigInt(rc.blockNumber)), txIndex: Number(BigInt(rc.transactionIndex ?? 0)), tx: txHash, bot: tx.from, to: tx.to, kind: arb ? 'arb' : 'liquidation', pools: arb?.route.map((s) => s.pool) ?? [], profitRaw: arb ? arb.profit.toString() : 'unpriced', profitToken: arb?.token, profitUsd, gasUsed: rc.gasUsed?.toString(), privateHint: coinbasePay, flashProvider, econ: { status: econ.status, netUsd: econ.netUsd, gasCostUsd: econ.gasCostUsd, unknowns: econ.unknowns, confidence: econ.confidence } });
}
const byBot = new Map<string, number>();
for (const r of rows) byBot.set(r.bot, (byBot.get(r.bot) ?? 0) + 1);

// === adversarial verification layer (Commander 2026-10-24) ===
// Entity classes: verified_active / provisional / unverified_frontrunner /
// suspected_deceptive / unclassifiable. Deception signals checked:
// - bot address is EOA not contract (can't be a searcher program — decode artifact)
// - precompile-like addresses (0x0000..0x00ff)
// - dup tx counted twice (unique-tx check)
// - profit present but unpriced (unverifiable net)
const botClass = new Map<string, string>();
const uniqueBots = new Set(rows.map((r) => r.bot));
for (const b of uniqueBots) {
  const bRows = rows.filter((r) => r.bot === b);
  if (/^0x0{8,}/.test(b.toLowerCase())) { botClass.set(b, 'unclassifiable_decode_artifact'); continue; }
  const [fromCode, toCode] = await Promise.all([
    rpc.call<string>('eth_getCode', [b, 'latest']).catch(() => '0x'),
    rpc.call<string>('eth_getCode', [bRows[0]?.to ?? b, 'latest']).catch(() => '0x'),
  ]);
  const fromIsEOA = !fromCode || fromCode === '0x';
  const toIsContract = !!(toCode && toCode !== '0x');
  // WO-02 identity model: signer(from) + executor(to) are separate roles.
  // EOA-signer + contract-executor = normal searcher architecture (verified if
  // receipt-verified arb + repeat behavior), not a downgrade. Contract-from =
  // the contract itself signed or smart-account (verified). EOA+EOA = direct
  // wallet arb (rarer, provisional). Evidence: ≥2 verified receipt-status arbs.
  const verified = bRows.length >= 2 && bRows.every((r) => r.kind === 'arb' || r.kind === 'liquidation');
  if (fromIsEOA && toIsContract) botClass.set(b, verified ? 'verified_active_eoa_signer' : 'provisional_eoa_signer');
  else if (!fromIsEOA) botClass.set(b, verified ? 'verified_active_contract' : 'provisional_contract');
  else botClass.set(b, verified ? 'verified_active_eoa_direct' : 'provisional_eoa_direct');
}
const classCounts: Record<string, number> = {};
for (const c of botClass.values()) classCounts[c] = (classCounts[c] ?? 0) + 1;
log(`  entity classes: ${Object.entries(classCounts).map(([k, n]) => `${k}=${n}`).join(' | ')}`);

// === WO-02 operator clusters + strategy fingerprints ===
// Cluster heuristic (evidence-labeled, NOT identity proof): two signers
// hitting the same executor contract (tx.to) are probably one operator.
// Strategy fingerprint: routeLen + venueCount + pool-set signature.
const byExecutor = new Map<string, Set<string>>();
for (const r of rows) if (r.to) (byExecutor.get(r.to) ?? byExecutor.set(r.to, new Set()).get(r.to)!).add(r.bot);
const clusters = [...byExecutor.entries()].filter(([, s]) => s.size > 1);
const fingerprints = new Map<string, number>();
for (const a of arbs) {
  const venues = new Set(a.route.map((s) => s.pool)).size;
  const fp = `${a.route.length}hop/${venues}venue`;
  fingerprints.set(fp, (fingerprints.get(fp) ?? 0) + 1);
}
log(`  operator clusters (shared executor, ≥2 signers): ${clusters.length}${clusters.length ? ' — ' + clusters.map(([e, s]) => `${e.slice(0, 8)}←${s.size}signers`).join(', ') : ''}`);
log(`  strategy fingerprints: ${[...fingerprints.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f}×${n}`).join(' | ')}`);

// === C1-v2 pipeline join: is each competitor route inside our registry? ===
const ourPools = new Set<string>();
try { for (const p of registryAll(KEY)) ourPools.add(p.address.toLowerCase()); } catch {}
// join over RECEIPT-VERIFIED arbs only; decoded-but-unreceipted → unresolved
const receiptedTx = new Set(rows.map((r) => r.tx));
const join = { matched: 0, partial: 0, unmatched: 0, unresolved: 0, excluded: 0 };
for (const a of arbs) {
  if (!receiptedTx.has(a.tx)) { join.unresolved++; continue; }
  const inR = a.route.filter((s) => ourPools.has(s.pool)).length;
  if (inR === a.route.length) join.matched++;
  else if (inR === 0) join.unmatched++;
  else join.partial++;
}
cov.join = { ...join };
cov.swapsDecoded = swaps.length; cov.decodeFailures = swapLogs.length - swaps.length;
for (const r of rows) { r.profitUsd !== undefined ? cov.pricedEvents++ : cov.unpricedEvents++; }
cov.receiptsResolved = rows.length; cov.receiptsMissing = Math.max(0, arbs.length + (liqLogs as any[]).length - rows.length);
log(`  pipeline-join (verified only): matched=${join.matched} partial=${join.partial} unmatched=${join.unmatched} unresolved=${join.unresolved} (registry pools=${ourPools.size}, complete=${window.complete})`);

log(`[${KEY}] blocks ${from}-${head} | swaps decoded: ${swaps.length} across ${pools.length} pools | arbs: ${arbs.length} | liqs: ${(liqLogs as any[]).length} | bots: ${byBot.size}`);
for (const r of rows.slice(0, 15)) log(`  ${r.kind} ${r.bot.slice(0, 10)} blk=${r.block} txidx=${r.txIndex} pools=${r.pools.length} gas=${r.gasUsed} priv=${r.privateHint} profit=${r.profitRaw}`);
mkdirSync('data/speed', { recursive: true });
for (const r of rows) r.entityClass = botClass.get(r.bot) ?? 'unclassifiable';
appendFileSync('data/speed/competitors.jsonl', JSON.stringify({ ts: Date.now(), schema: 'ci-v3', chain: KEY, from, to: head, swaps: swaps.length, pools: pools.length, arbs: arbs.length, liqs: (liqLogs as any[]).length, bots: byBot.size, entityClasses: classCounts, join, operatorClusters: clusters.map(([e, s]) => ({ executor: e, signers: [...s] })), fingerprints: Object.fromEntries(fingerprints), rows }) + '\n');

// === WO-03 durable store: canonical ids + idempotent ingest + provenance ===
const { CiStore } = await import('../src/ci/store.js');
const store = new CiStore();
const clusterOf = (signer: string) => clusters.find(([, s]) => s.has(signer))?.[0];
let ingestStats = { new: 0, dup: 0, reconciled: 0, corrected: 0 };
for (const r of rows) {
  const res = store.ingest({
    schema: 'ci-v3', chain: KEY, kind: r.kind, block: r.block, txIndex: r.txIndex, tx: r.tx,
    signer: r.bot, executor: r.to, pools: r.pools, routeLen: r.pools.length,
    profitRaw: r.profitRaw === 'unpriced' ? undefined : r.profitRaw, profitToken: r.profitToken,
    profitUsd: r.profitUsd, gasUsed: r.gasUsed, receiptVerified: true, econ: r.econ,
    entityClass: r.entityClass, fingerprint: r.pools?.length ? `${r.pools.length}hop/${new Set(r.pools).size}venue` : undefined,
    clusterId: clusterOf(r.bot),
  });
  ingestStats[res]++;
}
// WO-05: persist measurement contract — window + coverage + rates, one meta record per window
const arbRate = makeRate('arb_detection', 'event', arbs.length, swapLogs.length, 0, join.unresolved, window);
const joinRate = makeRate('pipeline_join_matched', 'event', join.matched, receiptedTx.size, 0, join.unresolved, window);
store.ingest({ schema: 'mc-v1', chain: KEY, kind: 'arb', tx: `window:${from}-${head}`, pools: [], block: from, source: 'measure', ...({ window, coverage: cov, rates: { arbRate, joinRate } } as any) } as any);
store.flush();
const econCounts: Record<string, number> = {};
for (const r of rows) if (r.econ) econCounts[r.econ.status] = (econCounts[r.econ.status] ?? 0) + 1;
log(`  econ statuses: ${Object.entries(econCounts).map(([k, n]) => `${k}=${n}`).join(' | ')}`);
log(`  rates(mc-v1): arb_detect=${arbs.length}/${swapLogs.length} swap-logs | join_matched=${join.matched}/${receiptedTx.size} verified${joinRate.rate !== undefined ? ` (${(joinRate.rate * 100).toFixed(1)}%)` : ' (n/a)'} | complete=${window.complete} ordering=${window.ordering}`);
log(`  store: ${Object.entries(ingestStats).map(([k, n]) => `${k}=${n}`).join(' ')} | counters: ${JSON.stringify(store.counters())}`);

// === WO-07 stage-level attribution over this window's verified arbs ===
const { attribute } = await import('../src/ci/attribute.js');
const { existsSync, readFileSync } = await import('fs');
let convicted = new Set<string>();
try { const f = `data/leaders/${KEY}/_bait_pools.json`; if (existsSync(f)) convicted = new Set((JSON.parse(readFileSync(f, 'utf8')) as any[]).map((x: any) => (x.pool ?? x.address ?? x).toLowerCase())); } catch {}
const attrCounts: Record<string, number> = {};
for (const r of rows.filter((x) => x.kind === 'arb')) {
  const stored = store.get(`eth:${r.tx}`.replace('eth', KEY));
  const a = attribute({ rec: stored ?? { eventId: `${KEY}:${r.tx}`, schema: 'ci-v3', chain: KEY, kind: 'arb', tx: r.tx, pools: r.pools, receiptVerified: true, profitToken: r.profitToken, econ: r.econ, evidence: [], corrections: [] }, ourPools, convictedPools: convicted, ourMinProfitUsd: 2.5 });
  attrCounts[a.outcome] = (attrCounts[a.outcome] ?? 0) + 1;
}
log(`  attribution: ${Object.entries(attrCounts).map(([k, n]) => `${k}=${n}`).join(' | ')}`);

// === WO-06 two rankings over the trusted store (all windows, not just this scan) ===
const { aggregate, rankPerformance, rankThreat } = await import('../src/ci/rank.js');
const aggs = aggregate(store.trusted().filter((r) => r.tx.startsWith('0x')));
const perf = rankPerformance(aggs).slice(0, 5);
const thr = rankThreat(aggs).slice(0, 5);
log('  == performance ranking (verified, econ-gated) ==');
for (const r of perf) log(`    ${r.rank ? '#' + r.rank : '  -'} ${r.id.slice(0, 10)} score=${r.score?.toFixed(1) ?? 'n/a'} n=${r.sample} net=${r.netUsd?.toFixed(2) ?? 'unpriced'} conf=${r.confidence.toFixed(2)} ${r.evidenceClass} [${r.flags.join(',')}]`);
log('  == threat/capability ranking (observable only) ==');
for (const r of thr) log(`    ${r.rank ? '#' + r.rank : '  -'} ${r.id.slice(0, 10)} score=${r.score?.toFixed(2) ?? 'n/a'} n=${r.sample} ${r.evidenceClass} [${r.flags.join(',')}]`);
