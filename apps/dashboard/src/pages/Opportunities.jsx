import React from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useApp } from '../state.jsx'

export default function Opportunities() {
  const { all } = useApp()
  const chains = all.chains || {}
  const data = ['bsc', 'base'].map(c => ({
    chain: c.toUpperCase(),
    evaluated: chains[c]?.arb_paths_evaluated_total || 0,
    profitable: chains[c]?.arb_profitable_found_total || 0,
    backrun: chains[c]?.arb_backrun_candidates_total || 0,
    suppressed: chains[c]?.arb_path_suppressed_total || 0,
  }))
  return (
    <div className="grid">
      <div className="grid cards">
        {data.map(d => (
          <React.Fragment key={d.chain}>
            <div className="card"><div className="k">{d.chain} profitable</div><div className="v pos">{d.profitable.toLocaleString()}</div><div className="s">of {d.evaluated.toLocaleString()} evals ({d.evaluated ? (d.profitable / d.evaluated * 100).toFixed(3) : 0}%)</div></div>
            <div className="card"><div className="k">{d.chain} backrun candidates</div><div className="v">{d.backrun.toLocaleString()}</div><div className="s">mempool-matched swaps</div></div>
          </React.Fragment>
        ))}
      </div>
      <div className="panel">
        <h3>Funnel — evaluated vs profitable vs suppressed</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data}>
            <XAxis dataKey="chain" stroke="#8a93a6" /><YAxis stroke="#8a93a6" />
            <Tooltip contentStyle={{ background: '#171d29', border: '1px solid #232a3a' }} />
            <Bar dataKey="profitable" fill="#2fd17c" name="Profitable" />
            <Bar dataKey="backrun" fill="#4f8cff" name="Backrun candidates" />
            <Bar dataKey="suppressed" fill="#ff5c6c" name="Suppressed" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
