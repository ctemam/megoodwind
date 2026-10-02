import React from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useApp, fmt } from '../state.jsx'

const LABEL = { bsc: 'BSC', base: 'Base' }

export default function Overview() {
  const { all, currency, prices, history } = useApp()
  const chains = all.chains || {}
  const up = (c) => !!chains[c]

  const totalGross = Object.values(chains).reduce((s, c) => s + (c?.arb_gross_profit_usd_total || 0), 0)
  const totalFound = Object.values(chains).reduce((s, c) => s + (c?.arb_profitable_found_total || 0), 0)
  const totalEval = Object.values(chains).reduce((s, c) => s + (c?.arb_paths_evaluated_total || 0), 0)
  const totalAttempts = Object.values(chains).reduce((s, c) => s + (c?.arb_submit_attempts_total || 0), 0)

  return (
    <div className="grid">
      <div className="grid cards">
        <div className="card"><div className="k">Net profit found</div><div className="v pos">{fmt(totalGross, currency, prices)}</div><div className="s">cumulative effective USD</div></div>
        <div className="card"><div className="k">Profitable paths</div><div className="v">{totalFound.toLocaleString()}</div><div className="s">passed gate since boot</div></div>
        <div className="card"><div className="k">Paths evaluated</div><div className="v">{(totalEval / 1e6).toFixed(2)}M</div><div className="s">math kernel evals</div></div>
        <div className="card"><div className="k">Submissions</div><div className="v">{totalAttempts}</div><div className="s">{all.live ? 'live bundles' : 'dry-run gated'}</div></div>
      </div>

      <div className="panel">
        <h3>Profit pulse — cumulative gross USD</h3>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={history.map(h => ({ t: new Date(h.t).toLocaleTimeString(), net: h.net }))}>
            <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4f8cff" stopOpacity={.4} /><stop offset="100%" stopColor="#4f8cff" stopOpacity={0} />
            </linearGradient></defs>
            <XAxis dataKey="t" hide /><YAxis hide domain={['auto', 'auto']} />
            <Tooltip contentStyle={{ background: '#171d29', border: '1px solid #232a3a' }} />
            <Area dataKey="net" stroke="#4f8cff" fill="url(#g)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid cards" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {['bsc', 'base'].map(c => {
          const m = chains[c]
          return (
            <div className="card" key={c}>
              <div className="k">{LABEL[c]} <span className={`tag ${m ? 'live' : ''}`}>{m ? 'online' : 'offline'}</span></div>
              <div className="v">{m ? fmt(m.arb_gross_profit_usd_total || 0, currency, prices) : '—'}</div>
              <div className="s">{m ? `block ${m.arb_current_block?.toLocaleString() ?? '—'} · ${m.arb_pool_count ?? 0} pools` : 'metrics endpoint unreachable'}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
