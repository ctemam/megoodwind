// allbrightA dashboard proxy — thin layer over the per-chain Prometheus
// exporters (9100=bsc, 9101=base) plus free public price/RPC APIs.
// No new wheels: metrics stay Prometheus-format upstream; we parse to JSON
// for the React UI. Secrets stay server-side (read from repo .env).
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { execFileSync } from 'node:child_process'
import os from 'node:os'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '../../..')
const PORT = process.env.DASHBOARD_PORT || 9200
// 127.0.0.1 default: the dashboard carries go-live + withdrawal controls with
// no auth — set DASHBOARD_HOST=0.0.0.0 only when LAN access is required.
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1'

const CHAINS = {
  bsc: { metrics: 'http://localhost:9100/metrics', rpc: 'https://bsc-rpc.publicnode.com', chainId: 56, label: 'BSC' },
  // base has a config (config/base.toml, port 9101) but no runner in the
  // ecosystem fleet — re-enable here when a Base runner is deployed.
  ethereum: { metrics: 'http://localhost:9102/metrics', rpc: 'https://ethereum-rpc.publicnode.com', chainId: 1, label: 'Ethereum' },
  polygon: { metrics: 'http://localhost:9103/metrics', rpc: 'https://polygon-bor-rpc.publicnode.com', chainId: 137, label: 'Polygon' },
}

const ENV_PATH = path.join(REPO, '.env')
const env = {}
try {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}
// Re-read per request: go-live flips the flag mid-process.
function isLive() {
  try {
    return fs.readFileSync(ENV_PATH, 'utf8').split('\n').some(
      l => l.replace(/\r$/, '').trim() === 'LIVE_COMMANDER_APPROVED=true')
  } catch { return false }
}


function setEnvFlag(key, value) {
  const lines = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, 'utf8').split('\n').map(l => l.replace(/\r$/, ''))
    : []
  const i = lines.findIndex(l => l.startsWith(`${key}=`))
  if (i >= 0) lines[i] = `${key}=${value}`
  else lines.push(`${key}=${value}`)
  fs.writeFileSync(ENV_PATH, lines.filter((l, j) => l !== '' || j < lines.length - 1).join('\n'))
  env[key] = value
}

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
    res.json({ chain, live: isLive(), ...(await fetchMetrics(chain)) })
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
  res.json({ live: isLive(), chains: out, profit: profitSummary(net), commit: BUILD_COMMIT })
})

// ── Canonical metrics contract ──────────────────────────────────────────
// One normalized definition across API, UI and runner (improvement plan
// Phase 3): net = gross − warp spend − gas. Pages should consume this
// rather than interpreting raw Prometheus counters independently.
const histP = (m, name, q) => {
  const buckets = []
  let count = null
  for (const [k, v] of Object.entries(m)) {
    const mm = k.match(new RegExp(`^${name}_bucket\\{le="([^"]+)"\\}$`))
    if (mm) buckets.push([mm[1] === '+Inf' ? Infinity : +mm[1], v])
    if (k === `${name}_count`) count = v
  }
  if (!count || !buckets.length) return null
  buckets.sort((a, b) => a[0] - b[0])
  const target = count * q
  const hit = buckets.find(b => b[1] >= target)
  if (!hit) return null
  // +Inf means the quantile exceeds the highest finite bucket — report the
  // top finite edge (a lower bound) rather than JSON-stringifying Infinity
  // into a misleading null.
  if (hit[0] === Infinity)
    return buckets.filter(b => isFinite(b[0])).pop()?.[0] ?? null
  return hit[0]
}
const histAvg = (m, name) => {
  const s = m[`${name}_sum`], c = m[`${name}_count`]
  return (s != null && c) ? s / c : null
}

app.get('/api/metrics/canonical', async (req, res) => {
  const out = { live: isLive(), sampled_at: new Date().toISOString(), chains: {} }
  for (const [c, cfg] of Object.entries(CHAINS)) {
    let m = null
    try { m = await fetchMetrics(c) } catch {}
    if (!m) { out.chains[c] = null; continue }
    // Gas USD uses the engine's own configured native-token price — the
    // same assumption the profit gate makes, not an external oracle.
    let nativeUsd = null
    try {
      nativeUsd = +(tomlScalar(tomlSection(readToml(c), 'token_usd_prices'), 'WBNB')
        || tomlScalar(tomlSection(readToml(c), 'token_usd_prices'), 'ETH') || 0) || null
    } catch {}
    const gasUsd = nativeUsd != null
      ? (m['arb_gas_spent_wei_total'] || 0) / 1e18 * nativeUsd : null
    const landed = k => {
      for (const [key, v] of Object.entries(m))
        if (key === `arb_submit_landed_total{status="${k}"}`) return v
      return 0
    }
    out.chains[c] = {
      gross_usd: m['arb_gross_profit_usd_total'] ?? null,
      warp_spend_usd: m['arb_warp_spend_usd_total'] ?? null,
      gas_usd: gasUsd,
      net_usd: m['arb_net_profit_usd_total'] ?? null,
      paths_evaluated: m['arb_paths_evaluated_total'] ?? null,
      profitable_paths: m['arb_profitable_found_total'] ?? null,
      backrun_candidates: m['arb_backrun_candidates_total'] ?? null,
      submit_attempts: m['arb_submit_attempts_total'] ?? null,
      landed_success: landed('success'),
      landed_revert: landed('revert'),
      landed_dropped: landed('dropped'),
      scan_latency_avg_ms: (() => { const v = histAvg(m, 'arb_scan_latency_seconds'); return v == null ? null : v * 1000 })(),
      scan_latency_p95_ms: (() => { const v = histP(m, 'arb_scan_latency_seconds', 0.95); return v == null ? null : v * 1000 })(),
      state_refresh_avg_ms: (() => { const v = histAvg(m, 'arb_state_refresh_seconds'); return v == null ? null : v * 1000 })(),
      pending_to_eval_p50_ms: (() => { const v = histP(m, 'arb_pending_to_eval_seconds', 0.5); return v == null ? null : v * 1000 })(),
      pending_to_submit_p95_ms: (() => { const v = histP(m, 'arb_pending_to_submit_seconds', 0.95); return v == null ? null : v * 1000 })(),
      leader_observe_p99_us: (() => { const v = histP(m, 'arb_leader_observe_seconds', 0.99); return v == null ? null : v * 1e6 })(),
      // Counter registers lazily on first drop — absent means zero drops.
      leader_queue_dropped: (() => {
        for (const [k, v] of Object.entries(m))
          if (k.startsWith('arb_leader_queue_dropped_total')) return v
        return 0
      })(),
      current_block: m['arb_current_block'] ?? null,
    }
  }
  res.json(out)
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

// ── Metrics history — powers the Report page's selectable windows ──────
// 60s snapshots of the counters the report analyzes. Raw for 48h, then
// compacted to 15-min buckets; 90-day cap. Persisted like the profit log.
const HIST_LOG = path.join(__dirname, '.metrics-history.json')
let histLog = []
try { histLog = JSON.parse(fs.readFileSync(HIST_LOG, 'utf8')) } catch {}

const HIST_KEYS = [
  'arb_paths_evaluated_total', 'arb_profitable_found_total',
  'arb_gross_profit_usd_total', 'arb_net_profit_usd_total',
  'arb_scan_latency_seconds_count', 'arb_scan_latency_seconds_sum',
  'arb_state_refresh_seconds_count', 'arb_state_refresh_seconds_sum',
  'arb_backrun_candidates_total', 'arb_submit_attempts_total',
  'arb_warp_spend_usd_total', 'arb_current_block',
  'arb_gas_spent_wei_total', 'arb_path_suppressed_total',
  'arb_builder_sim_reject_total',
]

async function sampleHistory() {
  const snap = { t: Date.now(), chains: {} }
  for (const c of Object.keys(CHAINS)) {
    try {
      const m = await fetchMetrics(c)
      const o = {}
      for (const k of HIST_KEYS) o[k] = m[k] || 0
      // Token-labeled counters arrive flattened as name{token="SYM"}.
      for (const [k, v] of Object.entries(m)) {
        if (k.startsWith('arb_profitable_by_token_total{') ||
            k.startsWith('arb_token_profit_usd_total{') ||
            k.startsWith('arb_submit_landed_total{')) o[k] = v
      }
      snap.chains[c] = o
    } catch { /* chain offline — record nothing */ }
  }
  if (Object.keys(snap.chains).length === 0) return
  const last = histLog[histLog.length - 1]
  if (!last || snap.t - last.t >= 55_000) histLog.push(snap)
  else Object.assign(last, snap)
  // Compact: >48h → one sample per 15-min bucket; drop >90d.
  const cutoff90 = snap.t - 90 * 86400e3
  const cutoffRaw = snap.t - 48 * 3600e3
  const buckets = new Map()
  histLog = histLog.filter(s => s.t >= cutoff90).filter(s => {
    if (s.t >= cutoffRaw) return true
    const b = Math.floor(s.t / 900_000)
    if (buckets.has(b)) return false
    buckets.set(b, true)
    return true
  })
  fs.writeFile(HIST_LOG, JSON.stringify(histLog), () => {})
}
sampleHistory()
setInterval(sampleHistory, 60_000)

const WINDOWS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, all: Infinity }

// P&L window endpoint — window is minutes, or 'all' for lifetime.
// Same reset-tolerant accumulation as /api/report.
app.get('/api/pnl', async (req, res) => {
  const q = req.query.window
  const minutes = (!q || q === 'all') ? null : Math.max(1, Number(q) || 0)
  const out = { live: isLive(), chains: {} }
  const liveMaps = {}
  for (const c of Object.keys(CHAINS)) {
    try { liveMaps[c] = await fetchMetrics(c) } catch {}
  }
  for (const c of Object.keys(CHAINS)) {
    out.chains[c] = { online: !!liveMaps[c] }
    if (minutes === null) { // lifetime — return live cumulative counters
      if (liveMaps[c]) Object.assign(out.chains[c], liveMaps[c])
      continue
    }
    const since = Date.now() - minutes * 60000
    const snaps = histLog.filter(s => s.t >= since).map(s => s.chains[c]).filter(Boolean)
    if (snaps.length < 2) continue
    const prev = {}, acc = {}
    for (const m of snaps) {
      for (const [k, v] of Object.entries(m)) {
        if (k in prev) acc[k] = (acc[k] || 0) + Math.max(0, v - prev[k])
        prev[k] = v
      }
    }
    Object.assign(out.chains[c], acc)
  }
  res.json(out)
})

app.get('/api/report', (req, res) => {
  const w = WINDOWS[req.query.window] ?? WINDOWS['24h']
  const now = Date.now()
  const samples = w === Infinity ? histLog : histLog.filter(s => s.t >= now - w)
  if (samples.length < 2) {
    return res.json({ live: isLive(), window: req.query.window || '24h',
      coverage_h: histLog.length ? (now - histLog[0].t) / 3600e3 : 0,
      samples: samples.length, chains: {}, series: [], tokens: [], recommendations: [] })
  }
  const first = samples[0], last = samples[samples.length - 1]
  const spanH = (last.t - first.t) / 3600e3 || 0
  const chains = {}
  const series = [] // per-sample totals for the time-series chart
  const tokens = {}

  for (const c of Object.keys(CHAINS)) {
    const l = last.chains[c]
    const snaps = samples.map(s => s.chains[c]).filter(Boolean)
    if (!l || snaps.length < 2) { chains[c] = { online: !!l } ; continue }
    // Counter-reset-tolerant delta: cumulative counters restart at 0 when a
    // runner restarts, so accumulate only positive increments per key.
    const prev = {}
    const acc = {}
    for (const m of snaps) {
      for (const [k, v] of Object.entries(m)) {
        if (k in prev) acc[k] = (acc[k] || 0) + Math.max(0, v - prev[k])
        prev[k] = v
      }
    }
    const d = k => acc[k] || 0
    const evals = d('arb_paths_evaluated_total')
    const hits = d('arb_profitable_found_total')
    const latCnt = d('arb_scan_latency_seconds_count')
    chains[c] = {
      online: true,
      evals, hits,
      hitRate: evals ? hits / evals : 0,
      grossUsd: d('arb_gross_profit_usd_total'),
      netUsd: d('arb_net_profit_usd_total'),
      grossPerHour: spanH ? d('arb_gross_profit_usd_total') / spanH : 0,
      hitsPerHour: spanH ? hits / spanH : 0,
      scans: latCnt,
      avgScanMs: latCnt ? (d('arb_scan_latency_seconds_sum') / latCnt) * 1000 : 0,
      avgRefreshMs: d('arb_state_refresh_seconds_count') ?
        (d('arb_state_refresh_seconds_sum') / d('arb_state_refresh_seconds_count')) * 1000 : 0,
      backruns: d('arb_backrun_candidates_total'),
      submits: d('arb_submit_attempts_total'),
      warpSpendUsd: d('arb_warp_spend_usd_total'),
      blocks: d('arb_current_block'),
    }
    // per-token attribution for this chain (reset-tolerant via acc)
    for (const [k, dv] of Object.entries(acc)) {
      const tm = k.match(/^arb_(profitable_by_token|token_profit_usd)_total\{token="([^"]+)"\}$/)
      if (!tm) continue
      const [_, kind, sym] = tm
      if (!dv) continue
      const key = `${c}:${sym}`
      tokens[key] = tokens[key] || { chain: c, token: sym, hits: 0, profitUsd: 0 }
      if (kind === 'profitable_by_token') tokens[key].hits += dv
      else tokens[key].profitUsd += dv
    }
  }

  // Time series: cumulative *within the window*, reset-tolerant (runner
  // restarts zero the counters — show accumulated increments, not dips).
  const cum = {}
  for (const s of samples) {
    const pt = { t: s.t }
    for (const c of Object.keys(CHAINS)) {
      const m = s.chains[c]
      if (!m) { pt[`${c}_gross`] = pt[`${c}_hits`] = pt[`${c}_scan_ms`] = null; continue }
      cum[c] = cum[c] || { gross: 0, hits: 0, evals: 0, prev: {} }
      const cc = cum[c]
      for (const [k, nk] of [['arb_gross_profit_usd_total', 'gross'], ['arb_profitable_found_total', 'hits'], ['arb_paths_evaluated_total', 'evals']]) {
        if (nk in cc.prev) cc[nk] += Math.max(0, (m[k] || 0) - cc.prev[nk])
        cc.prev[nk] = m[k] || 0
      }
      pt[`${c}_gross`] = cc.gross
      pt[`${c}_hits`] = cc.hits
      pt[`${c}_evals`] = cc.evals
      pt[`${c}_scan_ms`] = m.arb_scan_latency_seconds_count
        ? (m.arb_scan_latency_seconds_sum / m.arb_scan_latency_seconds_count) * 1000 : null
    }
    series.push(pt)
  }

  // Recommendations — every rule reads the window's real numbers only.
  const recs = []
  const names = Object.keys(chains).filter(c => chains[c].online)
  const rates = names.map(c => [c, chains[c].hitRate])
  const top = rates.sort((a, b) => b[1] - a[1])[0]
  const zeroHit = names.filter(c => chains[c].hits === 0)
  if (top && top[1] > 0)
    recs.push({ prio: 1, text: `${CHAINS[top[0]].label} leads at ${(top[1] * 100).toFixed(3)}% hit rate (${chains[top[0]].hits.toLocaleString()} profitable / ${chains[top[0]].evals.toLocaleString()} evals) — prioritize pool + token expansion on this chain first.` })
  for (const c of zeroHit)
    recs.push({ prio: 1, text: `${CHAINS[c].label} produced 0 profitable paths in the window — review pool set and token coverage before scaling it.` })
  if (!isLive())
    recs.push({ prio: 2, text: 'Engine is still dry-run — all profit figures are simulated. Verify simulation on Deployment, then go live when satisfied.' })
  const slow = names.filter(c => chains[c].avgScanMs > 150)
  for (const c of slow)
    recs.push({ prio: 2, text: `${CHAINS[c].label} avg scan ${chains[c].avgScanMs.toFixed(0)}ms exceeds the 150ms floor — premium RPC keys (gen_rpc_pool.py) cut the public-endpoint tail.` })
  for (const c of names) {
    if (chains[c].submits > 0 && chains[c].warpSpendUsd > 0)
      recs.push({ prio: 3, text: `${CHAINS[c].label} spent $${chains[c].warpSpendUsd.toFixed(2)} on paid Warp submits — tune the warp threshold if landed count stays low.` })
  }
  const tokArr = Object.values(tokens).sort((a, b) => b.profitUsd - a.profitUsd)
  const totProfit = tokArr.reduce((s, t) => s + t.profitUsd, 0)
  if (tokArr[0] && totProfit > 0 && tokArr[0].profitUsd / totProfit > 0.6)
    recs.push({ prio: 3, text: `Profit is ${(tokArr[0].profitUsd / totProfit * 100).toFixed(0)}% concentrated in ${tokArr[0].token} — diversify flash-token coverage to reduce single-market dependence.` })
  const coverage = (now - first.t) / 3600e3
  if (w !== Infinity && coverage < w / 3600e3)
    recs.push({ prio: 3, text: `History covers ${coverage.toFixed(1)}h of the selected window — longer windows fill in as the sampler runs.` })

  res.json({
    live: isLive(), window: req.query.window || '24h', span_h: spanH,
    samples: samples.length, chains, series,
    tokens: tokArr, recommendations: recs,
  })
})

async function rpc(chain, method, params) {
  const r = await fetch(CHAINS[chain].rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  })
  return (await r.json()).result
}

