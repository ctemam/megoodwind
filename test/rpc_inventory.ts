/**
 * RPC inventory probe — bounded, honest measurement of the keyed endpoint
 * universe per chain. Per endpoint: chainId verify, p50 latency (5 samples),
 * small burst (8 reqs) counting pre-throttle successes. ~14 req/endpoint —
 * deliberately tiny against free quotas; this is a census, not a load test.
 *
 * Run: npx tsx test/rpc_inventory.ts [chain ...]
 */
import { ethers } from 'ethers';
import { chainConfig, KNOWN_CHAIN_ID } from '../src/config/index.js';
import { providerOf, specOf, PRIVATE_PROVIDERS } from '../src/providers/providerCatalog.js';

const SAMPLES = 5;
const BURST = 8;

const redact = (u: string) =>
  u.replace(/(dkey=|\/v2\/|\/ws\/|\/v1\/)([A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1$2…')
   .replace(/(rpc\.ankr\.com\/[a-z-]+\/)([A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1$2…');

async function probe(chain: string, url: string) {
  const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: false });
  const send = (m: string, params: unknown[] = []) => p.send(m, params);
  const t = async (fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    try { await fn(); return performance.now() - t0; } catch { return -1; }
  };

  let chainId = -1;
  try { chainId = Number(await send('eth_chainId')); } catch { /* dead */ }
  const expected = KNOWN_CHAIN_ID[chain] ?? -1;
  const lats: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const ms = await t(() => send('eth_blockNumber'));
    if (ms > 0) lats.push(ms);
  }
  lats.sort((a, b) => a - b);
  const p50 = lats.length ? lats[Math.floor(lats.length / 2)] : -1;

  // bounded burst — count successes before throttle
  let ok = 0, err429 = false;
  const t0 = performance.now();
  await Promise.allSettled(
    Array.from({ length: BURST }, async () => {
      try { await send('eth_call', [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, 'latest']); ok++; }
      catch (e) { if (JSON.stringify(e).match(/429|rate limit|code.{0,3}15|quota/i)) err429 = true; }
    }),
  );
  const burstS = (performance.now() - t0) / 1000;

  return { chainId, expected, ok: chainId === expected, p50, burstOk: ok, burstS, err429 };
}

async function main() {
  const chains = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(KNOWN_CHAIN_ID);
  console.log('chain    provider    account      url                                    chainId  p50ms  burst  budget(rps)');
  console.log('─'.repeat(120));
  const accounts = new Map<string, { provider: string; rps: number; chains: string[] }>();
  for (const c of chains) {
    let cc;
    try { cc = chainConfig(c); } catch { console.log(`${c.padEnd(8)} (no chain id)`); continue; }
    const urls = cc.rpcUrls;
    if (!urls.length) { console.log(`${c.padEnd(8)} (no keyed endpoints)`); continue; }
    for (const u of urls) {
      const { id, account } = providerOf(u);
      const r = await probe(c, u).catch(() => null);
      const spec = specOf(id);
      const safe = spec ? Math.max(1, spec.rps * 0.9) : 5;
      if (!r) { console.log(`${c.padEnd(8)} ${id.padEnd(11)} ${account.slice(-12).padEnd(12)} ${redact(u).padEnd(38)} DEAD`); continue; }
      console.log(
        `${c.padEnd(8)} ${id.padEnd(11)} ${account.slice(-12).padEnd(12)} ${redact(u).padEnd(38)} ` +
        `${r.ok ? 'OK ' + r.chainId : 'BAD!' + r.chainId}  ${String(r.p50.toFixed(0)).padStart(5)}  ` +
        `${r.burstOk}/${BURST}@${r.burstS.toFixed(1)}s${r.err429 ? '429!' : ''}  ${safe.toFixed(0)}`,
      );
      const a = accounts.get(account) ?? { provider: id, rps: safe, chains: [] };
      if (!a.chains.includes(c)) a.chains.push(c);
      accounts.set(account, a);
    }
  }
  console.log('─'.repeat(120));
  console.log('ACCOUNT INVENTORY (quota pools bind per account key, not URL):');
  for (const [acc, a] of accounts) {
    console.log(`  ${acc.padEnd(24)} ${a.provider.padEnd(10)} safe ${a.rps.toFixed(0)} rps  chains: ${a.chains.join(',')}`);
  }
  console.log('\nDocumented free-tier budgets (per account, per month):');
  for (const p of PRIVATE_PROVIDERS) {
    const set = !!process.env[p.envKey];
    console.log(`  ${p.id.padEnd(10)} key:${set ? 'SET' : '—  '} ${p.rps} rps doc · ${(p.cuPerMonth / 1e6).toFixed(0)}M CU/mo${p.batchLimit ? ` · jsonrpc batch ≤${p.batchLimit}` : ''}${p.notes ? ` · ${p.notes}` : ''}`);
  }
}

await main();
