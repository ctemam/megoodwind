/**
 * WO-9 step 5 — probe↔exec agreement on recorded probe_pass candidates.
 * Replays N recorded candidates through the NEW executor build
 * (V2_SELFQUOTE + V3_POOL leg kinds) on a base fork pinned near each
 * emit ts. Reports exec-pass rate vs the solver's claimed net.
 * Run: FORK_RPC_URL=<keyed base> npx tsx scripts/wo9_agreement.ts
 */
import { spawn, ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import { ethers } from 'ethers';

const FORK_URL = process.env.FORK_RPC_URL;
if (!FORK_URL) { console.error('FORK_RPC_URL (keyed base rpc) required'); process.exit(1); }

const SMART = '0x663050be401f590e8e2c3f01f05536948275015b';
const BALANCER = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const AAVE_BASE = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const WETH = '0x4200000000000000000000000000000000000006';
const X = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const POOL_V2 = '0x21594b992f68495dd28d605834b58889d0a727c7';
const POOL_V3 = '0x9c087eb773291e50cf6c6a90ef0f4500e349b903';
const PLAN_TUPLE = 'tuple(uint8 source, address borrowToken, uint256 borrowAmount, tuple(uint8 kind, address venue, address tokenIn, address tokenOut, uint24 fee, uint16 feeBps)[] hops, uint256 minOut, uint256 minProfit)';
const PORT = 8567;

const rows = readFileSync('data/diag_probe_pass.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// distinct emit windows: take the first of each hour-bucket
const seen = new Set<string>();
const sample = rows.filter((r) => { const k = r.ts.slice(0, 13); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
console.log(`[wo9] ${rows.length} probe_pass rows -> ${sample.length} distinct-hour candidates`);

let anvil: ChildProcess | null = null;
const rpc = (m: string, p: unknown[]) =>
  fetch(`http://127.0.0.1:${PORT}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }).then((r) => r.json());
const blockForTs = async (ts: string): Promise<number> => {
  const t = Math.floor(new Date(ts).getTime() / 1000);
  const head = await fetch(FORK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) }).then((r) => r.json());
  let lo = parseInt(head.result, 16) - 120_000, hi = parseInt(head.result, 16);
  const bts = async (n: number) => { const b = await fetch(FORK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), false] }) }).then((r) => r.json()); return parseInt(b.result.timestamp, 16); };
  while (lo < hi - 1) { const mid = Math.floor((lo + hi) / 2); if ((await bts(mid)) <= t) lo = mid; else hi = mid; }
  return lo;
};

const artifact = JSON.parse(readFileSync('out/AllBrightExecutor.sol/AllBrightExecutor.json', 'utf8'));
const results: { ts: string; modelNet: number; probe: string }[] = [];
for (const cand of sample) {
  if (anvil) anvil.kill();
  const pin = await blockForTs(cand.ts);
  anvil = spawn('anvil', ['--fork-url', FORK_URL, '--chain-id', '31337', '--port', String(PORT), '--fork-block-number', String(pin), '--silent']);
  for (let i = 0; i < 60; i++) { try { const c = await rpc('eth_chainId', []); if (c.result) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`);
  const eoa = ethers.Wallet.createRandom(provider); // fork throwaway
  await rpc('anvil_setBalance', [eoa.address, '0x21e19e0c9bab2400000']);
  const ex = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, eoa).deploy(BALANCER, AAVE_BASE);
  await ex.waitForDeployment();
  await (await ex.transferOwnership(SMART)).wait();
  const borrow = BigInt(cand.borrowAmount);
  const plan = {
    source: 0, borrowToken: WETH, borrowAmount: borrow,
    hops: [
      { kind: 3, venue: POOL_V2, tokenIn: WETH, tokenOut: X, fee: 0, feeBps: 0 },
      { kind: 2, venue: POOL_V3, tokenIn: X, tokenOut: WETH, fee: 0, feeBps: 0 },
    ],
    minOut: borrow, minProfit: 1n,
  };
  const data = new ethers.Interface(['function exec(bytes)']).encodeFunctionData('exec', [ethers.AbiCoder.defaultAbiCoder().encode([PLAN_TUPLE], [plan])]);
  await rpc('anvil_impersonateAccount', [SMART]);
  await rpc('anvil_setBalance', [SMART, '0xde0b6b3a7640000']);
  const probe = await provider.call({ from: SMART, to: await ex.getAddress(), data }).then(() => 'PASS').catch((e) => `REVERT ${e.data?.slice(0, 10) ?? String(e).slice(0, 80)}`);
  results.push({ ts: cand.ts, modelNet: cand.netUsd, probe });
  console.log(`[wo9] ${cand.ts} pin=${pin} modelNet=$${cand.netUsd.toFixed(2)} -> ${probe}`);
}
if (anvil) anvil.kill();
const pass = results.filter((r) => r.probe === 'PASS').length;
console.log(`[wo9] AGREEMENT: ${pass}/${results.length} exec-pass (model claimed $${results.map((r) => r.modelNet.toFixed(2)).join(',$')})`);