// User-registered accounts — MetaMask accounts detected via the Wallet
// page are persisted here so they stay in the table permanently, with
// balances refreshed on every configured chain.
const ACCT_FILE = path.join(__dirname, '.wallet-accounts.json')
let accounts = []
try { accounts = JSON.parse(fs.readFileSync(ACCT_FILE, 'utf8')) } catch {}

app.get('/api/wallet/accounts', (_req, res) => res.json({ accounts }))
app.post('/api/wallet/accounts', async (req, res) => {
  const { address, chainId, source } = req.body || {}
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) return res.status(400).json({ error: 'invalid address' })
  const key = address.toLowerCase()
  const existing = accounts.find(a => a.address === key)
  if (existing) { existing.last_chain_id = chainId ?? existing.last_chain_id; existing.seen_at = Date.now() }
  else accounts.push({ address: key, source: source || 'metamask', last_chain_id: chainId ?? null, added_at: Date.now(), seen_at: Date.now() })
  fs.writeFile(ACCT_FILE, JSON.stringify(accounts), () => {})
  // Detect balances on every configured chain right away.
  const d = {}
  for (const c of Object.keys(CHAINS)) {
    try { d[c] = await rpc(c, 'eth_getBalance', [key, 'latest']) } catch { d[c] = null }
  }
  balCache.set(key, { t: Date.now(), d: { address: key, ...d } })
  res.json({ ok: true, account: { address: key, ...d } })
})
app.delete('/api/wallet/accounts/:address', (req, res) => {
  accounts = accounts.filter(a => a.address !== req.params.address.toLowerCase())
  fs.writeFile(ACCT_FILE, JSON.stringify(accounts), () => {})
  res.json({ ok: true, accounts })
})

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
  res.json({ live: isLive(), wallets, accounts })
})

// Account nicknames — user labels for wallet rows, persisted locally.
const NICK_FILE = path.join(__dirname, '.wallet-nicknames.json')
let nicknames = {}
try { nicknames = JSON.parse(fs.readFileSync(NICK_FILE, 'utf8')) } catch {}

app.get('/api/wallet/nicknames', (_req, res) => res.json(nicknames))
app.post('/api/wallet/nicknames', (req, res) => {
  const { address, name } = req.body || {}
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) return res.status(400).json({ error: 'invalid address' })
  const key = address.toLowerCase()
  if (name && String(name).trim()) nicknames[key] = String(name).trim().slice(0, 40)
  else delete nicknames[key]
  fs.writeFile(NICK_FILE, JSON.stringify(nicknames), () => {})
  res.json({ ok: true, nicknames })
})

// Any-address multi-chain balance — used to fill per-chain columns for
// MetaMask accounts regardless of which network MetaMask is focused on.
// Result is wei hex → string; 30s cache keyed by address.
const balCache = new Map()
app.get('/api/wallet/balance', async (req, res) => {
  const address = String(req.query.address || '')
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: 'invalid address' })
  const key = address.toLowerCase()
  const hit = balCache.get(key)
  if (hit && Date.now() - hit.t < 30_000) return res.json(hit.d)
  const d = {}
  for (const c of Object.keys(CHAINS)) {
    try { d[c] = await rpc(c, 'eth_getBalance', [key, 'latest']) }
    catch { d[c] = null }
  }
  const out = { address: key, ...d }
  balCache.set(key, { t: Date.now(), d: out })
  res.json(out)
})

// Currency conversion — CoinGecko free API (no key).
let priceCache = null
let priceCacheT = 0
app.get('/api/prices', async (_req, res) => {
  if (priceCache && Date.now() - priceCacheT < 60_000) return res.json(priceCache)
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin,tether&vs_currencies=usd',
      { signal: AbortSignal.timeout(8000) })
    const j = await r.json()
    if (j?.ethereum?.usd) { priceCache = j; priceCacheT = Date.now() }
    return res.json(priceCache || j)
  } catch (e) {
    if (priceCache) return res.json(priceCache)
    res.status(502).json({ error: e.message })
  }
})

// ── Deployment workflow: Preflight → Simulation → Go-live ──────────────
// Simulation state persists beside the server so verification survives
// restarts. Go-live rewrites .env + config TOMLs and restarts the runners
// in live mode — which is exactly what auto-kills simulation.

const SIM_STATE = path.join(__dirname, '.sim-state.json')
let simState = { verified: false, verifiedAt: null }
try { simState = { ...simState, ...JSON.parse(fs.readFileSync(SIM_STATE, 'utf8')) } } catch {}
function saveSimState() { fs.writeFile(SIM_STATE, JSON.stringify(simState), () => {}) }

