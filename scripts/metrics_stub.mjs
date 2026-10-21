// Metrics API stub for cockpit development when arbRunner isn't running.
// Serves the REAL /api/metrics schema with honest zeros — no fake trades,
// no fake variants. The dashboard renders structure, not theater.
//   node scripts/metrics_stub.mjs   (listens :3001)
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 3001);

// fork-window projections written by scripts/fork_window_sim.ts
const projections = () => {
  if (!existsSync('data/projections.json')) return null;
  try { return JSON.parse(readFileSync('data/projections.json', 'utf8')); } catch { return null; }
};

// persistent gate counters written by src/telemetry/metrics.ts (5s flush)
const counters = () => {
  if (!existsSync('data/metrics_counters.json')) return {};
  try { return JSON.parse(readFileSync('data/metrics_counters.json', 'utf8')); } catch { return {}; }
};
const gateSum = (c, name) =>
  Object.entries(c).reduce((s, [k, v]) => s + (k.startsWith(`${name}|`) ? (Number(v) || 0) : 0), 0);

const metrics = () => {
  const c = counters();
  return {
  arb_settled_net_usd: 0,
  settled_count: 0,
  settled_records: [],
  counters: c,
  forensicGates: {
    total_detected_opportunities: gateSum(c, 'total_detected_opportunities'),
    rejected_by_forensic_bait: gateSum(c, 'rejected_by_forensic_bait'),
    rejected_by_profit_margin: gateSum(c, 'rejected_by_profit_margin'),
    passed_to_simulation_probe: gateSum(c, 'passed_to_simulation_probe'),
  },
  ts: Date.now(),
  pools: {},
  convicted: {},
  variants: {},
  projections: projections(),
  config: {
    autoExecute: false,
    minProfitUsd: Number(process.env.MIN_PROFIT_USD ?? 5),
    scanIntervalSecs: Number(process.env.SCAN_INTERVAL_SECS ?? 12),
    strategies: (process.env.STRATEGIES ?? 'TRACE,P01,P02').split(','),
    predictiveChains: (process.env.PREDICTIVE_CHAINS ?? 'eth,bsc,poly').split(','),
    backrunChains: (process.env.BACKRUN_CHAINS ?? 'arb,op,base,avax,linea,scroll,blast').split(','),
  },
};
}

http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') return res.end(JSON.stringify({ ok: true, ts: Date.now(), stub: true }));
  if (req.url?.startsWith('/api/metrics')) return res.end(JSON.stringify(metrics()));
  res.statusCode = 404;
  res.end('{}');
}).listen(PORT, () => console.log(`metrics stub on :${PORT} (honest zeros — arbRunner not running)`));
