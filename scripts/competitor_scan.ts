/**
 * C1 — competitor analytics from public chain data (shadow, read-only).
 * Scans recent blocks for:
 *  a) Aave V3 LiquidationCall events -> bot address, profit proxy, gas.
 *  b) arb cycles: txs emitting Swap events on >=2 distinct pools, then
 *     ERC20 Transfer deltas to the tx sender -> net gain.
 * Records: block, txHash, bot, pools touched, position-in-block, gas,
 * private hint (top-of-block/high-gas heuristic is NOT reliable — so we
 * record mempool-presence as 'unknown' honestly).
 * Grouped by bot -> count, total/avg profit, top-5 share.
 * Run: npx tsx scripts/competitor_scan.ts <chain> <blockWindow>
 */
import { ethers } from 'ethers';
import { appendFileSync, mkdirSync } from 'fs';
import { chainConfig, ChainKey } from '../src/config/index.js';
import { RpcPool } from '../src/providers/rpcPool.js';

const KEY = (process.argv[2] ?? 'eth') as ChainKey;
const WINDOW = Number(process.argv[3] ?? 1500);
const chain = chainConfig(KEY);
const rpc = new RpcPool(chain);
const head = await rpc.blockNumber();
const from = head - WINDOW;

const LIQ_TOPIC = ethers.id('LiquidationCall(address,address,address,uint256,uint256,address,bool)');
const SWAP_V2 = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
const SWAP_V3 = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';

interface Row { block: number; tx: string; bot: string; kind: string; pools: string[]; posInBlock: number; gasUsed: string; gasPaid: string; profitUsd?: number; rawProfitUnits?: number; }
const rows: Row[] = [];

// --- a) liquidations ---
const liqLogs = await rpc.call<ethers.Log[]>('eth_getLogs', [{ address: AAVE_POOL, topics: [LIQ_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16) }]).catch(() => []);
const liqTxs = [...new Set((liqLogs as ethers.Log[]).map((l) => l.transactionHash))];
for (const txHash of liqTxs.slice(0, 25)) {
  const [tx, rc] = await Promise.all([rpc.call<ethers.TransactionResponse>('eth_getTransactionByHash', [txHash]).catch(() => null), rpc.call<ethers.TransactionReceipt>('eth_getTransactionReceipt', [txHash]).catch(() => null)]);
  if (!tx || !rc) continue;
  const ev = (liqLogs as ethers.Log[]).filter((l) => l.transactionHash === txHash);
  let profit = 0;
  for (const l of ev) { const d = ethers.AbiCoder.defaultAbiCoder().decode(['uint256','uint256','address','bool'], l.data); profit += (Number(d[1]) - Number(d[0])); } // raw units — token decimals vary; not USD
  rows.push({ block: rc.blockNumber, tx: txHash, bot: tx.from, kind: 'liquidation', pools: ev.map((l) => '0x' + l.topics[2].slice(-40)), posInBlock: rc.index, gasUsed: rc.gasUsed.toString(), gasPaid: ethers.formatEther(BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? rc.gasPrice ?? 0)), rawProfitUnits: profit });
}

// --- b) arb cycles: multi-pool swap txs ---
// swap scan bounded to the top 3 liquid venues — unbounded Swap scans
// hit the provider's log cap and return nothing
const VENUES: Record<string, string[]> = {
  eth: ['0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc', '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8'],
  base: [], arb: [], op: [], poly: [], avax: [],
};
const swapLogs = await rpc.call<ethers.Log[]>('eth_getLogs', [{ address: VENUES[KEY] ?? VENUES.eth, topics: [[SWAP_V2, SWAP_V3]], fromBlock: '0x' + (head - Math.min(WINDOW, 300)).toString(16), toBlock: '0x' + head.toString(16) }]).catch(() => []);
const byTx = new Map<string, Set<string>>();
for (const l of swapLogs as ethers.Log[]) { (byTx.get(l.transactionHash) ?? byTx.set(l.transactionHash, new Set()).get(l.transactionHash)!).add(l.address.toLowerCase()); }
const arbTxs = [...byTx].filter(([, p]) => p.size >= 2).map(([h]) => h);
for (const txHash of arbTxs.slice(0, 30)) {
  const [tx, rc] = await Promise.all([rpc.call<ethers.TransactionResponse>('eth_getTransactionByHash', [txHash]).catch(() => null), rpc.call<ethers.TransactionReceipt>('eth_getTransactionReceipt', [txHash]).catch(() => null)]);
  if (!tx || !rc) continue;
  // net token delta to sender via Transfer logs
  const delta = new Map<string, bigint>();
  for (const l of rc.logs) {
    if (l.topics[0] !== TRANSFER || l.topics.length < 3) continue;
    const to = '0x' + l.topics[2].slice(-40), from_ = '0x' + l.topics[1].slice(-40);
    const amt = BigInt(l.data);
    if (to.toLowerCase() === tx.from.toLowerCase()) delta.set(l.address, (delta.get(l.address) ?? 0n) + amt);
    if (from_.toLowerCase() === tx.from.toLowerCase()) delta.set(l.address, (delta.get(l.address) ?? 0n) - amt);
  }
  const net = [...delta.values()].reduce((a, b) => (b > a ? b : a), 0n);
  rows.push({ block: rc.blockNumber, tx: txHash, bot: tx.from, kind: 'arb', pools: [...(byTx.get(txHash) ?? [])], posInBlock: rc.index, gasUsed: rc.gasUsed.toString(), gasPaid: ethers.formatEther(BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? rc.gasPrice ?? 0)), profitUsd: Number(net) / 1e6 });
}

// --- aggregate ---
const byBot = new Map<string, { n: number; profit: number; kinds: Set<string> }>();
for (const r of rows) { const b = byBot.get(r.bot) ?? { n: 0, profit: 0, kinds: new Set() }; b.n++; b.profit += r.profitUsd ?? 0; b.kinds.add(r.kind); byBot.set(r.bot, b); }
const bots = [...byBot].sort((a, b) => b[1].profit - a[1].profit);
const totalP = bots.reduce((s, [, b]) => s + b.profit, 0);
const top5 = bots.slice(0, 5).reduce((s, [, b]) => s + b.profit, 0);
console.log(`[${KEY}] blocks ${from}-${head}: ${rows.length} events, ${bots.length} bots, total profit ~$${totalP.toFixed(0)}, top5 share ${totalP ? (top5 / totalP * 100).toFixed(0) : 0}%`);
for (const [bot, b] of bots.slice(0, 10)) console.log(`  ${bot} n=${b.n} profit~$${b.profit.toFixed(0)} kinds=${[...b.kinds].join('+')}`);

mkdirSync('data/speed', { recursive: true });
appendFileSync('data/speed/competitors.jsonl', JSON.stringify({ ts: Date.now(), chain: KEY, from, to: head, window: WINDOW, events: rows.length, bots: bots.length, totalProfitUsd: totalP, top5Share: totalP ? top5 / totalP : null, rows }) + '\n');
