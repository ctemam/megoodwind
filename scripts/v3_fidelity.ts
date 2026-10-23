/** WO-8 step 3 — v3 model fidelity, MEASURED not quoted: solver-model
 *  out for the v3 leg vs the real SwapRouter02 exactInputSingle output on
 *  an anvil base fork (pinned to the probe_pass detection block).
 *  tokenIn for the leg is obtained by impersonating a pool that holds it.
 *  Read-only on chain; fork is loopback-only. */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import { v2AmountOut } from '../src/math/univ2.js';
import { inputVirtualReserveRaw } from '../src/math/profit.js';

const FORK_URL = process.env.FORK_RPC_URL!;
const ANVIL = 'http://127.0.0.1:8555';
const PIN = Number(process.env.CANARY_BLOCK ?? 52_977_627);
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const WETH = '0x4200000000000000000000000000000000000006';

const RES = new ethers.Interface(['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)', 'function token1() view returns (address)', 'function getAmountOut(uint256,address) view returns (uint256)']);
const V3 = new ethers.Interface(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns (uint128)', 'function fee() view returns (uint24)']);
const ERC = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)']);
const RT = new ethers.Interface(['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)']);

const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--chain-id', '8453', '--port', '8555', '--fork-block-number', String(PIN)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 9000));
const provider = new ethers.JsonRpcProvider(ANVIL);
const eoa = await provider.getSigner(0);
const EOA = await eoa.getAddress();
const rpc = (m: string, p: unknown[]) => provider.send(m, p);

async function poolMeta(p: string) {
  const [t0r, t1r] = await Promise.all([provider.call({ to: p, data: RES.encodeFunctionData('token0') }), provider.call({ to: p, data: RES.encodeFunctionData('token1') })]);
  const res = await provider.call({ to: p, data: RES.encodeFunctionData('getReserves') }).catch(() => '0x');
  return res.length < 66 ? 'v3' : 'v2';
}

/** real swap through SwapRouter02, funds via impersonated source pool */
async function realSwap(tokenIn: string, tokenOut: string, fee: number, amt: bigint, donor: string): Promise<bigint> {
  await rpc('anvil_impersonateAccount', [donor]);
  await rpc('anvil_setBalance', [donor, '0x' + ethers.parseEther('2').toString(16)]);
  const tIn = new ethers.Contract(tokenIn, ERC, await provider.getSigner(donor));
  await (await tIn.getFunction('transfer')(EOA, amt)).wait();
  await rpc('anvil_stopImpersonatingAccount', [donor]);
  const t = new ethers.Contract(tokenIn, ERC, eoa);
  await (await t.getFunction('approve')(ROUTER, amt)).wait();
  const before = BigInt(await provider.call({ to: tokenOut, data: ERC.encodeFunctionData('balanceOf', [EOA]) }));
  const r = new ethers.Contract(ROUTER, RT, eoa);
  await (await r.exactInputSingle([tokenIn, tokenOut, fee, EOA, amt, 0n, 0n])).wait();
  const after = BigInt(await provider.call({ to: tokenOut, data: ERC.encodeFunctionData('balanceOf', [EOA]) }));
  return after - before;
}

// rows: distinct paths from emit-stage diag, base, with a v3 leg
const rows: { ts: string; path: string; borrowAmount: bigint }[] = [];
for (const st of ['probe_pass', 'min_profit_floor']) {
  try {
    for (const line of readFileSync(`data/diag_${st}.jsonl`, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.chain === 'base' && r.path) rows.push({ ts: r.ts, path: r.path, borrowAmount: BigInt(r.borrowAmount) });
    }
  } catch { }
}
const seen = new Set<string>();
const uniq = rows.filter((r) => !seen.has(r.path) && seen.add(r.path));
console.log(`${uniq.length} distinct emit paths; replaying legs on fork @${PIN}`);

interface Err { errPct: number; leg: number; path: string }
const errs: Err[] = [];
for (const r of uniq.slice(0, 25)) {
  const pools = r.path.split('>');
  try {
    const kinds = await Promise.all(pools.map(poolMeta));
    if (!kinds.includes('v3')) continue;
    // replay leg-by-leg: leg0 v2 WETH->X (aerodrome getAmountOut), then v3 legs real-vs-model
    let amt = r.borrowAmount, tok = WETH, donor = pools[0];
    for (let i = 0; i < pools.length; i++) {
      const p = pools[i], k = kinds[i];
      const [t0r, t1r] = await Promise.all([provider.call({ to: p, data: RES.encodeFunctionData('token0') }), provider.call({ to: p, data: RES.encodeFunctionData('token1') })]);
      const t0 = '0x' + t0r.slice(-40), t1 = '0x' + t1r.slice(-40);
      const z = tok.toLowerCase() === t0.toLowerCase();
      const outTok = z ? t1 : t0;
      if (k === 'v3') {
        const [s, l, f] = await Promise.all([
          provider.call({ to: p, data: V3.encodeFunctionData('slot0') }),
          provider.call({ to: p, data: V3.encodeFunctionData('liquidity') }),
          provider.call({ to: p, data: V3.encodeFunctionData('fee') }),
        ]);
        const [sqrt] = V3.decodeFunctionResult('slot0', s) as unknown as [bigint];
        const [liq] = V3.decodeFunctionResult('liquidity', l) as unknown as [bigint];
        const fee = Number(BigInt(f));
        const fake = { kind: 'v3', token0: t0, sqrtPriceX96: sqrt, liquidity: liq };
        const vIn = inputVirtualReserveRaw(fake, tok), vOut = inputVirtualReserveRaw(fake, outTok);
        const modeled = v2AmountOut(amt, { reserveIn: BigInt(Math.floor(vIn)), reserveOut: BigInt(Math.floor(vOut)) }, Math.floor(fee / 100));
        let real = 0n;
        try { real = await realSwap(tok, outTok, fee, amt, donor); } catch (e) { console.log(`  leg${i} real-swap err: ${String(e).slice(0, 70)}`); }
        if (real > 0n) {
          const errPct = (Number(modeled - real) / Number(real)) * 100;
          errs.push({ errPct, leg: i, path: r.path.slice(0, 36) });
          console.log(`  ${r.path.slice(0, 32)}.. leg${i} v3 fee=${fee} in=${amt.toString().slice(0, 12)} model=${modeled} real=${real} err=${errPct.toFixed(2)}%`);
        }
        amt = real > 0n ? real : modeled; tok = outTok; donor = p; continue;
      }
      // v2 leg: pool's own getAmountOut if present, else CP
      const go = await provider.call({ to: p, data: RES.encodeFunctionData('getAmountOut', [amt, tok]) }).catch(() => '0x');
      amt = go.length >= 66 ? BigInt(go) : amt;
      tok = outTok; donor = p;
    }
  } catch (e) { console.log(`  path err ${r.path.slice(0, 30)}: ${String(e).slice(0, 70)}`); }
}
const xs = errs.map((e) => e.errPct).sort((a, b) => a - b);
const pct = (p: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null;
console.log(`\n=== v3 fidelity (model vs REAL swap, fork @${PIN}) n=${xs.length} ===`);
console.log(`err% p50=${pct(0.5)?.toFixed(2)} p90=${pct(0.9)?.toFixed(2)} min=${xs.length ? xs[0].toFixed(2) : 'n/a'} max=${xs.length ? xs[xs.length - 1].toFixed(2) : 'n/a'}`);
anvil.kill();
