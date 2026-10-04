import React, { useMemo, useState } from 'react'
import { useApp, fmt } from '../state.jsx'
import WalletIntelligence from './WalletIntelligence.jsx'

const D = '—' // missing values are never inferred

const usd = (v, c, p) => (v == null ? D : fmt(v, c, p))
const cnt = v => (v == null ? D : v.toLocaleString())
const ms = v => (v == null ? D : `${(v * 1000).toFixed(0)}ms`)

// Sum a counter across all its label variants: arb_x_total{a="1"} +
// arb_x_total{a="2"} + bare arb_x_total.
function total(m, name) {
  if (!m) return null
  let s = null
  for (const [k, v] of Object.entries(m)) {
    if (k === name || k.startsWith(`${name}{`)) s = (s ?? 0) + v
  }
  return s
}

// Per-label breakdown: [{label, value}] sorted desc — for reject reasons,
// venue splits, protocol margins, etc.
function byLabel(m, name, labelKey) {
  const out = []
  for (const [k, v] of Object.entries(m || {})) {
    const mm = k.match(new RegExp(`^${name}\\{[^}]*${labelKey}="([^"]+)"[^}]*\\}$`))
    if (mm) out.push({ label: mm[1], value: v })
  }
  return out.sort((a, b) => b.value - a.value)
}

// Histogram mean from a metrics map: name_sum / name_count.
function histMean(m, name) {
  const s = m?.[`${name}_sum`], c = m?.[`${name}_count`]
  return s != null && c ? s / c : null
}

// A histogram exposed with labels, e.g. arb_state_refresh_phase_seconds{phase="wall"}.
function histMeanLabeled(m, name, labelVal) {
  const s = m?.[`${name}_sum{phase="${labelVal}"}`]
  const c = m?.[`${name}_count{phase="${labelVal}"}`]
  return s != null && c ? s / c : null
}

function Card({ k, v, s, cls }) {
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div className={`v ${cls || ''}`}>{v}</div>
      <div className="s">{s}</div>
    </div>
  )
}

