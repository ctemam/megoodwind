import React, { useEffect, useMemo, useState } from 'react'
import { useApp } from '../state.jsx'
import { useSort } from '../Sortable.jsx'

const D = '—' // missing values are never inferred
const trunc = a => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : D)
const usd = v => (v == null || v === 0 ? D : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
const bps = v => (v == null || v === 0 ? D : `${v.toFixed(0)}`)
const ms = v => (v == null || v === 0 ? D : `${v}ms`)

const SIM_STYLE = { pass: 'live', fail: '', pending: 'dry', unusable: '' }
const EXEC_STYLE = {
  none: '', ready: 'dry', submitted: 'dry',
  landed: 'live', settled: 'live', reverted: '', dropped: '',
}
const STAGES = ['decoded', 'replay_attempts', 'replay_positive', 'actionable',
  'matched_live', 'submitted', 'landed', 'settled']

export default function Opportunities() {
  const { refreshMs } = useApp()
  const [data, setData] = useState(null)
  const [chain, setChain] = useState('bsc')
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
  const cd = data?.chains?.[chain]
  const rows = useMemo(() => {
    const r = cd?.rows || []
    return showRejected ? r : r.filter(o => o.simulation_status === 'pass')
  }, [cd, showRejected])
  const [sorted, th] = useSort(rows, ['allbright_net_usd', -1])
  const funnel = cd?.funnel || {}
  const actionable = rows.filter(r => r.execution_status === 'ready' && !r.rejection_reason)

  return (
    <div className="grid">
      <div className="grid cards">
        <div className="card"><div className="k">Actionable</div><div className="v pos">{actionable.length}</div><div className="s" title="survived the runner's real-state re-check">live-verified</div></div>
        <div className="card"><div className="k">Decoded routes</div><div className="v">{funnel.decoded ?? D}</div><div className="s">leader routes</div></div>
        <div className="card"><div className="k">Replay positive</div><div className="v">{funnel.replay_positive ?? D}</div><div className="s">of {funnel.replay_attempts ?? D}</div></div>
        <div className="card"><div className="k">Matched live</div><div className="v">{funnel.matched_live ?? D}</div><div className="s">verified route hit</div></div>
        <div className="card"><div className="k">Submitted</div><div className="v">{funnel.submitted ?? D}</div><div className="s">landed {funnel.landed ?? D} · settled {funnel.settled ?? D}</div></div>
      </div>

      <div className="panel">
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Actionable opportunities</h3>
          <div className="tabs">
            {chains.map(c => (
              <button key={c} className={`tab${c === chain ? ' on' : ''}`} onClick={() => setChain(c)}>{c.toUpperCase()}</button>
            ))}
            <button className={`tab${showRejected ? ' on' : ''}`} onClick={() => setShowRejected(v => !v)}>
              {showRejected ? 'all' : 'pass only'}
            </button>
          </div>
        </div>
        <table className="tbl">
          <thead><tr>
            {th('rank', 'Rank')}{th('source_wallet', 'Source')}{th('victim_tx', 'Victim')}
            {th('route_n', 'Route')}{th('leader_net_usd', 'Leader net')}{th('allbright_net_usd', 'Our net')}
            {th('profit_bps', 'Bps')}{th('state_age_ms', 'State age')}{th('inclusion_deadline', 'Deadline')}
            {th('simulation_status', 'Sim')}{th('execution_status', 'Exec')}{th('rejection_reason', 'Reject')}
          </tr></thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan="12" className="muted">No {showRejected ? '' : 'passing '}opportunity records.</td></tr>
            )}
            {sorted.map((o, i) => (
              <tr key={o.opportunity_id}>
                <td className="muted">{i + 1}</td>
                <td title={`${o.source_wallet} · ${o.source_tx}`}>{trunc(o.source_wallet)}</td>
                <td title={o.victim_tx || 'no victim context'}>{trunc(o.victim_tx)}</td>
                <td title={o.route_pools?.join('\n')}>{o.route_pools?.length || 0} pools</td>
                <td className="num">{usd(o.leader_net_usd)}</td>
                <td className="num pos">{usd(o.allbright_net_usd)}</td>
                <td className="num">{bps(o.profit_bps)}</td>
                <td className="num">{ms(o.state_age_ms)}</td>
                <td className="num">{o.inclusion_deadline || D}</td>
                <td><span className={`tag ${SIM_STYLE[o.simulation_status] || ''}`}>{o.simulation_status || D}</span></td>
                <td><span className={`tag ${EXEC_STYLE[o.execution_status] || ''}`}>{o.execution_status || D}</span></td>
                <td className="muted">{o.rejection_reason || D}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
