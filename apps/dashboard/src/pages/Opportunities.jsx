import React, { useEffect, useMemo, useState } from 'react'
import { useApp } from '../state.jsx'
import { useSort } from '../Sortable.jsx'

const D = '—' // missing values are never inferred
const trunc = a => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : D)
const usd = v => (v == null || v === 0 ? D : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
const bps = v => (v == null || v === 0 ? D : `${v.toFixed(0)}`)
const hhmmss = v => (v == null ? D : new Date(v).toTimeString().slice(0, 8))
const pct = v => (v == null ? D : `${(v * 100).toFixed(0)}%`)

const SIM_STYLE = { pass: 'live', fail: '', pending: 'dry', unusable: '' }
const EXEC_STYLE = {
  none: '', ready: 'dry', submitted: 'dry',
  landed: 'live', settled: 'live', reverted: '', dropped: '',
}

// Strategy from the record id: engine rows are <...>/backrun/<...> or
// <...>/classic/<...>; everything else is a leader (wallet-copy) signal.
function laneOf(o) {
  const id = o.opportunity_id || ''
  if (id.includes('/backrun/')) return 'backrun'
  if (id.includes('/classic/')) return 'atomic arb'
  return 'wallet copy'
}

export default function Opportunities() {
  const { refreshMs } = useApp()
  const [data, setData] = useState(null)
  const [chain, setChain] = useState('all')
  const [lane, setLane] = useState('all')
  const [showRejected, setShowRejected] = useState(true)

  useEffect(() => {
    let dead = false
    const tick = async () => {
      try {
        const r = await fetch('/api/opportunities')
        if (r.ok && !dead) setData(await r.json())
      } catch {}
    }
    tick(); const t = setInterval(tick, refreshMs || 10000)
    return () => { dead = true; clearInterval(t) }
  }, [refreshMs])

  const chains = Object.keys(data?.chains || {})

  // Single merged feed across chains — one chronological list where a
  // wallet-copy signal and a pool-scan arb sit side by side.
  const rows = useMemo(() => {
    const out = []
    for (const [c, cd] of Object.entries(data?.chains || {})) {
      for (const o of cd?.rows || []) {
        out.push({
          ...o,
          chain: c.toUpperCase(),
          lane: laneOf(o),
          time: o.unix_ms ?? o.detected_ms ?? null,
          edge: o.allbright_net_usd ?? o.leader_net_usd ?? null,
        })
      }
    }
    return out
      .filter(o => chain === 'all' || o.chain === chain.toUpperCase())
      .filter(o => lane === 'all' || o.lane === lane)
      .filter(o => showRejected || o.simulation_status === 'pass')
  }, [data, chain, lane, showRejected])

  const [sorted, th] = useSort(rows, ['time', -1])
  const actionable = rows.filter(r => r.execution_status === 'ready' && !r.rejection_reason)
  const funnel = useMemo(() => {
    const f = { decoded: 0, replay_attempts: 0, replay_positive: 0, actionable: 0, matched_live: 0, submitted: 0, landed: 0, settled: 0 }
    for (const cd of Object.values(data?.chains || {})) {
      for (const [k, v] of Object.entries(cd?.funnel || {})) {
        if (k in f) f[k] += v || 0
      }
    }
    return f
  }, [data])

  return (
    <div className="grid">
      <div className="grid cards">
        <div className="card"><div className="k">Signals</div><div className="v">{rows.length}</div><div className="s">in view</div></div>
        <div className="card"><div className="k">Actionable</div><div className="v pos">{actionable.length}</div><div className="s" title="survived the runner's real-state re-check">live-verified</div></div>
        <div className="card"><div className="k">Replay positive</div><div className="v">{funnel.replay_positive ?? D}</div><div className="s">of {funnel.replay_attempts ?? D}</div></div>
        <div className="card"><div className="k">Matched live</div><div className="v">{funnel.matched_live ?? D}</div><div className="s">verified route hit</div></div>
        <div className="card"><div className="k">Submitted</div><div className="v">{funnel.submitted ?? D}</div><div className="s">landed {funnel.landed ?? D} · settled {funnel.settled ?? D}</div></div>
      </div>

      <div className="panel">
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Opportunity feed</h3>
          <div className="tabs">
            <button className={`tab${chain === 'all' ? ' on' : ''}`} onClick={() => setChain('all')}>ALL</button>
            {chains.map(c => (
              <button key={c} className={`tab${c === chain ? ' on' : ''}`} onClick={() => setChain(c)}>{c.toUpperCase()}</button>
            ))}
            <span className="dim">|</span>
            {['all', 'wallet copy', 'backrun', 'atomic arb'].map(l => (
              <button key={l} className={`tab${l === lane ? ' on' : ''}`} onClick={() => setLane(l)}>{l}</button>
            ))}
            <button className={`tab${showRejected ? ' on' : ''}`} onClick={() => setShowRejected(v => !v)}>
              {showRejected ? 'all' : 'pass only'}
            </button>
          </div>
        </div>
        <table className="tbl">
          <thead><tr>
            {th('time', 'Time')}{th('source_wallet', 'Source')}{th('lane', 'Strategy')}
            {th('chain', 'Chain')}{th('route_n', 'Route')}{th('edge', 'Edge est.')}
            {th('confidence', 'Conf')}{th('simulation_status', 'Sim')}
            {th('execution_status', 'Outcome')}{th('rejection_reason', 'Kill stage')}
          </tr></thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan="10" className="muted">No {showRejected ? '' : 'passing '}opportunity records.</td></tr>
            )}
            {sorted.map((o, i) => (
              <tr key={o.opportunity_id || i}>
                <td className="mono dim">{hhmmss(o.time)}</td>
                <td title={`${o.source_wallet} · ${o.source_tx}`}>{trunc(o.source_wallet || o.victim_tx)}</td>
                <td>{o.lane}</td>
                <td>{o.chain}</td>
                <td title={o.route_pools?.join('\n')}>{o.route_pools?.length || 0} pools</td>
                <td className="num pos">{usd(o.edge)}</td>
                <td className="num">{o.confidence != null ? pct(o.confidence) : D}</td>
                <td><span className={`tag ${SIM_STYLE[o.simulation_status] || ''}`}>{o.simulation_status || D}</span></td>
                <td><span className={`tag ${EXEC_STYLE[o.execution_status] || ''}`}>{o.execution_status || D}</span></td>
                <td className="muted">{o.rejection_reason || D}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--line)', fontWeight: 600 }}>
              <td>TOTAL</td>
              <td className="dim">{rows.length} opportunities</td>
              <td className="dim" colSpan={3}></td>
              <td className={`num ${rows.reduce((s, o) => s + (o.edge || 0), 0) > 0 ? 'pos' : ''}`}>
                {usd(rows.reduce((s, o) => s + (o.edge || 0), 0)) || '$0.00'}</td>
              <td className="dim" colSpan={2}></td>
              <td className="num">{funnel.submitted ?? 0} sub · {funnel.landed ?? 0} landed</td>
              <td className="dim"></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
