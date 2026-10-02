import React, { useState } from 'react'
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

export default function PnL() {
  const { all, currency, prices } = useApp()
  const [open, setOpen] = useState({})
  const chains = all.chains || {}
  const names = { bsc: 'BSC', base: 'Base' }

  const pnl = (m) => (m?.arb_gross_profit_usd_total || 0) - (m?.arb_warp_spend_usd_total || 0)
  const total = Object.values(chains).reduce((s, m) => s + (m ? pnl(m) : 0), 0)

  return (
    <div className="panel" style={{ marginTop: 0 }}>
      <h3>P&L by chain — click a row to expand the cost breakdown</h3>
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
        Net = cumulative effective profit of gate-passed paths minus metered spend. Gas is surfaced in wei (per-chain ETH/BNB); dry-run mode incurs no gas.
      </div>
    </div>
  )
}
