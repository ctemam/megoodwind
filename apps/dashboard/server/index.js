// allbrightA dashboard proxy — thin layer over the per-chain Prometheus
// exporters (9100=bsc, 9101=base) plus free public price/RPC APIs.
// No new wheels: metrics stay Prometheus-format upstream; we parse to JSON
// for the React UI. Secrets stay server-side (read from repo .env).
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '../../..')
const PORT = process.env.DASHBOARD_PORT || 9200

const CHAINS = {
  bsc: { metrics: 'http://localhost:9100/metrics', rpc: 'https://bsc-rpc.publicnode.com', chainId: 56, label: 'BSC' },
  base: { metrics: 'http://localhost:9101/metrics', rpc: 'https://base-rpc.publicnode.com', chainId: 8453, label: 'Base' },
}

const env = {}
try {
  for (const line of fs.readFileSync(path.join(REPO, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}
const LIVE = env.LIVE_COMMANDER_APPROVED === 'true'

const app = express()
app.use(express.json())

// Prometheus text -> {name: value} (labels flattened to name{...})
function parseProm(text) {
  const out = {}
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?)\s+([-\d.eE+]+)/)
    if (m) out[m[1]] = parseFloat(m[2])
  }
  return out
}

async function fetchMetrics(chain) {
  const r = await fetch(CHAINS[chain].metrics, { signal: AbortSignal.timeout(4000) })
  return parseProm(await r.text())
}

app.get('/api/metrics', async (req, res) => {
  const chain = req.query.chain
  if (!CHAINS[chain]) return res.status(400).json({ error: 'unknown chain' })
  try {
    res.json({ chain, live: LIVE, ...(await fetchMetrics(chain)) })
  } catch (e) {
    res.status(502).json({ error: `runner ${chain} unreachable: ${e.message}` })
  }
})

app.get('/api/metrics/all', async (_req, res) => {
  const out = {}
  for (const c of Object.keys(CHAINS)) {
    try { out[c] = await fetchMetrics(c) } catch { out[c] = null }
  }
  const net = Object.values(out).reduce(
    (s, m) => s + (m ? m['arb_gross_profit_usd_total'] || 0 : 0), 0)
  recordProfit(net)
  res.json({ live: LIVE, chains: out, profit: profitSummary(net) })
})

// Rolling profit history — the UI's "last 24h" mode needs a baseline from
// 24h ago, which Prometheus counters can't express (they're cumulative).
// Sampled in the background so the window builds even when nobody is
// watching the UI; persisted so it survives dashboard restarts.
const PROFIT_LOG = path.join(__dirname, '.profit-history.json')
let profitLog = []
try { profitLog = JSON.parse(fs.readFileSync(PROFIT_LOG, 'utf8')) } catch {}

function recordProfit(net) {
  const now = Date.now()
  const last = profitLog[profitLog.length - 1]
  if (last && now - last.t < 25_000) { last.t = now; last.net = net }
  else profitLog.push({ t: now, net })
  const cutoff = now - 48 * 3600e3
  if (profitLog.length > 4000 || (profitLog[0] && profitLog[0].t < cutoff))
    profitLog = profitLog.filter(s => s.t >= cutoff)
  fs.writeFile(PROFIT_LOG, JSON.stringify(profitLog), () => {})
}

function profitSummary(netNow) {
  const dayAgo = Date.now() - 24 * 3600e3
  const base = profitLog.find(s => s.t >= dayAgo)
  const dayFrom = base?.t ?? profitLog[0]?.t ?? null
  const day = dayFrom != null ? netNow - (base ?? profitLog[0]).net : null
  return { lifetime: netNow, day, day_from: dayFrom }
}

async function sampleProfit() {
  try {
    let net = 0
    for (const c of Object.keys(CHAINS)) {
      try { net += (await fetchMetrics(c))['arb_gross_profit_usd_total'] || 0 } catch {}
    }
    recordProfit(net)
  } catch {}
}
sampleProfit()
setInterval(sampleProfit, 30_000)

async function rpc(chain, method, params) {
  const r = await fetch(CHAINS[chain].rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  })
  return (await r.json()).result
}

// Wallet/contract balances — addresses from repo .env, never exposed raw keys.
app.get('/api/wallets', async (_req, res) => {
  const wallets = []
  for (const [c, cfg] of Object.entries(CHAINS)) {
    const contract = env[`${c.toUpperCase()}_ARB_CONTRACT`]
    const executor = env[`${c.toUpperCase()}_EXECUTOR`]
    for (const [kind, addr] of [['executor_contract', contract], ['signer_wallet', executor]]) {
      if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue
      try {
        const bal = await rpc(c, 'eth_getBalance', [addr, 'latest'])
        wallets.push({ chain: c, kind, address: addr, balanceWei: bal })
      } catch {
        wallets.push({ chain: c, kind, address: addr, balanceWei: null })
      }
    }
  }
  res.json({ live: LIVE, wallets })
})

// Currency conversion — CoinGecko free API (no key).
app.get('/api/prices', async (_req, res) => {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin,tether&vs_currencies=usd',
      { signal: AbortSignal.timeout(8000) })
    res.json(await r.json())
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Withdrawal — manual triggers a contract withdraw call; auto is a threshold
// sweep config. Hard-gated on LIVE_COMMANDER_APPROVED like every other tx path.
let autoCfg = { enabled: false, thresholdUsd: 100, to: null }
app.get('/api/withdraw/config', (_req, res) => res.json({ live: LIVE, auto: autoCfg }))
app.post('/api/withdraw/auto', (req, res) => {
  autoCfg = { ...autoCfg, ...req.body }
  res.json({ live: LIVE, auto: autoCfg, note: LIVE ? 'armed' : 'stored (dry-run; flips live with LIVE_COMMANDER_APPROVED)' })
})
app.post('/api/withdraw', async (req, res) => {
  const { chain, to, amountWei } = req.body || {}
  if (!CHAINS[chain]) return res.status(400).json({ error: 'unknown chain' })
  if (!LIVE) return res.json({ dryRun: true, wouldCall: 'emergencyWithdraw', chain, to, amountWei })
  res.status(501).json({ error: 'live withdrawal requires Commander broadcast path — not enabled in this build' })
})

app.use(express.static(path.join(__dirname, '../dist')))
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')))

app.listen(PORT, () => console.log(`dashboard proxy on :${PORT} (live=${LIVE})`))
