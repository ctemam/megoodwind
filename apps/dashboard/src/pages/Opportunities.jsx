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

// Strategy from the record id: feed_geckoterminal rows are pre-built feed
// imports; engine rows are <...>/backrun/<...> or <...>/classic/<...>;
// everything else is a leader (wallet-copy) signal.
function laneOf(o) {
  const id = o.opportunity_id || ''
  if (id.includes('/feed_geckoterminal/')) return 'feed'
  if (id.includes('/backrun/')) return 'backrun'
  if (id.includes('/classic/')) return 'atomic arb'
  return 'wallet copy'
}

// Mirror of a DEXScreener pair-table row: Pair / DEX badges / Price band /
// Spread / Txns / Liquidity, then our exec context appended on the right.
const dexBadge = id => (id || '').replace(/-(bsc|eth|polygon_pos|ethereum|base|arbitrum)$/, '')
const priceFmt = v => (v == null || v === 0 ? D : v >= 1 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v.toPrecision(3))

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
  // Pagination — DEXScreener style: fixed page sizes, latest-first.
  const [pageSize, setPageSize] = useState(50)
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const cur = Math.min(page, pageCount - 1)
  const pageRows = sorted.slice(cur * pageSize, (cur + 1) * pageSize)
  // Filters changing invalidate the current page position.
  useEffect(() => { setPage(0) }, [chain, lane, showRejected, pageSize])
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
            {['all', 'feed', 'wallet copy', 'backrun', 'atomic arb'].map(l => (
              <button key={l} className={`tab${l === lane ? ' on' : ''}`} onClick={() => setLane(l)}>{l}</button>
            ))}
            <button className={`tab${showRejected ? ' on' : ''}`} onClick={() => setShowRejected(v => !v)}>
              {showRejected ? 'all' : 'pass only'}
            </button>
          </div>
        </div>
        <table className="tbl">
          <thead><tr>
            {th('time', 'Time')}{th('feed_pair', 'Pair')}{th('chain', 'Chain')}
            {th('feed_dex_in', 'Dex route')}{th('feed_price_hi', 'Price')}
            {th('profit_bps', 'Spread')}{th('feed_h1_txns', 'Txns 1h')}
            {th('feed_liquidity_usd', 'Liquidity')}{th('buy_pool', 'Buy → Sell')}
            {th('edge', 'Edge est.')}{th('gas_usd', 'Gas')}
            {th('simulation_status', 'Verify')}{th('execution_status', 'Outcome')}
            {th('rejection_reason', 'Kill stage')}{th('lane', 'Lane')}
          </tr></thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan="15" className="muted">No {showRejected ? '' : 'passing '}opportunity records.</td></tr>
            )}
            {pageRows.map((o, i) => (
              <tr key={o.opportunity_id || i}>
                <td className="mono dim">{hhmmss(o.time)}</td>
                <td title={`${o.token_in || ''} → ${o.token_out || ''}`}>
                  {o.feed_pair || `${trunc(o.token_in)}/${trunc(o.token_out)}`}
                </td>
                <td>{o.chain}</td>
                <td className="dim">
                  {o.feed_dex_in || o.feed_dex_out
                    ? `${dexBadge(o.feed_dex_in)} → ${dexBadge(o.feed_dex_out)}`
                    : o.lane}
                </td>
                <td className="num">
                  {o.feed_price_lo && o.feed_price_hi
                    ? `${priceFmt(o.feed_price_lo)} – ${priceFmt(o.feed_price_hi)}`
                    : D}
                </td>
                <td className="num pos">{o.profit_bps ? `${(o.profit_bps / 100).toFixed(1)}%` : D}</td>
                <td className="num">{o.feed_h1_txns || D}</td>
                <td className="num">{usd(o.feed_liquidity_usd)}</td>
                <td className="mono dim" title={o.route_pools?.join('\n')}>
                  {o.buy_pool && o.sell_pool
                    ? `${trunc(o.buy_pool)} → ${trunc(o.sell_pool)}`
                    : `${o.route_pools?.length || 0} pools`}
                </td>
                <td className="num pos">{usd(o.edge)}</td>
                <td className="num">{usd(o.gas_usd)}</td>
                <td><span className={`tag ${SIM_STYLE[o.simulation_status] || ''}`}>{o.simulation_status || D}</span></td>
                <td><span className={`tag ${EXEC_STYLE[o.execution_status] || ''}`}>{o.execution_status || D}</span></td>
                <td className="muted">{o.rejection_reason || D}</td>
                <td className="dim">{o.lane}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--line)', fontWeight: 600 }}>
              <td>TOTAL</td>
              <td className="dim">{rows.length} opportunities</td>
              <td className="dim" colSpan={7}></td>
              <td className={`num ${rows.reduce((s, o) => s + (o.edge || 0), 0) > 0 ? 'pos' : ''}`}>
                {usd(rows.reduce((s, o) => s + (o.edge || 0), 0)) || '$0.00'}</td>
              <td className="dim"></td>
              <td className="dim"></td>
              <td className="num">{funnel.submitted ?? 0} sub · {funnel.landed ?? 0} landed</td>
              <td className="dim" colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
        <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
          <div className="tabs">
            <button className="tab" disabled={cur === 0} onClick={() => setPage(0)}>«</button>
            <button className="tab" disabled={cur === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹ prev</button>
            <span className="dim" style={{ padding: '0 8px' }}>
              page {cur + 1} / {pageCount} · {sorted.length} rows
            </span>
            <button className="tab" disabled={cur >= pageCount - 1} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}>next ›</button>
            <button className="tab" disabled={cur >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>»</button>
          </div>
          <div className="tabs">
            {[25, 50, 100, 200].map(n => (
              <button key={n} className={`tab${n === pageSize ? ' on' : ''}`} onClick={() => setPageSize(n)}>{n}/pg</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
