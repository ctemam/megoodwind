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
  if (id.includes('/feed_geckoterminal/') || id.includes('/feed_dexscreener/') || id.includes('/feed_')) return 'feed'
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
  // addr → symbol from the chain token maps (server-provided).
  // Placeholder names from leader-scan merges (TK_0x…) aren't symbols.
  const symOf = a => {
    const s = a ? (data?.symbols || {})[a.toLowerCase()] : null
    return s && !s.startsWith('TK_0x') ? s : null
  }
  // No wallet/pool addresses in the pair field — symbols only; an
  // unresolved token shows as TKN.
  const pairOf = o => {
    if (o.feed_pair) return o.feed_pair
    const a = symOf(o.token_in) || (o.token_in ? 'TKN' : null)
    const b = symOf(o.token_out) || (o.token_out ? 'TKN' : null)
    if (a && b && a !== b) return `${a} / ${b}`
    return a || D
  }

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
        <div className="card"><div className="k">Exec-ready</div><div className="v pos">{actionable.length}</div><div className="s" title="sim passed, every gate clean, staged for a venue">staged to submit</div></div>
        <div className="card"><div className="k">Replay positive</div><div className="v">{funnel.replay_positive ?? D}</div><div className="s">of {funnel.replay_attempts ?? D}</div></div>
        <div className="card"><div className="k">Matched live</div><div className="v">{funnel.matched_live ?? D}</div><div className="s">verified route hit</div></div>
        <div className="card"><div className="k">Submitted</div><div className="v">{funnel.submitted ?? D}</div><div className="s">landed {funnel.landed ?? D} · settled {funnel.settled ?? D}</div></div>
      </div>

      <div className="panel">
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Opportunity feed</h3>
          <div className="tabs" style={{ alignItems: 'center' }}>
            <select value={chain} onChange={e => setChain(e.target.value)}
              style={{ textTransform: 'uppercase' }}>
              <option value="all">ALL CHAINS</option>
              {chains.map(c => (
                <option key={c} value={c}>{c.toUpperCase()}</option>
              ))}
            </select>
            <select value={lane} onChange={e => setLane(e.target.value)}
              title="Strategy mode — pick one mode or all" >
              <option value="all">ALL MODES</option>
              <option value="atomic arb">CLASSIC ARB</option>
              <option value="feed">PRE-DETECTED FEED</option>
              <option value="wallet copy">WALLET COPY</option>
              <option value="backrun">BACKRUN</option>
            </select>
            <button className={`tab${showRejected ? ' on' : ''}`} onClick={() => setShowRejected(v => !v)}>
              {showRejected ? 'all' : 'pass only'}
            </button>
          </div>
        </div>
        <table className="tbl">
          <thead><tr>
            {th('time', 'Time', 'When the opportunity was detected. Freshness drives profit — edge decays every block, so older rows are less likely to still be real.')}
            {th('feed_pair', 'Pair', 'The two assets being priced against each other across pools, and which chain they live on. A spread only counts when the SAME pair trades at different prices on different venues of the same chain.')}
            {th('feed_dex_in', 'Dex route', 'Where we buy cheap → where we sell dear. Only same-interface DEX pairs are executable; exotic venues are filtered out before this column fills.')}
            {th('profit_bps', 'Price gap', 'The % difference between the cheapest and dearest pool — the gross edge. It must exceed fees, slippage, and gas to become profit. Too-large gaps are usually fake pools, not free money.')}
            {th('feed_liquidity_usd', 'Pool depth', 'Dollar depth of the shallower pool. Sets the max safe flash size — borrowing more than ~15% of depth moves the price against you and erases the edge.')}
            {th('edge', 'Est. profit', 'Simulated net USD if executed at current pool state (gas cost shown beneath). An estimate, not realized money: state can move before the trade lands. Profit must clear gas or the trade aborts.')}
            {th('execution_status', 'Status', 'The trade\'s fate: the tag shows how far it got (pass = still profitable at fresh on-chain check; landed/settled = real profit). The reason beneath names the gate that stopped it — each stop is a trade that would have lost money or reverted.')}
            {th('lane', 'Lane', 'Which engine found it: feed = aggregated spread import, atomic arb = pool-state scanner, backrun = mempool displacement, wallet copy = leader route. Lets you see which signal source actually produces profit.')}
          </tr></thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan="8" className="muted">No {showRejected ? '' : 'passing '}opportunity records.</td></tr>
            )}
            {pageRows.map((o, i) => {
              const status = o.execution_status && o.execution_status !== 'none'
                ? o.execution_status : o.simulation_status
              const style = o.execution_status && o.execution_status !== 'none'
                ? EXEC_STYLE[o.execution_status] : SIM_STYLE[o.simulation_status]
              return (
              <tr key={o.opportunity_id || i}>
                <td className="mono dim">{hhmmss(o.time)}</td>
                <td>{pairOf(o)}<br /><span className="dim" style={{ fontSize: 10 }}>{o.chain}</span></td>
                <td className="dim">
                  {o.feed_dex_in || o.feed_dex_out
                    ? `${dexBadge(o.feed_dex_in)} → ${dexBadge(o.feed_dex_out)}`
                    : D}
                </td>
                <td className="num pos">{o.profit_bps ? `${(o.profit_bps / 100).toFixed(1)}%` : D}</td>
                <td className="num">{usd(o.feed_liquidity_usd)}</td>
                <td className="num pos">{usd(o.edge)}
                  {o.gas_usd ? <><br /><span className="dim" style={{ fontSize: 10 }}>gas {usd(o.gas_usd)}</span></> : null}</td>
                <td>
                  <span className={`tag ${style || ''}`}>{status || D}</span>
                  {o.rejection_reason ? <><br /><span className="muted" style={{ fontSize: 10 }}>{o.rejection_reason}</span></> : null}
                </td>
                <td className="dim">{o.lane}</td>
              </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--line)', fontWeight: 600 }}>
              <td>TOTAL</td>
              <td className="dim">{rows.length} opportunities</td>
              <td className="dim" colSpan={3}></td>
              <td className={`num ${rows.reduce((s, o) => s + (o.edge || 0), 0) > 0 ? 'pos' : ''}`}>
                {usd(rows.reduce((s, o) => s + (o.edge || 0), 0)) || '$0.00'}</td>
              <td className="num">{funnel.submitted ?? 0} sub · {funnel.landed ?? 0} landed</td>
              <td className="dim"></td>
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
