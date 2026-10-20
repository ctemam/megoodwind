import 'dotenv/config';
import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cfg } from '../src/config/index.js';
import { keyedEndpointsFor, providerOf } from '../src/providers/providerCatalog.js';

/**
 * Multi-chain RPC latency benchmark — measures every endpoint the routing
 * overlay currently emits (suspended providers emit zero, so a lane only
 * appears once it earns LIVE status). One run pre-attach and one post-
 * attach = a direct Chainstack-vs-fleet comparison from the same harness.
 *
 *   npx tsx scripts/benchmark_rpc_latency.ts            # all active chains
 *   BENCH_CHAINS=eth,arb npx tsx scripts/benchmark_rpc_latency.ts
 *   BENCH_ROUNDS=7 ...
 *
 * Output: console table + append-only JSONL at logs/rpc_benchmark.jsonl
 * so consecutive runs accumulate into a comparable history.
 */

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);
const CHAINS = (process.env.BENCH_CHAINS ?? cfg.activeChains.join(',')).split(',');
const LOG_FILE = resolve(process.cwd(), 'logs/rpc_benchmark.jsonl');

interface Row {
  chain: string;
  provider: string;
  account: string;
  ok: number;
  fail: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

const pct = (xs: number[], q: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] : -1;

async function timedCall(url: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const j = (await res.json()) as { result?: string; error?: unknown };
  if (!j.result || j.error) throw new Error('rpc error');
  return performance.now() - t0;
}

async function bench(chain: string, url: string): Promise<Row> {
  const { id, account } = providerOf(url);
  const lat: number[] = [];
  let fail = 0;
  for (let i = 0; i < ROUNDS; i++) {
    try { lat.push(await timedCall(url)); } catch { fail++; }
    await new Promise((r) => setTimeout(r, 120)); // gentle gap — a census, not a load test
  }
  lat.sort((a, b) => a - b);
  return {
    chain, provider: id, account, ok: lat.length, fail,
    minMs: Math.round(lat[0] ?? -1), p50Ms: Math.round(pct(lat, 0.5)),
    p95Ms: Math.round(pct(lat, 0.95)), maxMs: Math.round(lat[lat.length - 1] ?? -1),
  };
}

async function main() {
  const rows: Row[] = [];
  for (const chain of CHAINS) {
    const eps = keyedEndpointsFor(chain.trim());
    for (const e of eps) {
      const row = await bench(chain.trim(), e.url).catch(() => ({
        chain: chain.trim(), provider: e.provider, account: '?', ok: 0, fail: ROUNDS, minMs: -1, p50Ms: -1, p95Ms: -1, maxMs: -1,
      }));
      rows.push(row);
      console.log(`${row.chain.padEnd(7)} ${row.provider.padEnd(11)} ok=${row.ok}/${ROUNDS} p50=${row.p50Ms}ms p95=${row.p95Ms}ms min=${row.minMs}ms max=${row.maxMs}ms`);
    }
  }

  // per-provider fleet summary across chains
  const byProvider = new Map<string, Row[]>();
  for (const r of rows) if (r.ok > 0) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
    byProvider.get(r.provider)!.push(r);
  }
  console.log('\n── provider summary (p50 across chains, live lanes only) ──');
  for (const [p, rs] of [...byProvider.entries()].sort((a, b) =>
    (a[1].reduce((s, r) => s + r.p50Ms, 0) / a[1].length) - (b[1].reduce((s, r) => s + r.p50Ms, 0) / b[1].length))) {
    const avg = Math.round(rs.reduce((s, r) => s + r.p50Ms, 0) / rs.length);
    console.log(`${p.padEnd(11)} chains=${rs.length} avg_p50=${avg}ms`);
  }

  mkdirSync(resolve(process.cwd(), 'logs'), { recursive: true });
  for (const r of rows) appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...r }) + '\n');
  console.log(`\n${rows.length} endpoint benchmarks appended -> ${LOG_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