app.get('/api/deploy/preflight', async (_req, res) => {
  const checks = []
  for (const [c, cfg] of Object.entries(CHAINS)) {
    try {
      const m = await fetchMetrics(c)
      checks.push({ name: `${cfg.label} runner`, ok: true,
        detail: `online · block ${m.arb_current_block?.toLocaleString() ?? '?'} · ${m.arb_pool_count ?? 0} pools · ${(m.arb_scan_latency_seconds_count || 0).toLocaleString()} scans` })
    } catch (e) {
      checks.push({ name: `${cfg.label} runner`, ok: false, detail: `unreachable: ${e.message}` })
    }
  }
  // Gasless mode: sponsorship is always attempted via the Pimlico
  // paymaster. A policy (sp_...) is optional scoping — without one ops
  // are sponsored within the account's Pimlico balance. Paymaster
  // reachability is the real gate, probed live.
  const sponsorSet = !!env.ALLBRIGHTA_SPONSOR_POLICY_ID
  checks.push({ name: 'Sponsor policy (optional)', ok: true,
    detail: sponsorSet
      ? 'sp_ policy set — scoped sponsorship limits'
      : 'not set — ops sponsored within Pimlico account balance; set for spend caps' })
  for (const key of ['BSC_ARB_CONTRACT', 'BASE_ARB_CONTRACT', 'PIMLICO_API_KEY', 'PRIVATE_KEY']) {
    const set = !!env[key]
    checks.push({ name: `env ${key}`, ok: set, detail: set ? 'set' : 'missing from .env' })
  }
  res.json({
    live: isLive(),
    checks,
    advisory: [
      'Redeploy executors (ops/DEPLOY.md) — activates Balancer 0% + Aave V3 routes',
      'Sponsor policy — ALLBRIGHTA_SPONSOR_POLICY_ID for gasless UserOps',
      'Premium RPC keys — gen_rpc_pool.py --alchemy-key/… for 200+ node pool',
    ],
  })
})

app.get('/api/deploy/sim', (_req, res) => {
  // Simulation = the running dry-run fleet; metrics are the sim evidence.
  const chains = {}
  Promise.all(Object.keys(CHAINS).map(async c => {
    try {
      const m = await fetchMetrics(c)
      const evals = m.arb_paths_evaluated_total || 0
      const hits = m.arb_profitable_found_total || 0
      chains[c] = {
        online: true, evals, hits,
        hitRate: evals ? hits / evals : 0,
        grossUsd: m.arb_gross_profit_usd_total || 0,
        scans: m.arb_scan_latency_seconds_count || 0,
        submits: m.arb_submit_attempts_total || 0,
        landed: m.arb_submit_landed_total || 0,
      }
    } catch { chains[c] = { online: false } }
  })).then(() => res.json({ live: isLive(), verified: simState.verified, verifiedAt: simState.verifiedAt, chains }))
})

// Commander attestation that simulation metrics are acceptable — the
// SIMULATION_VERIFIED gate. Records locally and mirrors into .env.
app.post('/api/simulation/verify', (_req, res) => {
  simState.verified = true
  simState.verifiedAt = new Date().toISOString()
  saveSimState()
  try { setEnvFlag('SIMULATION_VERIFIED', 'true') } catch {}
  res.json({ verified: true, verifiedAt: simState.verifiedAt })
})

