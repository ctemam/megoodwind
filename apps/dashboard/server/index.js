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
  res.json({ live: isLive(), chains: out, profit: profitSummary(net) })
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
            k.startsWith('arb_token_profit_usd_total{')) o[k] = v
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
  res.json({ live: isLive(), wallets })
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

app.use(express.static(path.join(__dirname, '../dist')))
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')))

app.listen(PORT, () => console.log(`dashboard proxy on :${PORT} (live=${isLive()})`))
