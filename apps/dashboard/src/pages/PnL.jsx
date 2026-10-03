import React, { useEffect, useState } from 'react'
import { useApp, fmt } from '../state.jsx'

const ROWS = [
  ['arb_gross_profit_usd_total', 'Gross profit (gate-passed)'],
  ['arb_warp_spend_usd_total', 'Warp/Trader spend'],
  ['arb_gas_spent_wei_total', 'Gas spent (wei)'],
  ['arb_profitable_found_total', 'Profitable paths found'],
  ['arb_submit_attempts_total', 'Submission attempts'],
  ['arb_submit_landed_total{status="landed"}', 'Bundles landed'],
  ['arb_path_suppressed_total', 'Paths suppressed'],
  ['arb_builder_sim_reject_total', 'Builder sim rejects'],
  ['arb_backrun_candidates_total', 'Backrun candidates'],
]

const WINDOWS = [
  ['5', '5 min'], ['15', '15 min'], ['30', '30 min'], ['60', '60 min'],
  ['120', '2 hours'], ['360', '6 hours'], ['720', '12 hours'], ['1440', '24 hours'],
  ['2880', '2 days'], ['4320', '3 days'], ['10080', '7 days'], ['20160', '2 weeks'], ['43200', '4 weeks'],
  ['all', 'Lifetime'],
]

export default function PnL() {
  const { all, currency, prices, refreshMs } = useApp()
  const [open, setOpen] = useState({})
  const [win, setWin] = useState('all')
  const [winData, setWinData] = useState(null)
  const names = { bsc: 'BSC', base: 'Base' }

  useEffect(() => {
    if (win === 'all') { setWinData(null); return }
    let live = true
    const load = () => fetch(`/api/pnl?window=${win}`).then(r => r.json())
      .then(d => { if (live) setWinData(d) }).catch(() => {})
    load()
    const t = setInterval(load, Math.max(refreshMs, 5000))
    return () => { live = false; clearInterval(t) }
  }, [win, refreshMs])

  const chains = win === 'all' ? (all.chains || {}) : (winData?.chains || {})

  const pnl = (m) => (m?.arb_gross_profit_usd_total || 0) - (m?.arb_warp_spend_usd_total || 0)
  const total = Object.values(chains).reduce((s, m) => s + (m ? pnl(m) : 0), 0)

  return (
    <div className="panel" style={{ marginTop: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, marginRight: 'auto' }}>P&L by chain — click a row to expand the cost breakdown</h3>
        <select className="period" value={win} onChange={e => setWin(e.target.value)}>
          {WINDOWS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>
      <table>
        <thead><tr><th>Chain</th><th>Status</th><th>Gross profit</th><th>Spend</th><th>Net P&L</th></tr></thead>
        <tbody>
          {Object.keys(names).map(c => {
            const m = chains[c]
            const gross = m?.arb_gross_profit_usd_total || 0
            const spend = m?.arb_warp_spend_usd_total || 0
            const net = gross - spend
            return (
              <React.Fragment key={c}>
                <tr className="chain" onClick={() => setOpen(o => ({ ...o, [c]: !o[c] }))}>
                  <td>{open[c] ? '▾' : '▸'} {names[c]}</td>
                  <td>{m ? <span className="tag live">online</span> : <span className="tag">offline</span>}</td>
                  <td className="pos">{fmt(gross, currency, prices)}</td>
                  <td className="neg">{fmt(spend, currency, prices)}</td>
                  <td className={net >= 0 ? 'pos' : 'neg'}>{fmt(net, currency, prices)}</td>
                </tr>
                {open[c] && ROWS.map(([k, label]) => (
                  <tr className="detail" key={k}>
                    <td colSpan={2} style={{ paddingLeft: 28 }}>{label}</td>
                    <td colSpan={3} className="mono">{m ? (m[k] ?? 0).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </React.Fragment>
            )
          })}
          <tr className="total"><td>Total</td><td /><td /><td /><td className={total >= 0 ? 'pos' : 'neg'}>{fmt(total, currency, prices)}</td></tr>
        </tbody>
      </table>
      <div className="dim" style={{ marginTop: 10, fontSize: 12 }}>
        {win === 'all'
          ? 'Net = cumulative effective profit of gate-passed paths minus metered spend.'
          : `Net = profit minus metered spend over the last ${WINDOWS.find(([k]) => k === win)?.[1] || win} (resets excluded).`}
        {' '}Gas is surfaced in wei (per-chain ETH/BNB); dry-run mode incurs no gas.
      </div>
    </div>
  )
}
