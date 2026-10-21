// AllBright telemetry dashboard server (Item #15).
// Serves the React UI from apps/dashboard/web, proxies /api/metrics
// to the metrics API (:3001), serves /api/ops ops-telemetry aggregates,
// broadcasts a live snapshot over WebSocket /ws every 2s, and exposes
// /api/engine start/stop control for the arb-runner process.
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..', 'web');
const ROOT = resolve(__dirname, '../../..');
const PORT = Number(process.env.DASHBOARD_PORT ?? 9205);
const API = process.env.METRICS_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;

// ---- .env parsing (public surfaces only — keys never leave this file) ----
const ENV_PATH = join(ROOT, '.env');
const envVal = (k) => {
  try {
    const m = readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^${k}=(.+)$`, 'm'));
    return m?.[1]?.trim();
  } catch { return undefined; }
};

// ---- ops aggregate — on-disk artifacts the daemons write ----
function buildOps() {
  const out = { lanes: [], regimes: {}, providers: {}, daemon: null, signals: {}, simLedger: [], wallet: {}, deployment: {}, engine: { running: !!engineProc } };
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'rpc_pool_config.json'), 'utf8'));
    out.providers = cfg.provider_catalog ?? {};
  } catch { /* config absent */ }
  try {
    const lines = readFileSync(join(ROOT, 'logs/rpc_benchmark.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    const latest = new Map();
    for (const l of lines) { const r = JSON.parse(l); latest.set(`${r.chain}:${r.provider}`, r); }
    out.lanes = [...latest.values()];
  } catch { /* no benchmark yet */ }
  try {
    const dir = join(ROOT, 'data/monitor');
    for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('_signals.jsonl')) : []) {
      const recs = readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const key = f.replace(/_signals\.jsonl$/, '');
      const regimes = recs.filter((r) => r.kind === 'regime');
      if (regimes.length) out.regimes[key] = regimes[regimes.length - 1];
      out.signals[key] = { records: recs.length, whales: recs.filter((r) => r.kind === 'whale_alpha').length };
      const sims = recs.filter((r) => r.candidate && r.sim).slice(-10);
      out.simLedger.push(...sims.map((r) => ({ chain: key, ...r })));
    }
    out.simLedger.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    out.simLedger = out.simLedger.slice(0, 15);
  } catch { /* no signals yet */ }
  // OP-Stack L1 data-fee oracle scalars — written by arbRunner each cycle
  try {
    out.l1oracle = {};
    for (const f of readdirSync(join(ROOT, 'data')).filter((x) => /^l1_oracle_.+\.json$/.test(x))) {
      const chain = f.replace(/^l1_oracle_|\.json$/g, '');
      out.l1oracle[chain] = JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
    }
  } catch { /* no oracle records yet */ }
  try {
    const lines = readFileSync(join(ROOT, 'logs/rpc_sync.log'), 'utf8').trim().split('\n').filter(Boolean);
    out.daemon = { lastLine: lines[lines.length - 1] ?? null, lines: lines.length };
  } catch { /* no sync log */ }

  // wallet — public addresses only (never keys)
  out.wallet = {
    smartAccount: envVal('SMART_ACCOUNT_ADDRESS') ?? null,
    profitWallet: envVal('PROFIT_WALLET') ?? null,
  };

  // deployment — executor contract addresses per chain + multicall3
  const deployment = { multicall3: envVal('MULTICALL3_ADDR') ?? '0xcA11bde05977b3631167028862bE2a173976CA11', executors: {} };
  try {
    const env = readFileSync(ENV_PATH, 'utf8');
    for (const m of env.matchAll(/^ALLBRIGHT_EXECUTOR_([A-Z]+)=(0x[0-9a-fA-F]+)/gm)) {
      deployment.executors[m[1].toLowerCase()] = m[2];
    }
  } catch { /* no env */ }
  out.deployment = deployment;

  // configuration — non-secret runtime params (API keys deliberately excluded)
  const cfgOut = {};
  for (const k of ['ACTIVE_CHAINS', 'PREDICTIVE_CHAINS', 'BACKRUN_CHAINS', 'STRATEGIES', 'AUTO_EXECUTE',
    'MIN_PROFIT_USD', 'SCAN_INTERVAL_SECS', 'MAX_BASE_FEE_GWEI', 'SLIPPAGE_BPS', 'STRICT_PROFIT_FLOOR_GUARD',
    'DISCOVERY_TOP_TOKENS', 'DISCOVERY_MAX_FACTORIES', 'DISCOVERY_BATCH_SIZE', 'NATIVE_USD',
    'PROFIT_TRANSFER_MODE', 'PROFIT_TRANSFER_MIN_USD', 'DEPLOY_REGION']) {
    const v = envVal(k);
    if (v !== undefined) cfgOut[k] = v;
  }
  out.configuration = cfgOut;
  out.engine = { running: !!engineProc, pid: engineProc?.pid ?? null };
  return out;
}

// ---- engine control: spawn/stop the arb-runner ----
let engineProc = null;
function engineStart() {
  if (engineProc) return { ok: true, pid: engineProc.pid, already: true };
  engineProc = spawn('npx', ['tsx', 'src/runner/arbRunner.ts'], {
    cwd: ROOT, shell: true, detached: false,
    env: { ...process.env, AUTO_EXECUTE: 'false' }, // shadow-forced — never live from UI
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engineProc.stdout.on('data', () => undefined);
  engineProc.stderr.on('data', () => undefined);
  engineProc.on('exit', () => { engineProc = null; });
  return { ok: true, pid: engineProc.pid };
}
function engineStop() {
  if (!engineProc) return { ok: true, already: true };
  try { process.kill(engineProc.pid); } catch { /* gone */ }
  engineProc = null;
  return { ok: true };
}

const app = express();
app.use(express.json());

app.get('/api/ops', (_req, res) => res.json(buildOps()));

app.post('/api/engine', (req, res) => {
  const action = String(req.body?.action ?? '');
  if (action === 'start') return res.json(engineStart());
  if (action === 'stop') return res.json(engineStop());
  res.status(400).json({ ok: false, error: 'action must be start|stop' });
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
app.use('/health', (_req, res) => res.json({ ok: true, api: API, ws: true }));

// Compiled app bundle — JSX transpiled server-side on every request so
// the browser never needs a runtime transform (babel-standalone CDN was
// the black-screen failure mode). Always fresh, zero build state.
app.get('/app.js', (_req, res) => {
  try {
    const src = readFileSync(join(WEB, 'app.jsx'), 'utf8');
    const out = ts.transpileModule(src, {
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
      fileName: 'app.jsx',
    });
    res.type('application/javascript').send(out.outputText);
  } catch (e) {
    res.status(500).type('application/javascript')
      .send(`document.body.innerHTML='<pre style="color:#F87171;padding:2rem">compile fault: ${String(e.message ?? e).replace(/</g, '&lt;')}</pre>'`);
  }
});

app.use(express.static(WEB));

// ---- HTTP + WebSocket server ----
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

async function snapshot() {
  let metrics = null;
  try {
    const r = await fetch(`${API}/api/metrics`, { signal: AbortSignal.timeout(3_000) });
    metrics = await r.json();
  } catch { /* metrics api down — send ops anyway */ }
  return { ts: Date.now(), metrics, ops: buildOps() };
}

wss.on('connection', async (ws) => {
  ws.send(JSON.stringify(await snapshot()));
});
setInterval(async () => {
  if (!wss.clients.size) return;
  const s = JSON.stringify(await snapshot());
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}, 2_000);

server.listen(PORT, () => {
  console.log(`allbright dashboard on :${PORT} -> api ${API} (ws /ws)`);
});
