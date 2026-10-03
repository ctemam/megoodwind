import React, { useEffect, useState } from 'react'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { useApp, fmt } from '../state.jsx'
import Collap from '../Collap.jsx'

const LABEL = { bsc: 'BNB Chain', base: 'Base' }
const COLOR = { bsc: '#f0b90b', base: '#38b6ff' }
const WINDOWS = [['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All']]

export default function Report() {
  const { currency, prices, refreshMs } = useApp()
  const [win, setWin] = useState('24h')
  const [data, setData] = useState(null)

  useEffect(() => {
    let live = true
    const load = () => fetch(`/api/report?window=${win}`).then(r => r.json())
      .then(d => { if (live) setData(d) }).catch(() => {})
    load()
    const t = setInterval(load, Math.max(refreshMs, 5000))
    return () => { live = false; clearInterval(t) }
  }, [win, refreshMs])

  const chains = data?.chains || {}
  const names = ['bsc', 'base'].filter(c => chains[c]?.online)
  const totGross = names.reduce((s, c) => s + chains[c].grossUsd, 0)
  const totEvals = names.reduce((s, c) => s + chains[c].evals, 0)
  const totHits = names.reduce((s, c) => s + chains[c].hits, 0)
  const totScans = names.reduce((s, c) => s + chains[c].scans, 0)

  const chart = (data?.series || []).map(s => ({
    ...s,
    t: new Date(s.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  }))

  return (
    <div className="grid">
      {/* window selector */}
      <div className="panel" style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, marginRight: 'auto' }}>Performance report</h3>
        {WINDOWS.map(([k, label]) => (
          <button key={k} className={win === k ? 'primary' : ''} onClick={() => setWin(k)}>{label}</button>
        ))}
        <span className="dim" style={{ fontSize: 11, marginLeft: 8 }}>{data?.samples ?? 0} samples · {data?.span_h?.toFixed(1) ?? 0}h span</span>
      </div>

      {/* KPI matrix */}
      <div className="grid cards" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="card"><div className="k">Profit · {win}</div><div className="v pos">{fmt(totGross, currency, prices)}</div><div className="s">gross effective</div></div>
        <div className="card"><div className="k">Profitable paths</div><div className="v">{totHits.toLocaleString()}</div><div className="s">{totEvals.toLocaleString()} evals · {totEvals ? (totHits / totEvals * 100).toFixed(3) : 0}%</div></div>
        <div className="card"><div className="k">Blocks scanned</div><div className="v">{totScans.toLocaleString()}</div><div className="s">in window</div></div>
        <div className="card"><div className="k">Chains reporting</div><div className="v">{names.length}/2</div><div className="s">{data?.live ? 'LIVE' : 'dry-run'}</div></div>
      </div>

      {/* time series */}
      <div className="panel">
        <h3>Cumulative gross profit</h3>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chart}>
            <XAxis dataKey="t" fontSize={10} stroke="var(--dim)" />
            <YAxis hide domain={['auto', 'auto']} />
            <Tooltip contentStyle={{ background: '#0e1c38', border: '1px solid #16305a' }} formatter={(v, n) => [fmt(v ?? 0, currency, prices), LABEL[n.replace('_gross', '')]]} />
            <Legend />
            {names.map(c => (
              <Area key={c} name={LABEL[c]} dataKey={`${c}_gross`} stroke={COLOR[c]} strokeWidth={2}
                fill={COLOR[c]} fillOpacity={0.12} isAnimationActive={false} connectNulls />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="panel" style={{ marginTop: 0 }}>
          <h3>Profitable paths found (cumulative)</h3>
          <ResponsiveContainer width="100%" height={170}>
            <LineChart data={chart}>
              <XAxis dataKey="t" fontSize={10} stroke="var(--dim)" />
              <YAxis hide domain={['auto', 'auto']} />
              <Tooltip contentStyle={{ background: '#0e1c38', border: '1px solid #16305a' }} formatter={(v, n) => [v?.toLocaleString(), LABEL[n.replace('_hits', '')]]} />
              {names.map(c => (
                <Line key={c} dataKey={`${c}_hits`} stroke={COLOR[c]} dot={false} strokeWidth={2} isAnimationActive={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="panel" style={{ marginTop: 0 }}>
          <h3>Avg scan latency (ms, cumulative mean)</h3>
          <ResponsiveContainer width="100%" height={170}>
            <LineChart data={chart}>
              <XAxis dataKey="t" fontSize={10} stroke="var(--dim)" />
              <YAxis fontSize={10} stroke="var(--dim)" domain={['auto', 'auto']} width={35} />
              <Tooltip contentStyle={{ background: '#0e1c38', border: '1px solid #16305a' }} formatter={(v, n) => [`${v?.toFixed(0)}ms`, LABEL[n.replace('_scan_ms', '')]]} />
              {names.map(c => (
                <Line key={c} dataKey={`${c}_scan_ms`} stroke={COLOR[c]} dot={false} strokeWidth={2} isAnimationActive={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* per-chain analytics */}
      <Collap title="Per-chain analytics">
        <table>
          <thead><tr>
            <th>Chain</th><th>Profit</th><th>$/h</th><th>Hits</th><th>Hits/h</th>
            <th>Hit rate</th><th>Evals</th><th>Avg scan</th><th>Avg refresh</th>
            <th>Backruns</th><th>Submits</th><th>Warp spend</th>
          </tr></thead>
          <tbody>
            {names.map(c => {
              const m = chains[c]
              return (
                <tr key={c}>
                  <td>{LABEL[c]}</td>
                  <td className="pos">{fmt(m.grossUsd, currency, prices)}</td>
                  <td className="mono">{fmt(m.grossPerHour, currency, prices)}</td>
                  <td>{m.hits.toLocaleString()}</td>
                  <td className="mono">{m.hitsPerHour.toFixed(1)}</td>
                  <td>{(m.hitRate * 100).toFixed(3)}%</td>
                  <td>{m.evals.toLocaleString()}</td>
                  <td className="mono">{m.avgScanMs.toFixed(0)}ms</td>
                  <td className="mono">{m.avgRefreshMs.toFixed(0)}ms</td>
                  <td>{m.backruns.toLocaleString()}</td>
                  <td>{m.submits.toLocaleString()}</td>
                  <td className="mono">{fmt(m.warpSpendUsd, currency, prices)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Collap>

      {/* token matrix */}
      <Collap open={false} title={`Token matrix — profit attribution by flash token (${(data?.tokens || []).length})`}>
        {(data?.tokens || []).length === 0 ? (
          <div className="dim" style={{ fontSize: 12.5 }}>No token-attributed profit in this window. Counters populate as profitable paths are evaluated.</div>
        ) : (
          <table>
            <thead><tr><th>Token</th><th>Chain</th><th>Profitable paths</th><th>Profit</th><th>Share</th></tr></thead>
            <tbody>
              {data.tokens.map(t => (
                <tr key={`${t.chain}:${t.token}`}>
                  <td><b>{t.token}</b></td>
                  <td>{LABEL[t.chain] || t.chain}</td>
                  <td>{t.hits.toLocaleString()}</td>
                  <td className="pos">{fmt(t.profitUsd, currency, prices)}</td>
                  <td className="mono">{totGross ? (t.profitUsd / totGross * 100).toFixed(1) : '0'}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Collap>

      {/* recommendations */}
      <Collap title={`Recommendations (${(data?.recommendations || []).length})`}>
        {(data?.recommendations || []).length === 0 ? (
          <div className="dim" style={{ fontSize: 12.5 }}>Collecting data — recommendations appear once the window has signal.</div>
        ) : (
          data.recommendations.map((r, i) => (
            <div className="step" key={i}>
              <span className="n" style={{ color: r.prio === 1 ? 'var(--acc)' : r.prio === 2 ? 'var(--warn)' : 'var(--dim)' }}>P{r.prio}</span>
              <div style={{ fontSize: 13 }}>{r.text}</div>
            </div>
          ))
        )}
      </Collap>
    </div>
  )
}