// ── Classic strategy panel ──────────────────────────────────────────────
// Both classic channels share one loop: resting-state evaluate_all +
// pending-tx backrun projection. Counters are the runner's own Prometheus
// gauges — every figure shown exists live; nothing is derived or estimated.
function ClassicPanel() {
  const { all, currency, prices } = useApp()
  const [chain, setChain] = useState('bsc')
  const m = all?.chains?.[chain]

  const funnel = useMemo(() => {
    if (!m) return []
    const evaluated = total(m, 'arb_paths_evaluated_total')
    const profitable = total(m, 'arb_profitable_found_total')
    const attempts = total(m, 'arb_submit_attempts_total')
    const landed = total(m, 'arb_submit_landed_total')
    const settled = total(m, 'arb_settlements_total')
    // gate rejects are a parallel loss sink, not a funnel stage — they
    // live in the cards + reason breakdown instead.
    return [
      ['evaluated', evaluated], ['profitable', profitable],
      ['submit attempts', attempts], ['landed', landed], ['settled', settled],
    ]
  }, [m])

  const rejectReasons = useMemo(() => byLabel(m, 'arb_gate_rejects_total', 'reason'), [m])
  const venues = useMemo(() => byLabel(m, 'arb_submit_by_venue_total', 'venue'), [m])
  const topTokens = useMemo(() => byLabel(m, 'arb_profitable_by_token_total', 'token').slice(0, 6), [m])

  const gross = total(m, 'arb_gross_profit_usd_total')
  const net = total(m, 'arb_net_profit_usd_total')
  const settledNet = total(m, 'arb_settled_net_usd')
  const warp = total(m, 'arb_warp_spend_usd_total')
  const gasWei = total(m, 'arb_gas_spent_wei_total')

  const backCandidates = total(m, 'arb_backrun_candidates_total')
  const backSubmitted = total(m, 'arb_backrun_submitted_total')
  const backNoVenue = total(m, 'arb_backrun_no_venue_total')
  const p2submit = histMean(m, 'arb_pending_to_submit_seconds')
  const p2eval = histMean(m, 'arb_pending_to_eval_seconds')
  const refreshWall = histMeanLabeled(m, 'arb_state_refresh_phase_seconds', 'wall')
  const refreshRpc = histMeanLabeled(m, 'arb_state_refresh_phase_seconds', 'rpc')
  const scanLat = histMean(m, 'arb_scan_latency_seconds')

  return (
    <div className="grid">
      <form className="inline" onSubmit={e => e.preventDefault()} style={{ marginBottom: 4 }}>
        <select value={chain} onChange={e => setChain(e.target.value)}>
          {Object.keys(all?.chains || { bsc: 1 }).map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
        </select>
        <span className="dim">Resting-state arb + mempool backrun — one eval loop, live counters</span>
      </form>

      <div className="grid cards">
        <Card k="Pools tracked" v={cnt(m?.arb_pool_count)} s={`block ${cnt(m?.arb_current_block)}`} />
        <Card k="Paths evaluated" v={cnt(total(m, 'arb_paths_evaluated_total'))} s="per-block refresh → evaluate_all" />
        <Card k="Profitable found" v={cnt(total(m, 'arb_profitable_found_total'))} s={`${cnt(total(m, 'arb_path_suppressed_total'))} suppressed · ${cnt(total(m, 'arb_stale_suppressed_total'))} stale`} />
        <Card k="Gate rejects" v={cnt(total(m, 'arb_gate_rejects_total'))} s={rejectReasons[0] ? `top: ${rejectReasons[0].label}` : 'net-of-gas + protocol floors'} />
        <Card k="Submits" v={cnt(total(m, 'arb_submit_attempts_total'))} s={`${cnt(total(m, 'arb_submit_landed_total'))} landed · ${cnt(total(m, 'arb_sponsorship_rejects_total'))} sponsor rejects`} />
        <Card k="Net P&L (sim counters)" v={usd(net, currency, prices)} cls={net >= 0 ? 'pos' : 'neg'}
          s={`gross ${usd(gross, currency, prices)} · settled ${usd(settledNet, currency, prices)}`} />
      </div>

      <div className="panel">
        <h3>Classic — {chain.toUpperCase()} funnel</h3>
        <table>
          <thead><tr><th>Stage</th><th>Count</th><th>% of previous</th></tr></thead>
          <tbody>
            {funnel.map(([name, v], i) => {
              const prev = i > 0 ? funnel[i - 1][1] : null
              return (
                <tr key={name}>
                  <td>{name}</td><td>{cnt(v)}</td>
                  <td className="dim">{prev && v != null ? `${((v / prev) * 100).toFixed(1)}%` : D}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="panel">
          <h3>Backrun channel</h3>
          <table>
            <tbody>
              <tr><td>candidates decoded+projected</td><td>{cnt(backCandidates)}</td></tr>
              <tr><td>bundles submitted</td><td>{cnt(backSubmitted)}</td></tr>
              <tr><td>dropped — no ordering venue</td><td>{cnt(backNoVenue)}</td></tr>
              <tr><td>pending → eval (avg)</td><td>{ms(p2eval)}</td></tr>
              <tr><td>pending → submit (avg)</td><td>{ms(p2submit)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>Loop latency (avg)</h3>
          <table>
            <tbody>
              <tr><td>refresh wall</td><td>{ms(refreshWall)}</td></tr>
              <tr><td>refresh rpc phase</td><td>{ms(refreshRpc)}</td></tr>
              <tr><td>scan latency</td><td>{ms(scanLat)}</td></tr>
              <tr><td>warp spend</td><td>{usd(warp, currency, prices)}</td></tr>
              <tr><td>gas spent</td><td>{gasWei == null ? D : `${(gasWei / 1e18).toFixed(4)} native`}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="panel">
          <h3>Gate rejects by reason</h3>
          <table><tbody>
            {rejectReasons.length === 0 && <tr><td className="dim">none recorded</td></tr>}
            {rejectReasons.slice(0, 10).map(r => (
              <tr key={r.label}><td className="mono">{r.label}</td><td>{cnt(r.value)}</td></tr>
            ))}
          </tbody></table>
        </div>
        <div className="panel">
          <h3>Submits by venue · profitable by token</h3>
          <table><tbody>
            {venues.length === 0 && <tr><td className="dim">no submits yet</td></tr>}
            {venues.map(r => (
              <tr key={r.label}><td className="mono">{r.label}</td><td>{cnt(r.value)}</td></tr>
            ))}
            {topTokens.map(r => (
              <tr key={r.label}><td>{r.label}</td><td>{cnt(r.value)} profitable</td></tr>
            ))}
          </tbody></table>
        </div>
      </div>

      <div className="dim" style={{ fontSize: 11.5 }}>
        All figures are the runner's live Prometheus counters — sim-side P&L is
        labeled as such; settled P&L is a separate counter. Read-only by design.
      </div>
    </div>
  )
}

// ── Strategies page: one sidebar home for both strategies ────────────────
export default function Strategies() {
  const [tab, setTab] = useState('classic')
  return (
    <div className="grid">
      <div className="panel" style={{ padding: '8px 12px' }}>
        <form className="inline" onSubmit={e => e.preventDefault()}>
          {[
            ['classic', 'Classic — resting arb + backrun'],
            ['intel', 'Wallet Intelligence — leader tracking'],
          ].map(([id, label]) => (
            <button key={id} type="button" className={`tag ${tab === id ? 'live' : ''}`}
              style={{ cursor: 'pointer' }} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </form>
      </div>
      {tab === 'classic' ? <ClassicPanel /> : <WalletIntelligence />}
    </div>
  )
}
