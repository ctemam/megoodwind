import React, { useMemo, useState } from 'react'
import { useApp, fmt } from '../state.jsx'
import WalletIntelligence from './WalletIntelligence.jsx'

const D = '—' // missing values are never inferred

const usd = (v, c, p) => (v == null ? D : fmt(v, c, p))
const cnt = v => (v == null ? D : v.toLocaleString())

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
// One pipeline, four stages, two money numbers — the only view the
// Commander asked for: opportunities detected → evaluated & accepted →
// executed → settled, plus projected and realized P&L. Every figure is a
// live Prometheus counter from the runner; nothing is estimated.
function ClassicPanel() {
  const { all, currency, prices } = useApp()
  const [chain, setChain] = useState('bsc')
  const m = all?.chains?.[chain]

  const stages = useMemo(() => {
    if (!m) return []
    const detected = (total(m, 'arb_profitable_found_total') ?? 0)
                   + (total(m, 'arb_backrun_candidates_total') ?? 0)
    const accepted = total(m, 'arb_gate_accepts_total')
    const executed = (total(m, 'arb_submit_attempts_total') ?? 0)
                   + (total(m, 'arb_backrun_submitted_total') ?? 0)
    const landed = total(m, 'arb_submit_landed_total')
    const settled = total(m, 'arb_settlements_total')
    return [
      ['detected', detected],
      ['evaluated & accepted', accepted],
      ['executed', executed],
      ['landed on-chain', landed],
      ['settled', settled],
    ]
  }, [m])

  const detected = stages[0]?.[1]
  const accepted = stages[1]?.[1]
  const executed = stages[2]?.[1]
  const settled = stages[4]?.[1]
  const projected = total(m, 'arb_accepted_profit_usd_total')
  const realized = total(m, 'arb_settled_net_usd')
  const dryRun = m?.arb_dry_run
  const live = dryRun === 0

  return (
    <div className="grid">
      <form className="inline" onSubmit={e => e.preventDefault()} style={{ marginBottom: 4 }}>
        <select value={chain} onChange={e => setChain(e.target.value)}>
          {Object.keys(all?.chains || { bsc: 1 }).map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
        </select>
        <span className={`tag ${live ? 'live' : ''}`}>
          {dryRun == null ? 'MODE —' : live ? 'LIVE' : 'DRY RUN'}
        </span>
        <span className="dim">
          {cnt(m?.arb_pool_count)} pools · block {cnt(m?.arb_current_block)}
          {!live && ' · measure mode: full pipeline, submissions off until a wallet key is provisioned'}
        </span>
      </form>

      <div className="grid cards">
        <Card k="Opportunities detected" v={cnt(detected)} s="resting + backrun candidates" />
        <Card k="Evaluated & accepted" v={cnt(accepted)} s="passed profit gate" />
        <Card k="Executed" v={cnt(executed)} s="submitted on-chain" />
        <Card k="Settled" v={cnt(settled)} s="confirmed outcome" />
        <Card k="Projected P&L" v={usd(projected, currency, prices)}
          cls={projected > 0 ? 'pos' : ''} s="accepted candidates, pre-execution" />
        <Card k="Realized P&L" v={usd(realized, currency, prices)}
          cls={realized > 0 ? 'pos' : realized < 0 ? 'neg' : ''} s="net after gas, on-chain" />
      </div>

      <div className="panel">
        <h3>Opportunity pipeline — {chain.toUpperCase()}</h3>
        <table>
          <thead><tr><th>Stage</th><th>Count</th><th>% of previous</th></tr></thead>
          <tbody>
            {stages.map(([name, v], i) => {
              const prev = i > 0 ? stages[i - 1][1] : null
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

      <div className="dim" style={{ fontSize: 11.5 }}>
        Live Prometheus counters only. Projected P&L is the profit gate's own
        estimate of accepted candidates; Realized P&L is measured on-chain.
        {dryRun === 1 && ' Executed/landed/settled stay 0 in dry-run.'}
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
