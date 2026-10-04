import React from 'react'
import { AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useApp, fmt } from '../state.jsx'

const LABEL = { bsc: 'BNB Chain', base: 'Base', ethereum: 'Ethereum', polygon: 'Polygon' }
const COLORS = ['#f0b90b', '#38b6ff', '#627eea', '#8247e5']

export default function Overview() {
  const { all, currency, prices, history, profitPeriod } = useApp()
  const chains = all.chains || {}
  const names = ['bsc', 'base', 'ethereum', 'polygon']

  const sum = (k) => names.reduce((s, c) => s + (chains[c]?.[k] || 0), 0)
  const totalGross = sum('arb_gross_profit_usd_total')
  const totalFound = sum('arb_profitable_found_total')
  const totalEval = sum('arb_paths_evaluated_total')
  const latSum = sum('arb_scan_latency_seconds_sum')
  const latCnt = sum('arb_scan_latency_seconds_count') || 1
  const avgLatMs = (latSum / latCnt) * 1000
  const successRate = totalEval ? (totalFound / totalEval) * 100 : 0
  const online = names.filter(c => chains[c]).length

  const donut = names.map((c, i) => ({ name: LABEL[c], value: chains[c]?.arb_gross_profit_usd_total || 0, color: COLORS[i] }))
  const donutTotal = donut.reduce((s, d) => s + d.value, 0)

  return (
    <div className="grid">
      <div className="grid cards" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        <div className="card"><div className="k">Total profit found</div><div className="v pos">{fmt(profitPeriod === 'day' ? (all.profit?.day ?? totalGross) : totalGross, currency, prices)}</div><div className="d-up">{profitPeriod === 'day' ? 'last 24h effective USD' : 'cumulative effective USD'}</div></div>
        <div className="card"><div className="k">Hit rate</div><div className="v">{successRate.toFixed(2)}%</div><div className="s">{totalFound.toLocaleString()} / {totalEval.toLocaleString()}</div></div>
        <div className="card"><div className="k">Avg scan latency</div><div className="v">{avgLatMs.toFixed(0)}ms</div><div className="s">per-block state refresh+scan</div></div>
        <div className="card"><div className="k">Paths evaluated</div><div className="v">{(totalEval / 1e6).toFixed(2)}M</div><div className="s">math kernel evals</div></div>
        <div className="card"><div className="k">Active runners</div><div className="v">{online}/{names.length}</div><div className="s">{all.live ? 'LIVE' : 'dry-run'} fleet</div></div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        <div className="panel" style={{ marginTop: 0 }}>
          <h3>Arbitrage profit overview</h3>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={history.map(h => ({ t: new Date(h.t).toLocaleTimeString(), net: h.net }))}>
              <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#38b6ff" stopOpacity={.45} /><stop offset="100%" stopColor="#38b6ff" stopOpacity={0} />
              </linearGradient></defs>
              <XAxis dataKey="t" hide /><YAxis hide domain={['auto', 'auto']} />
              <Tooltip contentStyle={{ background: '#0e1c38', border: '1px solid #16305a' }} />
              <Area dataKey="net" stroke="#38b6ff" strokeWidth={2} fill="url(#g)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="panel" style={{ marginTop: 0 }}>
          <h3>Profit by network</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={donutTotal ? donut : [{ name: 'no profit yet', value: 1, color: '#16305a' }]}
                innerRadius={62} outerRadius={85} dataKey="value" strokeWidth={0}>
                {donut.map((d, i) => <Cell key={i} fill={donutTotal ? d.color : '#16305a'} />)}
              </Pie>
              <Tooltip contentStyle={{ background: '#0e1c38', border: '1px solid #16305a' }} formatter={(v, n) => [fmt(v, currency, prices), n]} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ textAlign: 'center', marginTop: -140, pointerEvents: 'none', position: 'relative', top: 0 }}>
            <div className="v" style={{ fontSize: 20, fontWeight: 700 }}>{fmt(donutTotal, currency, prices)}</div>
            <div className="dim" style={{ fontSize: 11 }}>total profit</div>
          </div>
          <div style={{ marginTop: 76 }}>
            {donut.map(d => {
              const pct = donutTotal ? (d.value / donutTotal * 100).toFixed(1) : '0.0'
              return (
                <div key={d.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 4px' }}>
                  <span><span style={{ color: d.color }}>●</span> {d.name}</span><span className="dim">{pct}%</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>Network performance</h3>
        <table>
          <thead><tr><th>Network</th><th>Status</th><th>Opportunities</th><th>Pools</th><th>Block</th><th>Profit</th></tr></thead>
          <tbody>
            {names.map(c => {
              const m = chains[c]
              return (
                <tr key={c}>
                  <td>{LABEL[c]}</td>
                  <td>{m ? <span className="tag live">online</span> : <span className="tag">offline</span>}</td>
                  <td>{(m?.arb_profitable_found_total || 0).toLocaleString()}</td>
                  <td>{m?.arb_pool_count ?? '—'}</td>
                  <td className="mono">{m?.arb_current_block?.toLocaleString() ?? '—'}</td>
                  <td className="pos">{fmt(m?.arb_gross_profit_usd_total || 0, currency, prices)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
