// Banbot telemetry dashboard server (Item #15).
// Serves the React cockpit from apps/dashboard/web and proxies
// /api/* to the local metrics Express API (default :3001).
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..', 'web');
const ROOT = resolve(__dirname, '../../..');
const PORT = Number(process.env.DASHBOARD_PORT ?? 9205);
const API = process.env.METRICS_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;

const app = express();

/** Ops surface for the cockpit — aggregates the on-disk artifacts the
 *  daemons write (benchmark lanes, monitor signals, pool config). The TS
 *  metrics API only exposes settled/counters; ops telemetry lives here. */
app.get('/api/ops', (_req, res) => {
  const out = { lanes: [], regimes: {}, providers: {}, daemon: null, signals: {} };
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'rpc_pool_config.json'), 'utf8'));
    out.providers = cfg.provider_catalog ?? {};
  } catch { /* config absent */ }
  try {
    const lines = readFileSync(join(ROOT, 'logs/rpc_benchmark.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    const latest = new Map(); // chain:provider -> row
    for (const l of lines) {
      const r = JSON.parse(l);
      latest.set(`${r.chain}:${r.provider}`, r);
    }
    out.lanes = [...latest.values()];
  } catch { /* no benchmark yet */ }
  try {
    const dir = join(ROOT, 'data/monitor');
    for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('_signals.jsonl')) : []) {
      const recs = readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      const key = f.replace(/_signals\.jsonl$/, '');
      const regimes = recs.filter((r) => r.kind === 'regime');
      if (regimes.length) out.regimes[key] = regimes[regimes.length - 1];
      out.signals[key] = { records: recs.length, whales: recs.filter((r) => r.kind === 'whale_alpha').length };
      // sim ledger — last candidate dry-runs (impersonation gate outcomes)
      const sims = recs.filter((r) => r.candidate && r.sim).slice(-10);
      if (!out.simLedger) out.simLedger = [];
      out.simLedger.push(...sims.map((r) => ({ chain: key, ...r })));
    }
    if (out.simLedger) out.simLedger.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    out.simLedger = (out.simLedger ?? []).slice(0, 15);
  } catch { /* no signals yet */ }
  try {
    const lines = readFileSync(join(ROOT, 'logs/rpc_sync.log'), 'utf8').trim().split('\n').filter(Boolean);
    out.daemon = { lastLine: lines[lines.length - 1] ?? null, lines: lines.length };
  } catch { /* no sync log */ }
  res.json(out);
});

app.use(
  '/api',
  // Express strips the /api mount before the proxy sees the request —
  // restore it so upstreams mounted at /api/* resolve correctly.
  createProxyMiddleware({
    target: API,
    changeOrigin: true,
    pathRewrite: { '^/': '/api/' },
  }),
);
app.use('/health', (_req, res) => res.json({ ok: true, api: API }));
app.use(express.static(WEB));

app.listen(PORT, () => {
  console.log(`banbot dashboard on :${PORT} -> api ${API}`);
});
