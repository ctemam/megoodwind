/** WO-7 sanity probe — how many eth swaps land on peer-having pools,
 *  and whether ANY show a >10bps raw gap (backrun-detector validation). */
import { chainConfig } from '../src/config/index.js';
import { poolFor } from '../src/providers/rpcPool.js';
import { registry } from '../src/pools/registry.js';
import { Discovery } from '../src/discovery/discovery.js';
import { ethers } from 'ethers';

const RES_ABI = new ethers.Interface(['function getReserves() view returns (uint112,uint112,uint32)']);
const chain = chainConfig('eth'); const rpc = poolFor(chain);
const d = new Discovery(chain, rpc); await d.boot();
const pools = registry.all('eth').filter((p) => p.kind === 'v2');
const peers = new Map<string, typeof pools>();
for (const p of pools) {
  const s = [p.token0, p.token1].map((t) => t.toLowerCase()).sort().join(':');
  if (!peers.has(s)) peers.set(s, []);
  peers.get(s)!.push(p);
}
const groups = [...peers.values()].filter((g) => g.length > 1);
const withPeer = groups.flat().map((p) => p.address.toLowerCase());
console.log('v2 pools', pools.length, 'peer groups', groups.length, 'pools with peers', withPeer.length);
const head = await rpc.blockNumber();
const logs = await rpc.call<{ address: string; blockNumber: string; data: string }[]>('eth_getLogs', [{ fromBlock: '0x' + (head - 30).toString(16), toBlock: '0x' + head.toString(16), address: withPeer.slice(0, 40), topics: [[ethers.id('Swap(address,uint256,uint256,uint256,uint256)')]] }]).catch((e: unknown) => { console.log('ERR', String(e).slice(0, 160)); return [] });
console.log('peer-pool swaps last 30 blocks:', (logs as unknown[]).length);
// sample one swap: read pool + peer reserves, print raw gap
const l = (logs as { address: string; blockNumber: string }[])[0];
if (l) {
  const p = groups.flat().find((q) => q.address.toLowerCase() === l.address.toLowerCase())!;
  const s = [p.token0, p.token1].map((t) => t.toLowerCase()).sort().join(':');
  const others = peers.get(s)!.filter((q) => q.address !== p.address);
  const rp = await rpc.callContract(p.address, RES_ABI.encodeFunctionData('getReserves'), l.blockNumber);
  const [r0p, r1p] = RES_ABI.decodeFunctionResult('getReserves', rp) as unknown as [bigint, bigint];
  for (const q of others.slice(0, 3)) {
    const rq = await rpc.callContract(q.address, RES_ABI.encodeFunctionData('getReserves'), Number(l.blockNumber) - 1).catch(() => '0x');
    if (rq.length < 66) continue;
    const [r0q, r1q] = RES_ABI.decodeFunctionResult('getReserves', rq) as unknown as [bigint, bigint];
    const gap = (Number(r1p) / Number(r0p)) / (Number(r1q) / Number(r0q)) - 1;
    console.log(`sample gap ${(gap * 1e4).toFixed(2)}bps P=${p.address.slice(0, 10)} Q=${q.address.slice(0, 10)} (${p.symbol0}/${p.symbol1})`);
  }
}
