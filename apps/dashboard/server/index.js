// Banbot telemetry dashboard server (Item #15).
// Serves the React cockpit from apps/dashboard/web and proxies
// /api/* to the local metrics Express API (default :3001).
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..', 'web');
const PORT = Number(process.env.DASHBOARD_PORT ?? 9205);
const API = process.env.METRICS_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;

const app = express();

app.use(
  '/api',
  createProxyMiddleware({ target: API, changeOrigin: true }),
);
app.use('/health', (_req, res) => res.json({ ok: true, api: API }));
app.use(express.static(WEB));

app.listen(PORT, () => {
  console.log(`banbot dashboard on :${PORT} -> api ${API}`);
});