// Go-live requires sim verification first, then flips the engine out of
// dry-run: LIVE_COMMANDER_APPROVED=true in .env, dry_run=false in both
// chain TOMLs, and a PM2 restart — the restart IS the simulation kill.
app.post('/api/deploy/golive', async (req, res) => {
  if (req.body?.confirm !== 'GO_LIVE')
    return res.status(400).json({ error: 'confirm must be GO_LIVE' })
  if (!simState.verified)
    return res.status(409).json({ error: 'simulation not verified — run Preflight → Simulation first' })
  try {
    setEnvFlag('LIVE_COMMANDER_APPROVED', 'true')
    setEnvFlag('SIMULATION_VERIFIED', 'true')
    const flipped = []
    for (const f of ['config/bsc.toml', 'config/base.toml']) {
      const p = path.join(REPO, f)
      const t = fs.readFileSync(p, 'utf8')
      if (t.includes('dry_run = true')) {
        fs.writeFileSync(p, t.replace(/dry_run = true/, 'dry_run = false'))
        flipped.push(f)
      }
    }
    const { execFile } = await import('node:child_process')
    execFile('pm2', ['restart', 'allbrightA-bsc', 'allbrightA-base', '--update-env'],
      { timeout: 20000 }, () => {})
    res.json({
      ok: true, live: true, flipped,
      note: 'Runners restarting in live mode — simulation auto-killed.',
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Deployment registry ────────────────────────────────────────────────
// Auto-registers every deployment instance the proxy observes: keyed on
// (chain, executor contract, binary commit), so a redeploy or a new build
// appends a fresh row with its own id + timestamp — nothing manual.
const DEPLOY_LOG = path.join(__dirname, '.deployments.json')
let deployRegistry = []
try { deployRegistry = JSON.parse(fs.readFileSync(DEPLOY_LOG, 'utf8')) } catch {}

function pm2Status() {
  return new Promise(resolve => {
    import('node:child_process').then(({ execFile }) =>
      execFile('pm2', ['jlist'], { timeout: 8000 }, (_e, out) => {
        try { resolve(JSON.parse(out)) } catch { resolve([]) }
      })).catch(() => resolve([]))
  })
}

app.get('/api/deploy/instances', async (_req, res) => {
  const procs = await pm2Status()
  let commit = null
  try {
    const { execFileSync } = await import('node:child_process')
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).toString().trim()
  } catch {}
  const now = Date.now()
  const rows = []
  let dirty = false
  for (const [c, cfg] of Object.entries(CHAINS)) {
    const proc = procs.find(p => p.name === `allbrightA-${c}`)
    const contract = env[`${c.toUpperCase()}_ARB_CONTRACT`] || null
    const reader = env[`${c.toUpperCase()}_STATE_READER`] || null
    const key = `${c}:${contract}:${commit}`
    let row = deployRegistry.find(r => r.key === key)
    if (!row) {
      row = {
        key,
        id: `dep-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        instance: `allbrightA-${c}`,
        chain: c,
        contract,
        reader,
        commit,
        registered_at: new Date(now).toISOString(),
      }
      deployRegistry.push(row)
      dirty = true
    }
    rows.push({
      ...row,
      mode: isLive() ? 'LIVE' : 'dry-run',
      online: !!proc && proc.pm2_env?.status === 'online',
      pid: proc?.pid ?? null,
      uptime_ms: proc?.pm2_env?.pm_uptime ? now - proc.pm2_env.pm_uptime : null,
      restarts: proc?.pm2_env?.unstable_restarts ?? proc?.pm2_env?.restart_time ?? null,
    })
  }
  if (dirty) fs.writeFile(DEPLOY_LOG, JSON.stringify(deployRegistry), () => {})
  res.json({ live: isLive(), instances: rows })
})

// Withdrawal — manual triggers a contract withdraw call; auto is a threshold
// sweep config. Hard-gated on LIVE_COMMANDER_APPROVED like every other tx path.
let autoCfg = { enabled: false, thresholdUsd: 100, to: null }
app.get('/api/withdraw/config', (_req, res) => res.json({ live: isLive(), auto: autoCfg }))
app.post('/api/withdraw/auto', (req, res) => {
  autoCfg = { ...autoCfg, ...req.body }
  res.json({ live: isLive(), auto: autoCfg, note: isLive() ? 'armed' : 'stored (dry-run; flips live with LIVE_COMMANDER_APPROVED)' })
})
app.post('/api/withdraw', async (req, res) => {
  const { chain, to, amountWei } = req.body || {}
  if (!CHAINS[chain]) return res.status(400).json({ error: 'unknown chain' })
  if (!isLive()) return res.json({ dryRun: true, wouldCall: 'emergencyWithdraw', chain, to, amountWei })
  res.status(501).json({ error: 'live withdrawal requires Commander broadcast path — not enabled in this build' })
})

// ── Chain configuration control plane ──────────────────────────────────
// Guarded Draft → Validate → Simulate → Apply workflow. Validation and
// simulation probe the live chain; apply writes the TOML atomically and
// restarts only the affected runner. Every step lands in the audit log.
const CONFIG_FILES = { bsc: 'config/bsc.toml', base: 'config/base.toml', ethereum: 'config/ethereum.toml', polygon: 'config/polygon.toml' }
const DRAFTS_LOG = path.join(__dirname, '.config-drafts.json')
const AUDIT_LOG = path.join(__dirname, '.config-audit.json')
let drafts = []
try { drafts = JSON.parse(fs.readFileSync(DRAFTS_LOG, 'utf8')) } catch {}
let auditLog = []
try { auditLog = JSON.parse(fs.readFileSync(AUDIT_LOG, 'utf8')) } catch {}

const saveDrafts = () => fs.writeFile(DRAFTS_LOG, JSON.stringify(drafts, null, 2), () => {})
function audit(action, detail) {
  auditLog.push({ t: Date.now(), action, detail })
  if (auditLog.length > 500) auditLog = auditLog.slice(-500)
  fs.writeFile(AUDIT_LOG, JSON.stringify(auditLog, null, 2), () => {})
}

const tomlPath = c => path.join(REPO, CONFIG_FILES[c])
const readToml = c => fs.readFileSync(tomlPath(c), 'utf8')

function tomlScalar(t, key) {
  const m = t.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, 'm'))
  return m ? m[1].replace(/^["']|["'],?$/g, '') : null
}
function tomlList(t, key) {
  const m = t.match(new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'))
  if (!m) return []
  return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1])
}
function tomlSection(t, name) {
  // no /m — '$' must mean end-of-file, not end-of-line
  const m = t.match(new RegExp(`\\[${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`))
  return m ? m[1] : ''
}
function parseChainConfig(c) {
  const t = readToml(c)
  const tokens = {}
  for (const m of tomlSection(t, 'tokens').matchAll(/^\s*([A-Za-z0-9_]+)\s*=\s*"(0x[0-9a-fA-F]+)"/gm))
    tokens[m[1]] = m[2]
  const prices = {}
  for (const m of tomlSection(t, 'token_usd_prices').matchAll(/^\s*([A-Za-z0-9_]+)\s*=\s*([\d.]+)/gm))
    prices[m[1]] = parseFloat(m[2])
  const pools = [...t.matchAll(/\[\[pools\]\]([\s\S]*?)(?=\[\[pools\]\]|\n\[(?!pools)|$)/g)]
    .map(m => ({
      name: tomlScalar(m[1], 'name'),
      address: tomlScalar(m[1], 'address'),
      protocol: tomlScalar(m[1], 'protocol'),
      token0: tomlScalar(m[1], 'token0'),
      token1: tomlScalar(m[1], 'token1'),
      fee_bps: +(tomlScalar(m[1], 'fee_bps') || 0),
    }))
  const resolve = v => v ? v.replace(/\$\{([A-Z0-9_]+)\}/g, (m, k) => env[k] || m) : v
  return {
    chain_id: +(tomlScalar(t, 'chain_id') || 0),
    name: tomlScalar(t, 'name'),
    rpc_https_pool: tomlList(t, 'rpc_https_pool'),
    rpc_wss_pool: tomlList(t, 'rpc_wss_pool'),
    arb_contract: resolve(tomlScalar(t, 'arb_contract')),
    state_reader: resolve(tomlScalar(t, 'state_reader')),
    block_time_ms: +(tomlScalar(t, 'block_time_ms') || 0),
    dry_run: /dry_run\s*=\s*true/.test(t),
    flash_tokens: tomlList(t, 'flash_tokens'),
    policy: (() => {
      const s = tomlSection(t, 'policy')
      return {
        green: +(tomlScalar(s, 'expansion_green_pct') || 50) / 100,
        throttle: +(tomlScalar(s, 'expansion_throttle_pct') || 70) / 100,
        freeze: +(tomlScalar(s, 'expansion_freeze_pct') || 85) / 100,
        batch_min: +(tomlScalar(s, 'token_batch_min') || 25),
        batch_max: +(tomlScalar(s, 'token_batch_max') || 50),
      }
    })(),
    tokens, prices, pools,
    submission: {
      pimlico: /pimlico_enabled\s*=\s*true/.test(t),
      strict_4337: /strict_4337\s*=\s*true/.test(t),
      venues: ['blockrazor_url', 'nodereal_url', 'jetbldr_url', 'puissant_url', 'blink_url']
        .filter(k => (tomlScalar(t, k) || '').length > 3),
    },
  }
}

async function rpcCall(chain, method, params, timeoutMs = 3000, urls = null) {
  const pool = urls || parseChainConfig(chain).rpc_https_pool
  for (const u of pool.slice(0, 10)) {
    try {
      const r = await fetch(u, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const j = await r.json()
      if (j.result !== undefined) return j.result
    } catch {}
  }
  throw new Error('no endpoint answered')
}

// ABI helpers — eth_call to standard selectors.
const SEL = { symbol: '0x95d89b41', decimals: '0x313ce567', token0: '0x0dfe1681',
  token1: '0xd21220a7', getReserves: '0x0902f1ac', slot0: '0x3850c7bd', fee: '0xddca3f43' }
const ethCall = (chain, to, data) => rpcCall(chain, 'eth_call', [{ to, data }, 'latest'])
const decodeUint = h => (h && h !== '0x' ? BigInt(h) : null)
function decodeString(h) {
  if (!h || h === '0x') return null
  try {
    const b = Buffer.from(h.slice(2), 'hex')
    // ABI dynamic string: offset(32) + len(32) + data
    if (b.length >= 64) {
      const len = Number(BigInt('0x' + b.slice(32, 64).toString('hex')))
      if (len > 0 && len <= 64 && b.length >= 64 + len)
        return b.slice(64, 64 + len).toString('utf8').replace(/\0/g, '')
    }
    // bytes32 symbol
    return b.toString('utf8').replace(/\0/g, '') || null
  } catch { return null }
}

const goPlusCache = new Map()
async function goPlusRisk(chainId, address) {
  const key = `${chainId}:${address}`
  const hit = goPlusCache.get(key)
  if (hit && Date.now() - hit.t < 600_000) return hit.v
  let v = null
  try {
    const r = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`,
      { signal: AbortSignal.timeout(6000) })
    const j = await r.json()
    const d = j?.result?.[address.toLowerCase()]
    if (d) {
      const flags = []
      if (d.is_honeypot === '1') flags.push('honeypot')
      if (d.cannot_sell_all === '1') flags.push('cannot_sell_all')
      const tax = Math.max(parseFloat(d.buy_tax || 0), parseFloat(d.sell_tax || 0))
      if (tax > 0.1) flags.push(`tax>${(tax * 100).toFixed(0)}%`)
      // Advisory-only: proxy/hidden_owner describe most major tokens
      // (USDT, USDC, FDUSD are all proxies) — reported, not blocking.
      const advisory = []
      if (d.is_proxy === '1') advisory.push('proxy')
      if (d.hidden_owner === '1') advisory.push('hidden_owner')
      v = { flags, advisory, open_source: d.is_open_source === '1', holder_count: d.holder_count }
    }
  } catch {}
  goPlusCache.set(key, { t: Date.now(), v })
  return v
}

app.get('/api/config/chains', (_req, res) => {
  const out = {}
  for (const c of Object.keys(CONFIG_FILES)) {
    try {
      const cfg = parseChainConfig(c)
      const dexes = {}
      for (const p of cfg.pools) dexes[p.protocol || 'unknown'] = (dexes[p.protocol || 'unknown'] || 0) + 1
      out[c] = { ...cfg, dexes, label: CHAINS[c]?.label || cfg.name }
    } catch (e) { out[c] = { error: e.message } }
  }
  res.json({ live: isLive(), chains: out })
})

// Endpoint health: live eth_chainId + eth_blockNumber probes, 90s cache.
const healthCache = new Map()
app.get('/api/config/chains/:chain/health', async (req, res) => {
  const c = req.params.chain
  if (!CONFIG_FILES[c]) return res.status(404).json({ error: 'unknown chain' })
  const hit = healthCache.get(c)
  if (hit && Date.now() - hit.t < 90_000) return res.json(hit.v)
  const cfg = parseChainConfig(c)
  const probes = await Promise.all(cfg.rpc_https_pool.map(async u => {
    const t0 = Date.now()
    try {
      const cid = await rpcCall(c, 'eth_chainId', [], 1500, [u])
      const lat = Date.now() - t0
      const t1 = Date.now()
      const blk = await rpcCall(c, 'eth_blockNumber', [], 1500, [u])
      const lat2 = Date.now() - t1
      const ok = parseInt(cid, 16) === cfg.chain_id
      return { url: u.replace(/\/v1\/[a-f0-9]+/i, '/v1/•••'), ok,
        chain_id: parseInt(cid, 16), block: parseInt(blk, 16),
        ms: lat + lat2,
        status: !ok ? 'noisy' : lat + lat2 <= 400 ? 'healthy' : lat + lat2 <= 1200 ? 'degraded' : 'slow' }
    } catch (e) {
      return { url: u.replace(/\/v1\/[a-f0-9]+/i, '/v1/•••'), ok: false, status: 'down', ms: null, error: 'no answer' }
    }
  }))
  // capacity from the latest metrics snapshot + window deltas
  const last = histLog[histLog.length - 1]?.chains[c]
  const since = Date.now() - 3600e3
  const snaps = histLog.filter(s => s.t >= since).map(s => s.chains[c]).filter(Boolean)
  const prev = {}, acc = {}
  for (const m of snaps) for (const [k, v] of Object.entries(m)) {
    if (k in prev) acc[k] = (acc[k] || 0) + Math.max(0, v - prev[k]); prev[k] = v
  }
  const scans = acc['arb_scan_latency_seconds_count'] || 0
  const avgScanMs = scans ? (acc['arb_scan_latency_seconds_sum'] / scans) * 1000 : 0
  const v = {
    endpoints: probes,
    healthy: probes.filter(p => p.status === 'healthy').length,
    degraded: probes.filter(p => p.status === 'degraded' || p.status === 'slow').length,
    noisy: probes.filter(p => p.status === 'noisy').length,
    down: probes.filter(p => p.status === 'down').length,
    wss_endpoints: cfg.rpc_wss_pool.length,
    capacity: {
      avg_scan_ms: avgScanMs,
      block_time_ms: cfg.block_time_ms,
      utilization: cfg.block_time_ms ? avgScanMs / cfg.block_time_ms : 0,
      scans_last_hour: scans,
      evals_last_hour: acc['arb_paths_evaluated_total'] || 0,
      hits_last_hour: acc['arb_profitable_found_total'] || 0,
      current_block: last?.arb_current_block || 0,
      pools: cfg.pools.length,
    },
    t: Date.now(),
  }
  healthCache.set(c, { t: Date.now(), v })
  res.json(v)
})

// Fleet capacity — how much headroom remains for additional chains/tokens/
// pools. "Theoretical capacity" = the machine's CPU + memory and each chain's
// scan-budget utilization (avg scan vs block time). Alert bands: >80% warn,
// >90% critical.
app.get('/api/config/capacity', (_req, res) => {
  const cpus = os.cpus().length
  const cpuPct = Math.min(1, os.loadavg()[0] / cpus)
  const memPct = 1 - os.freemem() / os.totalmem()
  const chains = {}
  for (const c of Object.keys(CONFIG_FILES)) {
    let cfg
    try { cfg = parseChainConfig(c) } catch { continue }
    const snaps = histLog.filter(s => s.t >= Date.now() - 3600e3).map(s => s.chains[c]).filter(Boolean)
    const prev = {}, acc = {}
    for (const m of snaps) for (const [k, v] of Object.entries(m)) {
      if (k in prev) acc[k] = (acc[k] || 0) + Math.max(0, v - prev[k]); prev[k] = v
    }
    const scans = acc['arb_scan_latency_seconds_count'] || 0
    const avgScanMs = scans ? (acc['arb_scan_latency_seconds_sum'] / scans) * 1000 : 0
    const evals = acc['arb_paths_evaluated_total'] || 0
    const hits = acc['arb_profitable_found_total'] || 0
    const submits = acc['arb_submit_attempts_total'] || 0
    const landed = acc['arb_submit_landed_total'] || 0
    const gross = acc['arb_gross_profit_usd_total'] || 0
    // Chain score = opportunity_density × liquidity × net_profit × rpc stability
    // × exec success ÷ infra cost — computed from measured data only; a factor
    // with no signal is neutral (1.0) so it never fabricates ranking.
    const oppDensity = evals > 0 ? (hits / evals) * 1e6 : 0
    const rpcStability = (() => {
      const h = healthCache.get(c)?.v
      if (!h?.endpoints?.length) return 1
      return h.endpoints.filter(e => e.status === 'healthy').length / h.endpoints.length || 0.05
    })()
    const execSuccess = submits > 0 ? landed / submits : 1
    const tokenHits = {}
    for (const [k, v] of Object.entries(acc)) {
      const m = k.match(/^arb_profitable_by_token_total\{token="([^"]+)"\}$/)
      if (m) tokenHits[m[1]] = (tokenHits[m[1]] || 0) + v
    }
    const zeroHit = Object.keys(cfg.tokens).filter(s => !tokenHits[s])
    chains[c] = {
      avg_scan_ms: avgScanMs, block_time_ms: cfg.block_time_ms,
      utilization: cfg.block_time_ms ? avgScanMs / cfg.block_time_ms : 0,
      pools: cfg.pools.length, tokens: Object.keys(cfg.tokens).length,
      online: !!(histLog[histLog.length - 1]?.chains[c]),
      hits_per_m: oppDensity, gross_profit_usd: gross,
      score: oppDensity * cfg.pools.length * Math.max(gross, 0.01) * rpcStability * execSuccess,
      token_hits: tokenHits, zero_hit_tokens: zeroHit,
      batch_min: cfg.policy.batch_min, batch_max: cfg.policy.batch_max,
      _policy: cfg.policy,
    }
  }
  const scanUtil = Math.max(0, ...Object.values(chains).map(c => c.utilization))
  let runners = []
  try {
    runners = JSON.parse(execFileSync('pm2', ['jlist'], { timeout: 8000 }).toString())
      .filter(p => p.name?.startsWith('allbrightA-'))
      .map(p => ({ name: p.name, cpu: p.monit?.cpu ?? 0, mem_mb: Math.round((p.monit?.memory || 0) / 1048576) }))
  } catch {}
  const fleet = Math.max(cpuPct, memPct, scanUtil)
  // Expansion policy — thresholds come from each chain's [policy] section
  // (default 50/70/85); the fleet band uses the most conservative setting.
  const pols = Object.values(chains).map(c => c._policy).filter(Boolean)
  const greenLine = pols.length ? Math.min(...pols.map(p => p.green)) : 0.5
  const throttleLine = pols.length ? Math.min(...pols.map(p => p.throttle)) : 0.7
  const freezeLine = pols.length ? Math.min(...pols.map(p => p.freeze)) : 0.85
  const band = fleet > freezeLine ? 'freeze' : fleet > throttleLine ? 'throttle' : fleet > greenLine ? 'review' : 'green'
  res.json({
    cpu_pct: cpuPct, mem_pct: memPct, cpus,
    mem_used_gb: +((os.totalmem() - os.freemem()) / 1073741824).toFixed(1),
    mem_total_gb: +(os.totalmem() / 1073741824).toFixed(1),
    load1: os.loadavg()[0],
    scan_util: scanUtil, chains, runners,
    fleet_capacity_pct: fleet, band, expansion_eligible: band === 'green',
    policy_lines: { green: greenLine, throttle: throttleLine, freeze: freezeLine },
    headroom_chains: fleet >= greenLine ? 0 :
      Math.max(0, Math.floor((greenLine - fleet) / Math.max(0.01, fleet / Math.max(1, Object.keys(chains).length)))),
  })
})

app.post('/api/config/drafts', (req, res) => {
  const { chain, type, payload } = req.body || {}
  if (type === 'chain' ? false : !CONFIG_FILES[chain]) return res.status(400).json({ error: 'unknown chain' })
  if (!['endpoint', 'token', 'pool', 'chain'].includes(type)) return res.status(400).json({ error: 'type must be endpoint|token|pool|chain' })
  const d = { id: `dft-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    chain, type, payload, status: 'draft', created_at: Date.now(), checks: [] }
  drafts.push(d); saveDrafts()
  audit('draft.create', { id: d.id, chain, type })
  res.json(d)
})

app.get('/api/config/drafts', (_req, res) => res.json(drafts.slice(-50).reverse()))

// ── AI Ops agent ─────────────────────────────────────────────────────────
// Read-only monitoring copilot: live fleet context + anomaly feed + chat.
// Models are OpenAI-compatible endpoints (OpenAI, OpenRouter, Ollama, vLLM,
// LM Studio). Keys stay on this box in .agent-models.json (gitignored).
const AGENT_MODELS_FILE = path.join(__dirname, '.agent-models.json')
const AGENT_FEED_FILE = path.join(__dirname, '.agent-feed.json')
let agentModels = []; let agentFeed = []
try { agentModels = JSON.parse(fs.readFileSync(AGENT_MODELS_FILE, 'utf8')) } catch {}
try { agentFeed = JSON.parse(fs.readFileSync(AGENT_FEED_FILE, 'utf8')) } catch {}
const saveModels = () => fs.writeFileSync(AGENT_MODELS_FILE, JSON.stringify(agentModels, null, 1))
const saveFeed = () => fs.writeFileSync(AGENT_FEED_FILE, JSON.stringify(agentFeed.slice(-100)))

// Dashboard build commit — shown in the universal footer.
let BUILD_COMMIT = 'unknown'
try { BUILD_COMMIT = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).toString().trim() } catch {}

async function fleetBrief() {
  // Compact live context injected into every agent call + monitoring checks.
  const out = { runners: [], capacity: null, pnl: {}, hits: {}, alerts: [] }
  try {
    for (const c of Object.keys(CHAINS)) {
      const m = await fetchMetrics(c)
      out.runners.push({ chain: c, online: !!m.arb_current_block,
        block: m.arb_current_block || 0,
        scans: m['arb_scan_latency_seconds_count'] || 0,
        avg_scan_ms: m['arb_scan_latency_seconds_count']
          ? +(((m['arb_scan_latency_seconds_sum'] || 0) / m['arb_scan_latency_seconds_count']) * 1000).toFixed(1) : 0,
        evals: m.arb_paths_evaluated_total || 0, hits: m.arb_profitable_found_total || 0,
        gross: m.arb_gross_profit_usd_total || 0, net: m.arb_net_profit_usd_total || 0,
        pools: m.arb_pool_count || 0 })
    }
    const snaps = histLog.filter(s => s.t >= Date.now() - 3600e3)
    if (snaps.length) {
      const last = snaps[snaps.length - 1]
      for (const c of Object.keys(CHAINS)) {
        const prev = {}, acc = {}
        for (const s of snaps) { const m = s.chains[c]; if (!m) continue
          for (const [k, v] of Object.entries(m)) { if (k in prev) acc[k] = (acc[k]||0)+Math.max(0,v-prev[k]); prev[k]=v } }
        out.hits[c] = acc['arb_profitable_found_total'] || 0
      }
    }
  } catch {}
  try {
    const cap = await fetch(`http://127.0.0.1:${PORT}/api/config/capacity`).then(r => r.json())
    out.capacity = { pct: cap.fleet_capacity_pct, band: cap.band }
  } catch {}
  // ── anomaly checks (the agent's monitoring mission) ──
  for (const r of out.runners) {
    if (!r.online) out.alerts.push(`CRITICAL: ${r.chain} runner offline / metrics unreachable`)
    if (r.online && r.scans === 0) out.alerts.push(`WARNING: ${r.chain} reporting 0 scans`)
    const util = r.avg_scan_ms / (parseChainConfig(r.chain)?.block_time_ms || 3000)
    if (util > 0.5) out.alerts.push(`WARNING: ${r.chain} scan utilization ${(util*100).toFixed(0)}% of block budget`)
    if (out.hits[r.chain] === 0 && r.online)
      out.alerts.push(`INFO: ${r.chain} zero profitable hits in last hour`)
  }
  if (out.capacity?.band === 'throttle' || out.capacity?.band === 'freeze')
    out.alerts.push(`CRITICAL: fleet capacity ${(out.capacity.pct*100).toFixed(0)}% — expansion ${out.capacity.band}`)
  return out
}

// Monitoring watcher: every 60s compute anomalies; post new ones to the feed.
const seenAlerts = new Map()
async function watchTick() {
  try {
    const b = await fleetBrief()
    for (const a of b.alerts) {
      const last = seenAlerts.get(a) || 0
      if (Date.now() - last > 3600e3) {  // re-report at most hourly
        seenAlerts.set(a, Date.now())
        agentFeed.push({ t: Date.now(), kind: 'monitor', text: a })
      }
    }
    if (agentFeed.length > 0) saveFeed()
  } catch {}
}
setInterval(watchTick, 60_000); watchTick()

app.get('/api/agent/models', (_req, res) =>
  res.json(agentModels.map(m => ({ id: m.id, name: m.name, base_url: m.base_url, model: m.model, has_key: !!m.api_key }))))
app.post('/api/agent/models', (req, res) => {
  const { name, base_url, model, api_key } = req.body || {}
  if (!base_url || !model) return res.status(400).json({ error: 'base_url and model required' })
  const m = { id: `mdl-${Date.now().toString(36)}`, name: name || model, base_url, model, api_key: api_key || '' }
  agentModels.push(m); saveModels()
  res.json({ id: m.id, name: m.name, model: m.model })
})
app.get('/api/agent/feed', (_req, res) => res.json(agentFeed.slice(-50).reverse()))

app.post('/api/agent/chat', async (req, res) => {
  const { model_id, messages } = req.body || {}
  const brief = await fleetBrief()
  const ctx = `You are the Allbright ops copilot — READ-ONLY monitoring agent for a multichain flash-loan arbitrage engine. You observe and report; you never execute transactions or change config. Live fleet state: ${JSON.stringify(brief)}. Answer concisely from this data; if asked to act, explain it stays with the Commander.`
  const mdl = agentModels.find(m => m.id === model_id)
  if (!mdl) {
    // Rule-based fallback: answer from live data, no model needed.
    const q = (messages?.at(-1)?.content || '').toLowerCase()
    let text = 'No model configured — add one at the bottom of this panel (OpenAI-compatible: OpenAI, OpenRouter, Ollama).'
    if (/status|health|online|runner/.test(q))
      text = brief.runners.map(r => `${r.chain.toUpperCase()}: ${r.online ? `online, block ${r.block}, ${r.scans.toLocaleString()} scans, ${r.avg_scan_ms}ms avg, ${r.hits.toLocaleString()} hits, ${r.evals.toLocaleString()} evals` : 'OFFLINE'}`).join('\n') || 'no runner data'
    else if (/capacity|expansion|headroom/.test(q))
      text = `Fleet capacity ${(brief.capacity ? (brief.capacity.pct * 100).toFixed(0) + '% (' + brief.capacity.band + ')' : 'unknown')} — green ≤50%, review >50%, throttle >70%, freeze >85%.`
    else if (/profit|p&l|earned|hit/.test(q))
      text = brief.runners.map(r => `${r.chain.toUpperCase()}: ${r.hits.toLocaleString()} profitable paths, $${r.gross.toFixed(4)} gross, $${r.net.toFixed(4)} net`).join('\n') || 'no data'
    else if (/alert|anomal|problem|wrong/.test(q))
      text = brief.alerts.length ? brief.alerts.join('\n') : 'No active anomalies — fleet nominal.'
    return res.json({ text, model: 'local-rules', alerts: brief.alerts })
  }
  try {
    const r = await fetch(`${mdl.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(mdl.api_key ? { authorization: `Bearer ${mdl.api_key}` } : {}) },
      body: JSON.stringify({ model: mdl.model, messages: [{ role: 'system', content: ctx }, ...(messages || [])], temperature: 0.3 }),
      signal: AbortSignal.timeout(60000),
    })
    const j = await r.json()
    if (j.error) return res.status(502).json({ error: `${mdl.name}: ${j.error.message || JSON.stringify(j.error)}` })
    const text = j.choices?.[0]?.message?.content || '(empty response)'
    agentFeed.push({ t: Date.now(), kind: 'chat', model: mdl.name, text })
    saveFeed()
    res.json({ text, model: mdl.name, alerts: brief.alerts })
  } catch (e) { res.status(502).json({ error: `${mdl.name} unreachable: ${e.message}` }) }
})

// ── Expansion recommendation engine ─────────────────────────────────────
// Rankings come only from verifiable registries (DefiLlama TVL, chainid.network,
// canonical token lists) and live chain probes. Nothing invented — factors that
// can't be measured are reported as 'requires simulation', never scored.

const regCache = new Map()
async function registry(url, key, ttlMs = 600_000) {
  const hit = regCache.get(key)
  if (hit && Date.now() - hit.t < ttlMs) return hit.v
  let v = null
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (r.ok) v = await r.json()
  } catch {}
  regCache.set(key, { t: Date.now(), v })
  return v
}
const llamaChains = () => registry('https://api.llama.fi/v2/chains', 'llama-chains')
const llamaProtocols = () => registry('https://api.llama.fi/protocols', 'llama-protocols')
const chainRegistry = () => registry('https://chainid.network/chains.json', 'chainid', 3600e3)

// Canonical token lists — same sources the runner consumes (token_lists.rs).
const TOKEN_LISTS = {
  8453: 'https://static.optimism.io/optimism.tokenlist.json',
  56: 'https://tokens.pancakeswap.finance/pancakeswap-extended.json',
}
const LLAMA_CHAIN_NAME = { 56: 'BSC', 8453: 'Base', 1: 'Ethereum', 42161: 'Arbitrum',
  10: 'OP Mainnet', 137: 'Polygon', 43114: 'Avalanche', 324: 'zkSync Era',
  59144: 'Linea', 534352: 'Scroll', 5000: 'Mantle', 81457: 'Blast', 100: 'Gnosis',
  130: 'Unichain', 146: 'Sonic', 999: 'Hyperliquid', 80094: 'Berachain',
  1868: 'Soneium', 1135: 'Lisk', 480: 'World Chain', 747474: 'Katana', 34443: 'Mode' }

async function probeChainCandidate(entry) {
  // first registry RPC that doesn't need an API key
  const url = (entry.rpc || [])
    .map(r => typeof r === 'string' ? r : r.url)
    .find(u => /^https:\/\//.test(u) && !u.includes('${'))
  const t0 = Date.now()
  const cid = parseInt(await rpcCall(null, 'eth_chainId', [], 3000, [url]), 16)
  const b1 = parseInt(await rpcCall(null, 'eth_blockNumber', [], 3000, [url]), 16)
  await new Promise(r => setTimeout(r, 2500))
  const b2 = parseInt(await rpcCall(null, 'eth_blockNumber', [], 3000, [url]), 16)
  const lat = Date.now() - t0
  return { url, chain_id: cid, ok: cid === entry.chainId,
    block_interval_ms: b2 > b1 ? Math.round(2500 / (b2 - b1)) : null,
    latency_ms: lat, block: b2 }
}

app.get('/api/config/recommendations', async (req, res) => {
  const capFleet = await fetch(`http://127.0.0.1:${PORT}/api/config/capacity`).then(r => r.json()).catch(() => null)
  const band = capFleet?.band || 'green'
  const admissible = band === 'green' ? 'eligible' : band === 'review' ? 'review' : 'blocked'
  try {
    const [lchains, lprotos, creg] = await Promise.all([llamaChains(), llamaProtocols(), chainRegistry()])

    // ── 1. Next chains ── EVM majors not yet configured, scored on measured
    // factors: DefiLlama TVL (liquidity), live chainId probe + block interval
    // + latency, registry RPC pool size.
    const configuredIds = new Set(Object.keys(CONFIG_FILES).map(c => parseChainConfig(c).chain_id))
    const tvlByName = {}
    for (const c of lchains || []) tvlByName[c.name] = c.tvl
    const candidates = (creg || [])
      .filter(e => LLAMA_CHAIN_NAME[e.chainId] && !configuredIds.has(e.chainId))
      .map(e => ({ e, tvl: tvlByName[LLAMA_CHAIN_NAME[e.chainId]] ?? tvlByName[e.name] ?? 0 }))
      .filter(x => x.tvl > 50e6)
      .sort((a, b) => b.tvl - a.tvl).slice(0, 10)
    const chains = (await Promise.all(candidates.map(async ({ e, tvl }) => {
      try {
        const p = await probeChainCandidate(e)
        const healthyRpcs = (e.rpc || []).filter(u => /^https:\/\//.test(typeof u === 'string' ? u : u.url) && !(typeof u === 'string' ? u : u.url).includes('${')).length
        return {
          id: `chain-${e.chainId}`, kind: 'chain', name: e.name, chain_id: e.chainId,
          native: e.nativeCurrency?.symbol, tvl_usd: tvl,
          rpc_endpoints: healthyRpcs,
          rpc_health: p.ok ? (p.latency_ms < 800 ? 'healthy' : 'degraded') : 'failing',
          block_interval_ms: p.block_interval_ms, latency_ms: p.latency_ms,
          capacity_cost: p.block_interval_ms ? +(100 / p.block_interval_ms).toFixed(3) : null,
          score: p.ok ? +(Math.log10(tvl) * (800 / Math.max(p.latency_ms, 1)) *
            (p.block_interval_ms ? Math.min(2, 3000 / p.block_interval_ms) : 0.5)).toFixed(2) : 0,
          safety: 'registry-verified', simulation: 'required',
          action: band === 'green' ? 'simulate' : 'blocked', rpc_url: p.url,
        }
      } catch (err) {
        return { id: `chain-${e.chainId}`, kind: 'chain', name: e.name, chain_id: e.chainId,
          tvl_usd: tvl, rpc_health: 'failing', score: 0, safety: 'registry-verified',
          simulation: 'required', action: 'hold', error: err.message }
      }
    }))).sort((a, b) => b.score - a.score)
    chains.forEach((c, i) => c.rank = i + 1)

    // ── 2. Next tokens per configured chain ── canonical list entries not yet
    // registered; verified on-chain (deployed, symbol/decimals) + GoPlus clean
    // + DefiLlama price existence as liquidity proxy. Probes capped at 12.
    const llamaPrices = await registry('https://coins.llama.fi/prices/current/bsc:0x0000000000000000000000000000000000000000', 'warmup', 1).catch(() => null)
    const tokensByChain = {}
    for (const c of Object.keys(CONFIG_FILES)) {
      const cfg = parseChainConfig(c)
      const listUrl = TOKEN_LISTS[cfg.chain_id]
      if (!listUrl) { tokensByChain[c] = []; continue }
      const list = await registry(listUrl, `list-${cfg.chain_id}`, 3600e3)
      const registered = new Set(Object.values(cfg.tokens).map(a => a.toLowerCase()))
      const cands = (list?.tokens || [])
        .filter(t => t.chainId === cfg.chain_id && !registered.has(t.address.toLowerCase()))
        .slice(0, 40)
      const verified = []
      for (const t of cands.slice(0, 15)) {
        let ok = null, flags = []
        try {
          const code = await rpcCall(c, 'eth_getCode', [t.address, 'latest'], 3000)
          const dec = code && code !== '0x' ? decodeUint(await ethCall(c, t.address, SEL.decimals)) : null
          ok = code && code !== '0x' && dec !== null && Number(dec) === t.decimals
        } catch { ok = false }
        const risk = ok ? await goPlusRisk(cfg.chain_id, t.address) : null
        if (risk) flags = risk.flags
        verified.push({ t, ok, flags, goplus: risk ? 'clean' : 'unchecked' })
      }
      const llamaKey = LLAMA_CHAIN_NAME[cfg.chain_id]?.toLowerCase()
      const addrs = verified.filter(v => v.ok).map(v => `${llamaKey}:${v.t.address}`).join(',')
      let prices = {}
      if (addrs) {
        const pr = await registry(`https://coins.llama.fi/prices/current/${addrs}`, `px-${c}`, 600_000).catch(() => null)
        prices = pr?.coins || {}
      }
      tokensByChain[c] = verified.map(v => {
        const px = prices[`${llamaKey}:${v.t.address}`]?.price ? 1 : 0
        const clean = v.ok && v.flags.length === 0
        return {
          id: `token-${c}-${v.t.address}`, kind: 'token', chain: c,
          symbol: v.t.symbol, address: v.t.address, decimals: v.t.decimals,
          onchain_ok: !!v.ok, goplus_flags: v.flags, priced: !!px,
          score: clean ? px * 2 + 1 : 0,
          safety: !v.ok ? 'on-chain check failed' : v.flags.length ? `goplus: ${v.flags.join(',')}` : 'passed',
          simulation: 'required', action: clean ? (band === 'green' ? 'simulate' : 'blocked') : 'reject',
        }
      }).filter(x => x.onchain_ok !== false).sort((a, b) => b.score - a.score)
      tokensByChain[c].forEach((t, i) => t.rank = i + 1)
    }

    // ── 3. Next DEXes per configured chain ── DefiLlama DEX protocols by
    // chain TVL; configured protocols excluded; registry-verified only.
    // DefiLlama names BSC 'Binance' in protocol chain lists (vs 'BSC' in
    // /v2/chains) — separate map for the protocols endpoint.
    const LLAMA_PROTO_NAME = { 56: 'Binance', 8453: 'Base', 1: 'Ethereum', 42161: 'Arbitrum',
      10: 'Optimism', 137: 'Polygon', 43114: 'Avalanche', 324: 'ZKsync Era', 59144: 'Linea',
      534352: 'Scroll', 5000: 'Mantle', 81457: 'Blast', 100: 'Gnosis', 130: 'Unichain',
      146: 'Sonic', 999: 'HyperEVM', 80094: 'Berachain', 1868: 'Soneium', 480: 'World Chain' }
    const dexesByChain = {}
    for (const c of Object.keys(CONFIG_FILES)) {
      const cfg = parseChainConfig(c)
      const llamaName = LLAMA_PROTO_NAME[cfg.chain_id]
      const have = new Set(cfg.pools.map(p => (p.name || '').toLowerCase()))
      const protos = (lprotos || [])
        .filter(p => p.category === 'Dexs' && (p.chains || []).includes(llamaName))
        .map(p => ({ p, tvl: p.chainTvls?.[llamaName] ?? 0 }))
        .sort((a, b) => b.tvl - a.tvl).slice(0, 8)
      dexesByChain[c] = protos.map(({ p, tvl }, i) => ({
        id: `dex-${c}-${p.slug}`, kind: 'dex', chain: c, name: p.name, slug: p.slug,
        tvl_usd: tvl, audits: p.audits || 0, listed: p.listedAt,
        coverage: have.has(p.slug) || have.has(p.name.toLowerCase()) ? 'configured' : 'not-configured',
        score: +(Math.log10(Math.max(tvl, 1)) * (p.audits ? 1.2 : 1)).toFixed(2),
        safety: 'defillama-verified', simulation: 'required',
        action: 'add pools via draft', rank: i + 1,
      })).filter(d => d.coverage === 'not-configured')
      dexesByChain[c].forEach((d, i) => d.rank = i + 1)
    }

    res.json({ band, admissible, chains, tokens: tokensByChain, dexes: dexesByChain })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Promote a recommendation into the existing draft workflow.
app.post('/api/config/recommendations/:id/promote', (req, res) => {
  const { kind, chain, payload } = req.body || {}
  const d = { id: `dft-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    chain: kind === 'chain' ? (payload?.name || 'new') : chain,
    type: kind === 'chain' ? 'chain' : kind, payload,
    status: 'draft', created_at: Date.now(), checks: [], promoted_from: req.params.id }
  drafts.push(d); saveDrafts()
  audit('recommendation.promote', { rec: req.params.id, id: d.id, kind })
  res.json({ ok: true, draft: d })
})

async function validateDraft(d) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  const p = d.payload || {}
  if (d.type === 'chain') {
    // New-chain onboarding draft — probes the declared RPC against the
    // declared chain ID; prerequisites (contract, env keys) are advisory.
    const name = (p.name || '').trim().toLowerCase()
    const cid = +(p.chain_id || 0)
    const url = (p.rpc_url || '').trim()
    add('name format', /^[a-z][a-z0-9-]{1,15}$/.test(name), name || 'missing')
    add('config slot free', !CONFIG_FILES[name] && !fs.existsSync(path.join(REPO, 'config', `${name}.toml`)),
      CONFIG_FILES[name] ? 'already configured' : 'new')
    add('chain_id', cid > 0, cid || 'missing')
    try {
      const got = parseInt(await rpcCall(null, 'eth_chainId', [], 3000, [url]), 16)
      add('eth_chainId matches', got === cid, `got ${got}, want ${cid}`)
      const blk = parseInt(await rpcCall(null, 'eth_blockNumber', [], 3000, [url]), 16)
      add('block progressing', blk > 0, `block ${blk}`)
    } catch (e) { add('rpc answers', false, e.message) }
    const keyBase = name.toUpperCase().replace(/-/g, '_')
    add('env: RPC+WSS urls', !!(env[`${keyBase}_RPC_URL`] && env[`${keyBase}_WSS_URL`]),
      env[`${keyBase}_RPC_URL`] ? 'set' : `needs ${keyBase}_RPC_URL / _WSS_URL`)
    add('env: executor contract', !!env[`${keyBase}_ARB_CONTRACT`],
      env[`${keyBase}_ARB_CONTRACT`] ? env[`${keyBase}_ARB_CONTRACT`].slice(0, 12) + '…' : `needs ${keyBase}_ARB_CONTRACT (deploy via ops/DEPLOY.md)`)
    const fleet = Math.max(Math.min(1, os.loadavg()[0] / os.cpus().length),
      1 - os.freemem() / os.totalmem())
    // Expansion is gated at the throttle line: >70% blocks new chains.
    add('capacity headroom', fleet < 0.7,
      `fleet at ${(fleet * 100).toFixed(0)}% — green≤50%, review>50%, throttle>70%, freeze>85%`)
    d.checks = checks; d.validated_at = Date.now()
    d.status = checks.every(x => x.ok) ? 'validated' : 'rejected'
    return checks
  }
  const cfg = parseChainConfig(d.chain)
  if (d.type === 'endpoint') {
    const u = (p.url || '').trim()
    add('https URL', /^https:\/\//.test(u), u ? 'https scheme required for probing' : 'missing url')
    try {
      const cid = await rpcCall(d.chain, 'eth_chainId', [], 3000, [u])
      add('eth_chainId match', parseInt(cid, 16) === cfg.chain_id, `got ${parseInt(cid, 16)}, want ${cfg.chain_id}`)
      const t0 = Date.now()
      const blk = await rpcCall(d.chain, 'eth_blockNumber', [], 3000, [u])
      add('block progressing', parseInt(blk, 16) > 0, `block ${parseInt(blk, 16)} @ ${Date.now() - t0}ms`)
    } catch (e) { add('endpoint answers', false, e.message) }
    add('not duplicate', !cfg.rpc_https_pool.includes(u), cfg.rpc_https_pool.includes(u) ? 'already in pool' : 'new')
  }
  if (d.type === 'token') {
    const sym = (p.symbol || '').trim()
    const addr = (p.address || '').trim()
    add('symbol', /^[A-Za-z0-9_.-]{2,16}$/.test(sym), sym)
    add('address format', /^0x[0-9a-fA-F]{40}$/.test(addr), addr)
    try {
      const code = await rpcCall(d.chain, 'eth_getCode', [addr, 'latest'], 4000)
      add('contract deployed', code && code !== '0x', `${(code?.length || 0) / 2 | 0} bytes`)
    } catch (e) { add('contract deployed', false, e.message) }
    try {
      const dec = decodeUint(await ethCall(d.chain, addr, SEL.decimals))
      add('decimals() live', dec !== null && dec >= 0n && dec <= 36n, dec?.toString())
      if (dec != null) p.decimals = Number(dec)
    } catch (e) { add('decimals() live', false, e.message) }
    try {
      const liveSym = decodeString(await ethCall(d.chain, addr, SEL.symbol))
      add('symbol() matches', !!liveSym && liveSym.toUpperCase() === sym.toUpperCase(), liveSym || 'unreadable')
    } catch (e) { add('symbol() matches', false, e.message) }
    add('not duplicate', !Object.values(cfg.tokens).some(a => a.toLowerCase() === addr.toLowerCase()),
      Object.values(cfg.tokens).some(a => a.toLowerCase() === addr.toLowerCase()) ? 'already registered' : 'new')
    const risk = await goPlusRisk(cfg.chain_id, addr)
    if (risk) {
      add('GoPlus clean', risk.flags.length === 0, risk.flags.join(', ') || 'no flags')
      if (risk.advisory?.length) add('GoPlus advisory', true, risk.advisory.join(', '))
    }
    else add('GoPlus lookup', true, 'unreachable — advisory only')
  }
  if (d.type === 'pool') {
    const addr = (p.address || '').trim()
    add('address format', /^0x[0-9a-fA-F]{40}$/.test(addr), addr)
    add('protocol', ['v2', 'v3', 'algebra', 'aero', 'pcs', 'dodo', 'wombat'].includes(p.protocol), p.protocol || 'missing')
    try {
      const code = await rpcCall(d.chain, 'eth_getCode', [addr, 'latest'], 4000)
      add('contract deployed', code && code !== '0x', `${(code?.length || 0) / 2 | 0} bytes`)
    } catch (e) { add('contract deployed', false, e.message) }
    try {
      const t0 = decodeUint(await ethCall(d.chain, addr, SEL.token0))
      const t1 = decodeUint(await ethCall(d.chain, addr, SEL.token1))
      const a0 = t0 ? '0x' + t0.toString(16).padStart(40, '0') : null
      const a1 = t1 ? '0x' + t1.toString(16).padStart(40, '0') : null
      add('token0()/token1() readable', !!a0 && !!a1, `${a0?.slice(0, 10)}… / ${a1?.slice(0, 10)}…`)
      if (a0 && a1) {
        const s0 = Object.entries(cfg.tokens).find(([, a]) => a.toLowerCase() === a0.toLowerCase())?.[0]
        const s1 = Object.entries(cfg.tokens).find(([, a]) => a.toLowerCase() === a1.toLowerCase())?.[0]
        add('tokens registered', !!s0 && !!s1,
          `${s0 || a0.slice(0, 10) + '…(unregistered)'} / ${s1 || a1.slice(0, 10) + '…(unregistered)'}`)
        p.token0 = p.token0 || s0; p.token1 = p.token1 || s1
      }
    } catch (e) { add('pool interface probe', false, e.message) }
    add('not duplicate', !cfg.pools.some(x => x.address?.toLowerCase() === addr.toLowerCase()),
      cfg.pools.some(x => x.address?.toLowerCase() === addr.toLowerCase()) ? 'already in pools' : 'new')
  }
  d.checks = checks
  d.validated_at = Date.now()
  d.status = checks.every(x => x.ok) ? 'validated' : 'rejected'
  return checks
}

app.post('/api/config/drafts/:id/validate', async (req, res) => {
  const d = drafts.find(x => x.id === req.params.id)
  if (!d) return res.status(404).json({ error: 'no draft' })
  const checks = await validateDraft(d)
  saveDrafts(); audit('draft.validate', { id: d.id, status: d.status })
  res.json(d)
})

app.post('/api/config/drafts/:id/simulate', async (req, res) => {
  const d = drafts.find(x => x.id === req.params.id)
  if (!d) return res.status(404).json({ error: 'no draft' })
  if (d.status !== 'validated') return res.status(409).json({ error: 'validate first', status: d.status })
  const p = d.payload || {}
  const sim = []
  const add = (name, ok, detail) => sim.push({ name, ok, detail })
  try {
    if (d.type === 'endpoint') {
      const t0 = Date.now()
      const blk1 = parseInt(await rpcCall(d.chain, 'eth_blockNumber', [], 3000, [p.url]), 16)
      add('stable read path', blk1 > 0, `block ${blk1} in ${Date.now() - t0}ms`)
    }
    if (d.type === 'token') {
      const dec = decodeUint(await ethCall(d.chain, p.address, SEL.decimals))
      add('transfer surface readable', dec !== null, `decimals ${dec}`)
    }
    if (d.type === 'pool') {
      let liq = null
      try { liq = decodeUint(await ethCall(d.chain, p.address, SEL.getReserves)) } catch {}
      if (!liq) { try { liq = decodeUint(await ethCall(d.chain, p.address, SEL.slot0)) } catch {} }
      add('live reserves/state', liq !== null && liq > 0n, liq ? 'liquidity present' : 'empty/unreadable')
    }
    if (d.type === 'chain') {
      // Re-probe the declared RPC + re-check fleet capacity — a chain may
      // only be onboarded when the machine has headroom (<90%).
      const blk = parseInt(await rpcCall(null, 'eth_blockNumber', [], 3000, [p.rpc_url]), 16)
      add('rpc stable', blk > 0, `block ${blk}`)
      const fleet = Math.max(Math.min(1, os.loadavg()[0] / os.cpus().length),
        1 - os.freemem() / os.totalmem())
      add('fleet headroom <70% (throttle)', fleet < 0.7, `${(fleet * 100).toFixed(0)}%`)
    }
  } catch (e) { add('simulation probe', false, e.message) }
  d.sim = sim
  d.simulated_at = Date.now()
  d.status = sim.every(x => x.ok) ? 'sim_passed' : 'sim_failed'
  saveDrafts(); audit('draft.simulate', { id: d.id, status: d.status })
  res.json(d)
})

app.post('/api/config/drafts/:id/apply', (req, res) => {
  const d = drafts.find(x => x.id === req.params.id)
  if (!d) return res.status(404).json({ error: 'no draft' })
  if (d.status !== 'sim_passed') return res.status(409).json({ error: 'simulate first', status: d.status })
  const p = d.payload || {}
  if (d.type === 'chain') {
    // Scaffold the new chain's config; the runner starts once the Commander
    // deploys the executor and fills the env keys (audited either way).
    const name = (p.name || '').trim().toLowerCase()
    const file = path.join(REPO, 'config', `${name}.toml`)
    const scaffold = `[chain]
chain_id = ${p.chain_id}
name = "${name.toUpperCase()}"
rpc_https = "\${${name.toUpperCase()}_RPC_URL}"
rpc_https_pool = [
    "${p.rpc_url}",
]
rpc_wss = "\${${name.toUpperCase()}_WSS_URL}"
rpc_wss_pool = []
trader_rpc = ""
arb_contract = "\${${name.toUpperCase()}_ARB_CONTRACT}"
state_reader = "\${${name.toUpperCase()}_STATE_READER}"
block_time_ms = ${p.block_time_ms || 2000}
scan_budget_ms = 800

[wallet]
private_key_env = "PRIVATE_KEY"

[scanner]
flash_tokens = []
min_profit_bps = 3
min_initial_bps = 2
optimization_iterations = 30
dry_run = true

[gate]
min_profit_usd = 0.50
safety_margin_bps = 10
stable_pool_extra_margin_bps = 5

[submission]
strict_4337 = true
direct_fallback = false

[tokens]
`
    try {
      fs.writeFileSync(file, scaffold)
      d.status = 'applied'; d.applied_at = Date.now(); saveDrafts()
      audit('draft.apply', { id: d.id, ok: true, scaffolded: file })
      return res.json({ ok: true, draft: d, scaffolded: `config/${name}.toml`,
        next_steps: [
          `deploy executor on ${name} (ops/DEPLOY.md)`,
          `set ${name.toUpperCase()}_RPC_URL / _WSS_URL / _ARB_CONTRACT / _STATE_READER in .env`,
          `add pm2 app allbrightA-${name} (interpreter target/release/arb-runner, config ${file})`,
        ] })
    } catch (e) {
      audit('draft.apply', { id: d.id, ok: false, error: e.message })
      return res.status(500).json({ error: `scaffold failed: ${e.message}` })
    }
  }
  const file = tomlPath(d.chain)
  let t = readToml(d.chain)
  try {
    if (d.type === 'endpoint') {
      t = t.replace(/(rpc_https_pool\s*=\s*\[[\s\S]*?)\]/,
        (m, head) => `${head}    "${p.url}",\n]`)
    }
    if (d.type === 'token') {
      t = t.replace(/(\[tokens\][\s\S]*?)(\n\[\[|\n\[|$)/,
        (m, body, tail) => `${body.replace(/\s+$/, '')}\n${p.symbol} = "${p.address}"\n${tail}`)
    }
    if (d.type === 'pool') {
      const name = `${(p.protocol || 'dex').toUpperCase()}_${p.token0 || '?'}_${p.token1 || '?'}`
      t = `${t.replace(/\s+$/, '')}\n\n[[pools]]\nname = "${name}"\naddress = "${p.address}"\nprotocol = "${p.protocol}"\ntoken0 = "${p.token0}"\ntoken1 = "${p.token1}"\nfee_bps = ${p.fee_bps || 30}\n`
    }
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, t); fs.renameSync(tmp, file) // atomic replace
  } catch (e) {
    audit('draft.apply', { id: d.id, ok: false, error: e.message })
    return res.status(500).json({ error: `write failed: ${e.message}` })
  }
  d.status = 'applied'; d.applied_at = Date.now(); saveDrafts()
  // Restart only the affected chain's runner.
  let restarted = false
  try {
    execFileSync(
      'pm2', ['restart', `allbrightA-${d.chain}`, '--update-env'], { timeout: 20_000 })
    restarted = true
  } catch (e) { /* restart failure reported below */ }
  audit('draft.apply', { id: d.id, ok: true, restarted })
  res.json({ ok: true, draft: d, restarted })
})

app.get('/api/config/audit', (_req, res) => res.json(auditLog.slice(-100).reverse()))

// ── Wallet Intelligence ────────────────────────────────────────────────
// Aggregates the leader-wallet pipeline: outcome scan (_scanned.jsonl),
// strategy registry (_strategies.jsonl), discovery log (_discovered.jsonl),
// scan cursor, per-wallet observation tails, plus live Prometheus counters.
// Missing values are null — the page renders '—' and never infers.
const readJsonl = p => {
  try {
    return fs.readFileSync(p, 'utf8').split('\n')
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

app.get('/api/wallet-intelligence', async (req, res) => {
  const out = { live: isLive(), chains: {} }
  for (const [c, cfg] of Object.entries(CHAINS)) {
    const dir = path.join(REPO, 'data', 'leaders', cfg.label)
    const scanned = readJsonl(path.join(dir, '_scanned.jsonl'))
    const strategies = readJsonl(path.join(dir, '_strategies.jsonl'))
    const discovered = readJsonl(path.join(dir, '_discovered.jsonl'))
    let cursor = null, verify = null, scanmeta = null
    try { cursor = JSON.parse(fs.readFileSync(path.join(dir, '_cursor.json'), 'utf8')) } catch {}
    try { verify = JSON.parse(fs.readFileSync(path.join(dir, '_verify.json'), 'utf8')) } catch {}
    try { scanmeta = JSON.parse(fs.readFileSync(path.join(dir, '_scanmeta.json'), 'utf8')) } catch {}
    // Honest frequency: needs the real scan window + chain block time.
    let blocksPerHour = null
    try {
      const bt = +(tomlScalar(readToml(c), 'block_time_ms') || 0)
      if (bt > 0 && scanmeta?.scanned_blocks > 0)
        blocksPerHour = 3600000 / bt / scanmeta.scanned_blocks
    } catch {}
    const freqPerHour = trades => (trades == null || blocksPerHour == null) ? null : trades * blocksPerHour
    // Same composite as the client's forgeScore — emitted so ranking is a
    // single source of truth (client falls back to local compute if absent).
    const forgeScore = r => {
      if (r.net_after_gas_usd == null) return 0
      const wr = r.win_rate ?? 0
      const freq = Math.min((r.trades ?? 0) / 20, 1)
      const w = r.class === 'bundle_backrunner' ? 1 : r.class === 'atomic_arb' ? 0.8 : 0.4
      return Math.log(1 + Math.max(0, r.net_after_gas_usd)) * (0.5 + 0.3 * wr + 0.2 * freq) * w
    }
    const forgeAction = r => {
      if (r.state === 'expired') return 'expired'
      if (r.state === 'bounded_live') return `live <$${r.max_notional_usd ?? '?'}`
      if (r.state === 'shadow') return 'shadow'
      if (r.sim_verified) return 'verified'
      if (r.state === 'replay' && r.coverage != null && r.coverage < 1) return 'import route'
      if (r.state === 'replay') return 'shadow-ready'
      return 'hold'
    }
    const stratByWallet = {}
    for (const s of strategies) stratByWallet[`${s.wallet}/${s.class}`] = s
    const discSet = new Set(discovered.map(d => d.wallet))
    const rows = []
    const inRows = new Set()
    for (const w of scanned) {
      const strat = stratByWallet[`${w.address}/${w.class}`]
        || strategies.find(s => s.wallet === w.address)
      rows.push({
        wallet: w.address, class: w.class,
        state: strat?.state ?? 'observe',
        trades: w.trade_txs ?? null, txs: w.txs ?? null,
        win_rate: w.win_rate ?? null,
        median_win_usd: w.median_win_usd ?? null,
        net_after_gas_usd: w.net_after_gas_usd ?? null,
        avg_profit_usd: (w.trade_txs > 0 && w.net_after_gas_usd != null)
          ? w.net_after_gas_usd / w.trade_txs : null,
        freq_per_hour: freqPerHour(w.trade_txs),
        shadow_precision: null, revert_rate: null,
        private_hits: w.private_hits ?? 0, atomic_txs: w.atomic_txs ?? 0,
        coverage: strat?.coverage ?? null,
        route_pools: strat?.route_pools ?? [],
        executor_family: strat?.executor_family ?? null,
        sim_verified: strat?.sim_verified ?? false,
        verified_profit_usd: strat?.verified_profit_usd ?? null,
        confidence: strat?.confidence ?? null,
        last_seen_block: strat?.last_seen_block ?? null,
        expires_at_block: strat?.expires_at_block ?? null,
        max_notional_usd: strat?.max_notional_usd ?? null,
        discovered_pending: discSet.has(w.address),
        best_tx: w.best_tx ?? null,
      })
      rows[rows.length - 1].forge_action = forgeAction(rows[rows.length - 1])
      rows[rows.length - 1].forge_score = forgeScore(rows[rows.length - 1])
      inRows.add(`${w.address}/${w.class}`)
    }
    // Registry strategies with no scan row (expired-visibility preserved).
    for (const s of strategies) {
      if (inRows.has(`${s.wallet}/${s.class}`)) continue
      rows.push({
        wallet: s.wallet, class: s.class, state: s.state,
        trades: s.sample_trades ?? null, txs: null,
        win_rate: s.win_rate ?? null,
        median_win_usd: s.median_profit_usd ?? null,
        net_after_gas_usd: s.net_pnl_usd ?? null,
        avg_profit_usd: (s.sample_trades > 0 && s.net_pnl_usd != null)
          ? s.net_pnl_usd / s.sample_trades : null,
        freq_per_hour: freqPerHour(s.sample_trades),
        shadow_precision: null, revert_rate: null,
        private_hits: 0, atomic_txs: 0,
        coverage: s.coverage ?? null, route_pools: s.route_pools ?? [],
        executor_family: s.executor_family ?? null,
        sim_verified: s.sim_verified ?? false,
        verified_profit_usd: s.verified_profit_usd ?? null,
        confidence: s.confidence ?? null,
        last_seen_block: s.last_seen_block ?? null,
        expires_at_block: s.expires_at_block ?? null,
        max_notional_usd: s.max_notional_usd ?? null,
        discovered_pending: discSet.has(s.wallet), best_tx: null,
      })
      rows[rows.length - 1].forge_action = forgeAction(rows[rows.length - 1])
      rows[rows.length - 1].forge_score = forgeScore(rows[rows.length - 1])
    }
    // Observation tails for the detail drawer (last 5 per wallet on demand —
    // cheap: files are bounded and only present for observed wallets).
    const obsTails = {}
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^0x[0-9a-fA-F]{40}\.jsonl$/.test(f)) continue
        const wallet = f.slice(0, -6)
        if (!rows.some(r => r.wallet === wallet)) continue
        const obs = readJsonl(path.join(dir, f))
        obsTails[wallet] = { count: obs.length, tail: obs.slice(-5) }
      }
    } catch {}
    // Live counters relevant to execution risk.
    let counters = {}
    try {
      const m = await fetchMetrics(c)
      counters = {
        bait_suspect: m['arb_bait_suspect_total'] ?? 0,
        submit_attempts: m['arb_submit_attempts_total'] ?? 0,
        builder_sim_rejects: m['arb_builder_sim_reject_total'] ?? 0,
        path_suppressed: m['arb_path_suppressed_total'] ?? 0,
        current_block: m['arb_current_block'] ?? null,
      }
    } catch { counters = null }
    out.chains[c] = {
      online: counters != null, cursor_block: cursor?.last_scanned_block ?? null,
      scanned_wallets: scanned.length, strategies: strategies.length,
      verify,
      rows, obs_tails: obsTails, counters,
    }
  }
  res.json(out)
})

// Actionable opportunities — the intelligence product per Commander directive:
// executable records (route + victim + sim outcome), not wallet statistics.
// Reads data/leaders/<chain>/_opportunities.jsonl, dedupes by id keeping the
// latest record, plus the live arb_opportunity_* funnel counters.
app.get('/api/opportunities', async (req, res) => {
  const out = { live: isLive(), chains: {} }
  for (const [c, cfg] of Object.entries(CHAINS)) {
    const dir = path.join(REPO, 'data', 'leaders', cfg.label)
    const byId = {}
    for (const o of readJsonl(path.join(dir, '_opportunities.jsonl'))) {
      if (o?.opportunity_id) byId[o.opportunity_id] = o
    }
    // Engine records (backrun/classic kinds) fan out to one row per candidate
    // path, but paths for the same victim/block are mutually exclusive —
    // collapse to the best net per reference so each row is one opportunity.
    const best = {}
    for (const o of Object.values(byId)) {
      const engine = /\/(backrun|classic)\//.test(o.opportunity_id || '')
      const key = engine ? `eng:${o.victim_tx || o.source_tx}` : o.opportunity_id
      if (!(key in best) || (o.allbright_net_usd || 0) > (best[key].allbright_net_usd || 0)
        || (o.allbright_net_usd || 0) === (best[key].allbright_net_usd || 0) && (o.unix_ms || 0) > (best[key].unix_ms || 0))
        best[key] = o
    }
    const rows = Object.values(best)
      .sort((a, b) => (b.allbright_net_usd || 0) - (a.allbright_net_usd || 0)
        || (b.unix_ms || 0) - (a.unix_ms || 0))
    // Funnel derived from the records (scan/profiler write the JSONL, not the
    // runner's metric registry). Live counters merge on top for matched_live /
    // submitted which only the runner emits.
    const funnel = {
      decoded: rows.length,
      replay_attempts: rows.filter(o => o.simulation_status && o.simulation_status !== 'pending').length,
      replay_positive: rows.filter(o => o.simulation_status === 'pass').length,
      actionable: rows.filter(o => o.execution_status === 'ready').length,
      matched_live: 0, submitted: 0,
    }
    for (const o of rows) {
      if (o.rejection_reason) funnel[`rejected_${o.rejection_reason}`] = (funnel[`rejected_${o.rejection_reason}`] || 0) + 1
    }
    let online = false
    try {
      const m = await fetchMetrics(c)
      online = true
      for (const [k, v] of Object.entries(m)) {
        if (k.startsWith('arb_opportunity_total{')) {
          const stage = k.match(/stage="([^"]+)"/)?.[1]
          if (stage && (stage === 'matched_live' || stage === 'submitted' || stage === 'landed' || stage === 'settled'))
            funnel[stage] = (funnel[stage] || 0) + v
        }
      }
    } catch { /* runner offline — record-derived funnel still shown */ }
    out.chains[c] = { online, funnel, rows }
  }
  res.json(out)
})

app.use(express.static(path.join(__dirname, '../dist')))
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')))

app.listen(PORT, HOST, () => console.log(`dashboard proxy on ${HOST}:${PORT} (live=${isLive()})`))
