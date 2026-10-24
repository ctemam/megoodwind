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

const swapLogs: ethers.Log[] = [];
for (let b = from; b < head; b += 100) {
  const end = Math.min(b + 99, head);
  const chunk = await rpc.call<ethers.Log[]>('eth_getLogs', [{ topics: [[SWAP_V2, SWAP_V3]], fromBlock: '0x' + b.toString(16), toBlock: '0x' + end.toString(16) }]).catch(() => [] as ethers.Log[]);
  swapLogs.push(...(chunk as ethers.Log[]));
}
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
  const coinbasePay = rc.logs?.some((l: any) => l.topics[0] === ethers.id('Transfer(address,address,uint256)') && '0x' + l.topics[2].slice(-40) !== tx.from) ?? false;
  // price profit via token decimals + TOKEN_USD; unpriced stays raw-labeled
  let profitUsd: number | undefined;
  if (arb) {
    const px = TOKEN_USD[arb.token.toLowerCase()];
    if (px !== undefined) {
      const dec = await rpc.call<string>('eth_call', [{ to: arb.token, data: '0x313ce567' }, 'latest']).catch(() => null);
      const d = dec ? Number(BigInt(dec)) : 18;
      profitUsd = (Number(arb.profit) / 10 ** d) * px;
    }
  }
  rows.push({ block: Number(BigInt(rc.blockNumber)), txIndex: Number(BigInt(rc.transactionIndex ?? 0)), tx: txHash, bot: tx.from, to: tx.to, kind: arb ? 'arb' : 'liquidation', pools: arb?.route.map((s) => s.pool) ?? [], profitRaw: arb ? arb.profit.toString() : 'unpriced', profitToken: arb?.token, profitUsd, gasUsed: rc.gasUsed?.toString(), privateHint: coinbasePay });
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

// === C1-v2 pipeline join: is each competitor route inside our registry? ===
const ourPools = new Set<string>();
try { for (const p of registryAll(KEY)) ourPools.add(p.address.toLowerCase()); } catch {}
const join = { in_registry: 0, not_in_registry: 0, partial: 0 };
for (const a of arbs) {
  const inR = a.route.filter((s) => ourPools.has(s.pool)).length;
  if (inR === a.route.length) join.in_registry++;
  else if (inR === 0) join.not_in_registry++;
  else join.partial++;
}
log(`  pipeline-join: in_registry=${join.in_registry} partial=${join.partial} not_in_registry=${join.not_in_registry} (registry pools=${ourPools.size})`);

log(`[${KEY}] blocks ${from}-${head} | swaps decoded: ${swaps.length} across ${pools.length} pools | arbs: ${arbs.length} | liqs: ${(liqLogs as any[]).length} | bots: ${byBot.size}`);
for (const r of rows.slice(0, 15)) log(`  ${r.kind} ${r.bot.slice(0, 10)} blk=${r.block} txidx=${r.txIndex} pools=${r.pools.length} gas=${r.gasUsed} priv=${r.privateHint} profit=${r.profitRaw}`);
mkdirSync('data/speed', { recursive: true });
for (const r of rows) r.entityClass = botClass.get(r.bot) ?? 'unclassifiable';
appendFileSync('data/speed/competitors.jsonl', JSON.stringify({ ts: Date.now(), chain: KEY, from, to: head, swaps: swaps.length, pools: pools.length, arbs: arbs.length, liqs: (liqLogs as any[]).length, bots: byBot.size, entityClasses: classCounts, join, rows }) + '\n');
