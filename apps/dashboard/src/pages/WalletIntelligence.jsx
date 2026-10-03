import React, { useEffect, useMemo, useState } from 'react'
import { useApp, fmt } from '../state.jsx'

const CLASSES = ['all', 'bundle_backrunner', 'atomic_arb', 'trader']
const STATES = ['all', 'observe', 'replay', 'shadow', 'bounded_live', 'expired']
const STATE_STYLE = {
  observe: '', replay: 'dry', shadow: 'dry',
  bounded_live: 'live', expired: '',
}
const D = '—' // missing values are never inferred

const COLS = [
  ['rank', 'Rank'], ['wallet', 'Wallet'], ['class', 'Strategy'],
  ['state', 'State'], ['trades', 'Trades'], ['win_rate', 'Win %'],
  ['median_win_usd', 'Median win'], ['net_after_gas_usd', 'Net P&L'],
  ['avg_profit_usd', 'Avg/trade'], ['private_hits', 'Priv hits'],
  ['coverage', 'Route cov'], ['verified_profit_usd', 'Sim P&L'],
  ['confidence', 'Conf'], ['last_seen_block', 'Last seen'],
  ['expires_at_block', 'Expiry'],
]

// Forge score — same composite as leader_scan's ranking.
function forgeScore(r) {
  if (r.net_after_gas_usd == null) return 0
  const wr = r.win_rate ?? 0
  const freq = Math.min((r.trades ?? 0) / 20, 1)
  const w = r.class === 'bundle_backrunner' ? 1 : r.class === 'atomic_arb' ? 0.8 : 0.4
  return Math.log(1 + Math.max(0, r.net_after_gas_usd)) * (0.5 + 0.3 * wr + 0.2 * freq) * w
}
const num = v => (v == null ? null : v)
const pct = v => (v == null ? D : `${(v * 100).toFixed(0)}%`)
const usd = v => (v == null ? D : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`)
const blk = v => (v == null ? D : v.toLocaleString())
const trunc = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : D)

export default function WalletIntelligence() {
  const { currency, prices, refreshMs } = useApp()
  const [data, setData] = useState(null)
  const [chain, setChain] = useState('bsc')
  const [cls, setCls] = useState('all')
  const [st, setSt] = useState('all')
  const [minConf, setMinConf] = useState(0)
  const [minTrades, setMinTrades] = useState(0)
  const [sort, setSort] = useState(['rank', -1])
  const [open, setOpen] = useState(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let live = true
    const load = () => fetch('/api/wallet-intelligence')
      .then(r => r.json()).then(j => live && setData(j)).catch(() => {})
    load()
    const t = setInterval(load, Math.max(refreshMs, 5000))
    return () => { live = false; clearInterval(t) }
  }, [refreshMs])

  const cd = data?.chains?.[chain]
  const rows = useMemo(() => {
    if (!cd) return []
    let r = cd.rows.map(x => ({ ...x, rank: forgeScore(x) }))
      .filter(x => cls === 'all' || x.class === cls)
      .filter(x => st === 'all' || x.state === st)
      .filter(x => (x.confidence ?? 0) >= minConf)
      .filter(x => (x.trades ?? 0) >= minTrades)
    const [k, dir] = sort
    r.sort((a, b) => {
      const av = k === 'wallet' || k === 'class' || k === 'state' ? a[k] : num(a[k])
      const bv = k === 'wallet' || k === 'class' || k === 'state' ? b[k] : num(b[k])
      if (av == null) return 1
      if (bv == null) return -1
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir
    })
    return r
  }, [cd, cls, st, minConf, minTrades, sort])

  const states = useMemo(() => {
    const c = {}
    for (const r of cd?.rows || []) c[r.state] = (c[r.state] || 0) + 1
    return c
  }, [cd])

  const clickSort = k => setSort(s => [k, s[0] === k ? -s[1] : -1])
  const arrow = k => (sort[0] === k ? (sort[1] < 0 ? ' ▾' : ' ▴') : '')

  return (
    <div className="grid">
      <div className="grid cards">
        <div className="card"><div className="k">Wallets tracked</div>
          <div className="v">{cd?.rows?.length ?? D}</div>
          <div className="s">{cd?.scanned_wallets ?? 0} scored · {cd?.strategies ?? 0} strategies</div></div>
        <div className="card"><div className="k">Sim-verified</div>
          <div className="v pos">{cd?.rows?.filter(r => r.sim_verified).length ?? D}</div>
          <div className="s">shadow sim reproduced profit</div></div>
        <div className="card"><div className="k">Bounded live</div>
          <div className="v">{states.bounded_live ?? 0}</div>
          <div className="s">cap-gated strategies only</div></div>
        <div className="card"><div className="k">Bait suspects</div>
          <div className="v">{cd?.counters?.bait_suspect ?? D}</div>
          <div className="s">pools suppressed (L4)</div></div>
        <div className="card"><div className="k">Scan cursor</div>
          <div className="v" style={{ fontSize: 16 }}>{blk(cd?.cursor_block)}</div>
          <div className="s">incremental block scan</div></div>
      </div>

      <div className="panel">
        <h3>Wallet Intelligence — {chain.toUpperCase()}</h3>
        <form className="inline" onSubmit={e => e.preventDefault()}>
          <select value={chain} onChange={e => setChain(e.target.value)}>
            {Object.keys(data?.chains || { bsc: 1, base: 1 }).map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
          </select>
          {CLASSES.map(c => (
            <button key={c} type="button" className={`tag ${cls === c ? 'live' : ''}`}
              style={{ cursor: 'pointer' }} onClick={() => setCls(c)}>
              {c === 'all' ? 'All classes' : c.replace('_', ' ')}
            </button>
          ))}
          <span className="dim">|</span>
          {STATES.map(s => (
            <button key={s} type="button" className={`tag ${st === s ? 'live' : ''}`}
              style={{ cursor: 'pointer' }} onClick={() => setSt(s)}>
              {s === 'all' ? `All (${cd?.rows?.length ?? 0})` : `${s.replace('_', ' ')} (${states[s] ?? 0})`}
            </button>
          ))}
          <label className="dim">min conf
            <input type="number" min="0" max="1" step="0.1" value={minConf}
              onChange={e => setMinConf(+e.target.value)} style={{ width: 60, marginLeft: 6 }} /></label>
          <label className="dim">min trades
            <input type="number" min="0" value={minTrades}
              onChange={e => setMinTrades(+e.target.value)} style={{ width: 60, marginLeft: 6 }} /></label>
        </form>
        <div style={{ overflowX: 'auto', overflowY: expanded ? 'auto' : 'hidden', maxHeight: expanded ? '70vh' : 'none' }}>
          <table>
            {/* collapsed: top rows inline; expanded: full scrollable list */}
            <thead><tr>{COLS.map(([k, label]) => (
              <th key={k} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
                onClick={() => clickSort(k)}>{label}{arrow(k)}</th>
            ))}</tr></thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={COLS.length} className="dim" style={{ textAlign: 'center', padding: 24 }}>
                  {cd ? 'No wallets match the filters.' : 'Loading wallet intelligence…'}
                </td></tr>
              )}
              {(expanded ? rows : rows.slice(0, 15)).map(r => {
                const key = `${r.wallet}/${r.class}`
                const obs = cd?.obs_tails?.[r.wallet]
                return (
                  <React.Fragment key={key}>
                    <tr className="chain" onClick={() => setOpen(open === key ? null : key)}>
                      <td className="dim">{r.rank ? r.rank.toFixed(2) : D}</td>
                      <td className="mono" title={r.wallet}>{trunc(r.wallet)}</td>
                      <td>{r.class}</td>
                      <td><span className={`tag ${STATE_STYLE[r.state] || ''}`}>{r.state}</span></td>
                      <td>{r.trades ?? D}</td>
                      <td className={(r.win_rate ?? 0) >= 0.8 ? 'pos' : ''}>{pct(r.win_rate)}</td>
                      <td>{usd(r.median_win_usd)}</td>
                      <td className={(r.net_after_gas_usd ?? 0) > 0 ? 'pos' : 'neg'}>
                        {r.net_after_gas_usd == null ? D : fmt(r.net_after_gas_usd, currency, prices)}</td>
                      <td>{usd(r.avg_profit_usd)}</td>
                      <td>{r.private_hits > 0 ? <b className="pos">{r.private_hits}</b> : r.private_hits}</td>
                      <td>{r.coverage == null ? D : `${(r.coverage * 100).toFixed(0)}% (${r.route_pools.length}p)`}</td>
                      <td className={r.sim_verified ? 'pos' : ''}>
                        {r.sim_verified ? usd(r.verified_profit_usd) : D}</td>
                      <td>{r.confidence == null ? D : r.confidence.toFixed(2)}</td>
                      <td className="dim">{blk(r.last_seen_block)}</td>
                      <td className="dim">{blk(r.expires_at_block)}</td>
                    </tr>
                    {open === key && (
                      <tr className="detail"><td colSpan={COLS.length}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 28px' }}>
                          <div><b style={{ color: 'var(--txt)' }}>Wallet</b> <span className="mono">{r.wallet}</span></div>
                          <div><b style={{ color: 'var(--txt)' }}>Executor family</b> <span className="mono">{r.executor_family ?? D}</span></div>
                          <div><b style={{ color: 'var(--txt)' }}>Route pools</b> {r.route_pools.length ? r.route_pools.map(p => <div key={p} className="mono">{p}</div>) : D}</div>
                          <div><b style={{ color: 'var(--txt)' }}>Notional cap</b> {r.max_notional_usd ? `$${r.max_notional_usd}` : 'none — not live-approved'}</div>
                          <div><b style={{ color: 'var(--txt)' }}>Sim verification</b> {r.sim_verified ? `verified · reproduces ${usd(r.verified_profit_usd)} gross` : 'not verified — discovery alone never executes'}</div>
                          <div><b style={{ color: 'var(--txt)' }}>Evidence</b> {r.txs ?? D} txs · {r.trades ?? D} trades · {r.atomic_txs} atomic · {r.private_hits} private hits</div>
                          <div><b style={{ color: 'var(--txt)' }}>Pending-stream discovery</b> {r.discovered_pending ? 'yes' : 'no'}</div>
                          <div><b style={{ color: 'var(--txt)' }}>Best tx</b> {r.best_tx ? <span className="mono">{r.best_tx}</span> : D}</div>
                          <div><b style={{ color: 'var(--txt)' }}>Observations</b> {obs ? `${obs.count} recorded` : 'none yet'}</div>
                          <div><b style={{ color: 'var(--txt)' }}>Promotion path</b> observe → replay (evidence) → shadow (full route coverage) → bounded_live (sim-verified, capped)</div>
                        </div>
                        {obs?.tail?.length > 0 && (
                          <div style={{ marginTop: 8 }}>
                            <b style={{ color: 'var(--txt)' }}>Recent observations</b>
                            {obs.tail.map((o, i) => (
                              <div key={i} className="mono dim" style={{ fontSize: 11.5, marginTop: 3 }}>
                                {o.class ?? '?'} · {o.router ? `router ${trunc(o.router)}` : 'no router'} ·
                                pools {o.pools_touched?.length ?? 0} · {o.tx_hash ? trunc(o.tx_hash) : ''}
                              </div>
                            ))}
                          </div>
                        )}
                      </td></tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        {rows.length > 15 && (
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <button className="tag" style={{ cursor: 'pointer' }}
              onClick={() => setExpanded(e => !e)}>
              {expanded ? `▴ Collapse — showing all ${rows.length} wallets`
                : `▾ Expand — ${rows.length - 15} more wallets`}
            </button>
          </div>
        )}
        <div className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>
          All figures are measured from mined-block outcome attribution — never projected.
          State promotion is backend-governed: this page is read-only by design.
        </div>
      </div>
    </div>
  )
}
