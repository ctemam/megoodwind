// Metrics API stub for cockpit development when arbRunner isn't running.
// Serves the REAL /api/metrics schema with honest zeros — no fake trades,
// no fake variants. The dashboard renders structure, not theater.
//   node scripts/metrics_stub.mjs   (listens :3001)
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 3001);

const metrics = () => ({
  arb_settled_net_usd: 0,
  settled_count: 0,
  settled_records: [],
  counters: {},
  ts: Date.now(),
  pools: {},
  convicted: {},
  variants: {},
  config: {
    autoExecute: false,
    minProfitUsd: Number(process.env.MIN_PROFIT_USD ?? 5),
    scanIntervalSecs: Number(process.env.SCAN_INTERVAL_SECS ?? 12),
    strategies: (process.env.STRATEGIES ?? 'TRACE,P01,P02').split(','),
    predictiveChains: (process.env.PREDICTIVE_CHAINS ?? 'eth,bsc,poly').split(','),
    backrunChains: (process.env.BACKRUN_CHAINS ?? 'arb,op,base,avax,linea,scroll,blast').split(','),
  },
});

http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') return res.end(JSON.stringify({ ok: true, ts: Date.now(), stub: true }));
  if (req.url?.startsWith('/api/metrics')) return res.end(JSON.stringify(metrics()));
  res.statusCode = 404;
  res.end('{}');
}).listen(PORT, () => console.log(`metrics stub on :${PORT} (honest zeros — arbRunner not running)`));
