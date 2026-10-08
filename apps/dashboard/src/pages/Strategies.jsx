import React, { useEffect, useMemo, useState } from 'react'
import { useApp, fmt } from '../state.jsx'
import { useSort } from '../Sortable.jsx'
import WalletIntelligence from './WalletIntelligence.jsx'

const D = '—' // missing values are never inferred

// Native-token price key per chain (prices feed: coingecko slugs).
const NATIVE_PRICE = { bsc: 'binancecoin', ethereum: 'ethereum', base: 'ethereum', polygon: null }

const cnt = v => (v == null ? D : v.toLocaleString())
const pct = v => (v == null ? D : `${(v * 100).toFixed(1)}%`)
const usd0 = (v, currency, prices) => (v == null ? D : fmt(v, currency, prices))

// Sum a counter across all its label variants: arb_x_total{a="1"} +
// arb_x_total{a="2"} + bare arb_x_total.
function total(m, name) {
  if (!m) return null
  let s = null
  for (const [k, v] of Object.entries(m)) {
    if (k === name || k.startsWith(`${name}{`)) s = (s ?? 0) + v
  }
  return s
}

// Sum a labeled counter for one specific label value.
function totalLabeled(m, name, label, value) {
  if (!m) return null
  let s = null
  for (const [k, v] of Object.entries(m)) {
    if (k.startsWith(`${name}{`) && k.includes(`${label}="${value}"`)) s = (s ?? 0) + v
  }
  return s
}

function laneState(m, lane) {
  const v = m?.[`arb_lane_state{lane="${lane}"}`]
  return v == null ? null : v // 0 off, 1 shadow, 2 live
}

const STATE_TAG = { 0: 'Off', 1: 'Shadow', 2: 'Live' }

// ── Strategies — profit characterization ──────────────────────────────────
// The whole page answers: where is profit, how much per trade, how often do
// we win, and what does each day look like. Every column is metric-backed;
// missing data renders "—".
export default function Strategies() {
  const { all, currency, prices, refreshMs } = useApp()
  const [tab, setTab] = useState('lanes')
  const [opp, setOpp] = useState(null)
  const [report, setReport] = useState(null)

  useEffect(() => {
    let dead = false
    const tick = async () => {
      try {
        const r = await fetch('/api/opportunities')
        if (r.ok && !dead) setOpp(await r.json())
      } catch {}
      try {
        const r = await fetch('/api/report?window=30d')
        if (r.ok && !dead) setReport(await r.json())
      } catch {}
    }
    tick(); const t = setInterval(tick, refreshMs || 10000)
    return () => { dead = true; clearInterval(t) }
  }, [refreshMs])

  // ── Lane rows: one per strategy lane, all chains rolled up ──
  const lanes = useMemo(() => {
    const chains = Object.entries(all?.chains || {})
    const acc = {
      classic: { strategy: 'Atomic flash-loan arb', chains: new Set(), state: null, signals: 0, submitted: 0, wins: 0, net: 0, gas: 0, kills: {}, any: false },
      backrun: { strategy: 'Mempool backrun', chains: new Set(), state: null, signals: 0, submitted: 0, wins: 0, net: 0, gas: 0, kills: {}, any: false },
      copy:    { strategy: 'Wallet copy', chains: new Set(), state: null, signals: 0, submitted: 0, wins: 0, net: 0, gas: 0, kills: {}, any: false },
      feed:    { strategy: 'Pre-detected feed', chains: new Set(), state: null, signals: 0, submitted: 0, wins: 0, net: 0, gas: 0, kills: {}, any: false },
    }
    for (const [c, m] of chains) {
      if (!m) continue
      const C = c.toUpperCase()
      const nativeUsd = NATIVE_PRICE[c] ? prices?.[NATIVE_PRICE[c]]?.usd : null
      const gasWei = (total(m, 'arb_gas_spent_wei_total') ?? 0) / 1e18

      for (const [key, lane] of Object.entries(acc)) {
        const st = laneState(m, key)
        if (st == null) continue // runner too old to report lane state
        lane.state = lane.state == null ? st : Math.max(lane.state, st)
        if (st > 0) lane.chains.add(C)
      }
      // classic
      const a = acc.classic
      const sig0 = total(m, 'arb_profitable_found_total') ?? 0
      const sub0 = total(m, 'arb_submit_attempts_total') ?? 0
      const win0 = totalLabeled(m, 'arb_submit_landed_total', 'status', 'success') ?? 0
      const net0 = total(m, 'arb_net_profit_usd_total') ?? 0
      if (sig0 > 0 || sub0 > 0 || a.state != null) {
        a.any = true; a.signals += sig0; a.submitted += sub0; a.wins += win0; a.net += net0
        if (nativeUsd) a.gas += gasWei * nativeUsd
        const k = topKill(m, /arb_gate_rejects_total\{reason="([^"]+)"\}/)
        if (k) a.kills[k] = (a.kills[k] || 0) + 1
      }
      // backrun
      const b = acc.backrun
      const sig1 = total(m, 'arb_backrun_candidates_total') ?? 0
      const sub1 = total(m, 'arb_backrun_submitted_total') ?? 0
      const win1 = totalLabeled(m, 'arb_backrun_stage_total', 'stage', 'venue_accept') ?? 0
      if (sig1 > 0 || sub1 > 0 || b.state != null) {
        b.any = true; b.signals += sig1; b.submitted += sub1; b.wins += win1
        const k = topKill(m, /arb_backrun_stage_total\{stage="([^"]+)"\}/, ['venue_accept'])
        if (k) b.kills[k] = (b.kills[k] || 0) + 1
      }
      // pre-detected feed (DexScreener/GeckoTerminal import lane)
      const f = acc.feed
      const sig3 = total(m, 'arb_feed_candidates_total') ?? 0
      const sub3 = total(m, 'arb_feed_submitted_total') ?? 0
      if (sig3 > 0 || sub3 > 0 || f.state != null) {
        f.any = true; f.signals += sig3; f.submitted += sub3
        const k = topKill(m, /arb_feed_rejects_total\{[^}]*reason="([^"]+)"/)
        if (k) f.kills[k] = (f.kills[k] || 0) + 1
      }
      // wallet copy
      const w = acc.copy
      const sig2 = total(m, 'arb_copy_signals_total') ?? 0
      const sub2 = total(m, 'arb_copy_submitted_total') ?? 0
      if (sig2 > 0 || sub2 > 0 || w.state != null) {
        w.any = true; w.signals += sig2; w.submitted += sub2
        for (const [k, v] of Object.entries(m)) {
          const g = k.match(/arb_copy_rejects_total\{[^}]*reason="([^"]+)"/)
          if (g) w.kills[g[1]] = (w.kills[g[1]] || 0) + v
        }
      }
    }
    // Copy fidelity still comes from the observation funnel — share of a
    // leader's decoded signals matched on live state.
    let fidelity = null
    for (const [c, cd] of Object.entries(opp?.chains || {})) {
      const f = cd?.funnel || {}
      if ((f.decoded || 0) > 0 && f.matched_live != null)
        fidelity = (fidelity ?? 0) + f.matched_live / f.decoded
    }
    if (fidelity != null && acc.copy.chains.size > 1) fidelity /= acc.copy.chains.size

    return Object.values(acc).map(l => ({
      strategy: l.strategy,
      chain_list: [...l.chains].join(' · ') || D,
      state: l.state,
      status: STATE_TAG[l.state] ?? (l.any ? 'Measure' : D),
      signals: l.any ? l.signals : null,
      submitted: l.any ? l.submitted : null,
      win_rate: l.submitted > 0 ? l.wins / l.submitted : null,
      net_usd: l.any ? l.net : null,
      pnl_per_trade: l.submitted > 0 ? l.net / l.submitted : null,
      gas_usd: l.gas > 0 ? l.gas : null,
      copy_fidelity: l.strategy === 'Wallet copy' ? fidelity : null,
      kill: Object.entries(l.kills).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
    }))
  }, [all, opp, prices])

  // ── Per-chain profit table: realized + expected per chain ──
  const chainRows = useMemo(() => {
    return Object.entries(all?.chains || {}).map(([c, m]) => {
      if (!m) return null
      const settled = totalLabeled(m, 'arb_settlements_total', 'outcome', 'settled') ?? 0
      const failed = (totalLabeled(m, 'arb_settlements_total', 'outcome', 'revert') ?? 0)
                   + (totalLabeled(m, 'arb_settlements_total', 'outcome', 'dropped') ?? 0)
      const decided = settled + failed
      const realized = total(m, 'arb_settled_net_usd')
      const estNet = total(m, 'arb_net_profit_usd_total')
      const submitted = total(m, 'arb_submit_attempts_total')
      const nativeUsd = NATIVE_PRICE[c] ? prices?.[NATIVE_PRICE[c]]?.usd : null
      const gasWei = (total(m, 'arb_gas_spent_wei_total') ?? 0) / 1e18
      return {
        chain: c.toUpperCase(),
        signals: total(m, 'arb_profitable_found_total'),
        submitted,
        settled: decided > 0 ? settled : null,
        win_rate: decided > 0 ? settled / decided : null,
        realized_net: realized,
        est_net: estNet,
        gas_usd: nativeUsd && gasWei > 0 ? gasWei * nativeUsd : null,
        pnl_per_trade: realized != null && settled > 0 ? realized / settled : null,
      }
    }).filter(Boolean)
  }, [all, prices])

  // ── Daily history: bucket the report series into UTC days ──
  const days = useMemo(() => {
    const byDay = {}
    for (const pt of report?.series || []) {
      const day = new Date(pt.t).toISOString().slice(0, 10)
      const d = byDay[day] = byDay[day] || { day, first: pt, last: pt }
      d.last = pt
    }
    return Object.values(byDay).map(({ day, first, last }) => {
      let signals = 0, subs = 0, net = 0
      for (const k of Object.keys(last)) {
        const delta = key => Math.max(0, (last[key] ?? 0) - (first[key] ?? 0))
        if (k.endsWith('_hits')) signals += delta(k)
        if (k.endsWith('_subs')) subs += delta(k)
        if (k.endsWith('_net')) net += delta(k)
      }
      return { day, signals, submitted: subs, net_usd: net }
    }).sort((a, b) => b.day.localeCompare(a.day))
  }, [report])

  const [sorted, th] = useSort(lanes, ['strategy', 1])
  const [sortedChains, thC] = useSort(chainRows, ['chain', 1])
  const [sortedDays, thD] = useSort(days, ['day', -1])

  const tot = {
    signals: lanes.reduce((s, r) => s + (r.signals || 0), 0),
    submitted: lanes.reduce((s, r) => s + (r.submitted || 0), 0),
    wins: lanes.reduce((s, r) => s + ((r.win_rate || 0) * (r.submitted || 0)), 0),
    net: lanes.reduce((s, r) => s + (r.net_usd || 0), 0),
    gas: lanes.reduce((s, r) => s + (r.gas_usd || 0), 0),
  }
  const chainTot = {
    signals: chainRows.reduce((s, r) => s + (r.signals || 0), 0),
    submitted: chainRows.reduce((s, r) => s + (r.submitted || 0), 0),
    settled: chainRows.reduce((s, r) => s + (r.settled || 0), 0),
    realized: chainRows.reduce((s, r) => s + (r.realized_net || 0), 0),
    est: chainRows.reduce((s, r) => s + (r.est_net || 0), 0),
    gas: chainRows.reduce((s, r) => s + (r.gas_usd || 0), 0),
  }
  const decidedTot = chainRows.reduce((s, r) =>
    s + (r.win_rate != null ? (r.settled || 0) / r.win_rate : 0), 0)
  const dayTot = {
    signals: days.reduce((s, r) => s + r.signals, 0),
    submitted: days.reduce((s, r) => s + r.submitted, 0),
    net: days.reduce((s, r) => s + r.net_usd, 0),
  }

  return (
    <div className="grid">
      <div className="panel" style={{ padding: '8px 12px' }}>
        <form className="inline" onSubmit={e => e.preventDefault()}>
          {[
            ['lanes', 'Profit & lanes'],
            ['intel', 'Wallet attribution'],
          ].map(([id, label]) => (
            <button key={id} type="button" className={`tag ${tab === id ? 'live' : ''}`}
              style={{ cursor: 'pointer' }} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </form>
      </div>

      {tab === 'lanes' ? (
        <div className="grid">
          <div className="grid cards">
            <div className="card"><div className="k">Realized net P&L</div>
              <div className={`v ${chainTot.realized > 0 ? 'pos' : chainTot.realized < 0 ? 'neg' : ''}`}>
                {usd0(chainTot.realized, currency, prices)}</div>
              <div className="s">settled on-chain, all chains</div></div>
            <div className="card"><div className="k">Win rate</div>
              <div className="v">{pct(decidedTot > 0 ? chainTot.settled / decidedTot : null)}</div>
              <div className="s">settled vs failed submissions</div></div>
            <div className="card"><div className="k">Signals</div>
              <div className="v">{cnt(tot.signals)}</div>
              <div className="s">all lanes, since runner start</div></div>
            <div className="card"><div className="k">Submitted</div>
              <div className="v">{cnt(tot.submitted)}</div>
              <div className="s">reached venues</div></div>
          </div>

          <div className="panel">
            <h3 title="one row per strategy lane — signals, win rate, profit per trade">Strategy lanes</h3>
            <table className="tbl">
              <thead><tr>
                {th('strategy', 'Strategy')}{th('chain_list', 'Chains')}{th('status', 'State')}
                {th('signals', 'Signals')}{th('submitted', 'Submitted')}{th('win_rate', 'Win rate')}
                {th('net_usd', 'Est. net P&L')}{th('pnl_per_trade', 'P&L/trade')}
                {th('gas_usd', 'Gas spent')}{th('copy_fidelity', 'Copy fidelity')}
                {th('kill', 'Top kill stage')}
              </tr></thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={i}>
                    <td>{r.strategy}</td>
                    <td className="dim">{r.chain_list}</td>
                    <td><span className={`tag ${r.status === 'Live' ? 'live' : r.status === 'Off' ? 'dead' : 'dry'}`}>{r.status}</span></td>
                    <td className="num">{cnt(r.signals)}</td>
                    <td className="num">{cnt(r.submitted)}</td>
                    <td className="num">{pct(r.win_rate)}</td>
                    <td className={`num ${r.net_usd > 0 ? 'pos' : r.net_usd < 0 ? 'neg' : ''}`}>
                      {usd0(r.net_usd, currency, prices)}</td>
                    <td className={`num ${r.pnl_per_trade > 0 ? 'pos' : r.pnl_per_trade < 0 ? 'neg' : ''}`}>
                      {usd0(r.pnl_per_trade, currency, prices)}</td>
                    <td className="num">{usd0(r.gas_usd, currency, prices)}</td>
                    <td className="num">{pct(r.copy_fidelity)}</td>
                    <td className="dim">{r.kill || D}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--line)', fontWeight: 600 }}>
                  <td>TOTAL</td>
                  <td className="dim">{chainRows.length} chains</td>
                  <td>{D}</td>
                  <td className="num">{cnt(tot.signals)}</td>
                  <td className="num">{cnt(tot.submitted)}</td>
                  <td className="num">{pct(tot.submitted > 0 ? tot.wins / tot.submitted : null)}</td>
                  <td className={`num ${tot.net > 0 ? 'pos' : tot.net < 0 ? 'neg' : ''}`}>
                    {usd0(tot.net, currency, prices)}</td>
                  <td className={`num ${tot.submitted > 0 && tot.net / tot.submitted > 0 ? 'pos' : 'neg'}`}>
                    {tot.submitted > 0 ? usd0(tot.net / tot.submitted, currency, prices) : D}</td>
                  <td className="num">{usd0(tot.gas, currency, prices)}</td>
                  <td className="dim" colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
            <p className="dim" style={{ marginTop: 8, fontSize: 12 }}>
              State: Live = submits real UserOps · Shadow = records, never
              submits · Off = lane killed in config. Win rate counts
              on-chain outcomes; Est. net is the gate's modeled value, not
              realized. Copy fidelity = share of decoded leader signals
              matched on live state.
            </p>
          </div>

          <div className="panel">
            <h3 title="realized profit per chain — the money that actually settled">Profit by chain</h3>
            <table className="tbl">
              <thead><tr>
                {thC('chain', 'Chain')}{thC('signals', 'Signals')}{thC('submitted', 'Submitted')}
                {thC('settled', 'Won trades')}{thC('win_rate', 'Win rate')}
                {thC('realized_net', 'Realized net P&L')}{thC('est_net', 'Est. net P&L')}
                {thC('pnl_per_trade', 'P&L/trade')}{thC('gas_usd', 'Gas spent')}
              </tr></thead>
              <tbody>
                {sortedChains.map((r, i) => (
                  <tr key={i}>
                    <td>{r.chain}</td>
                    <td className="num">{cnt(r.signals)}</td>
                    <td className="num">{cnt(r.submitted)}</td>
                    <td className="num">{cnt(r.settled)}</td>
                    <td className="num">{pct(r.win_rate)}</td>
                    <td className={`num ${r.realized_net > 0 ? 'pos' : r.realized_net < 0 ? 'neg' : ''}`}>
                      {usd0(r.realized_net, currency, prices)}</td>
                    <td className={`num ${r.est_net > 0 ? 'pos' : r.est_net < 0 ? 'neg' : ''}`}>
                      {usd0(r.est_net, currency, prices)}</td>
                    <td className={`num ${r.pnl_per_trade > 0 ? 'pos' : r.pnl_per_trade < 0 ? 'neg' : ''}`}>
                      {usd0(r.pnl_per_trade, currency, prices)}</td>
                    <td className="num">{usd0(r.gas_usd, currency, prices)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--line)', fontWeight: 600 }}>
                  <td>TOTAL</td>
                  <td className="num">{cnt(chainTot.signals)}</td>
                  <td className="num">{cnt(chainTot.submitted)}</td>
                  <td className="num">{cnt(chainTot.settled)}</td>
                  <td className="num">{pct(decidedTot > 0 ? chainTot.settled / decidedTot : null)}</td>
                  <td className={`num ${chainTot.realized > 0 ? 'pos' : chainTot.realized < 0 ? 'neg' : ''}`}>
                    {usd0(chainTot.realized, currency, prices)}</td>
                  <td className={`num ${chainTot.est > 0 ? 'pos' : chainTot.est < 0 ? 'neg' : ''}`}>
                    {usd0(chainTot.est, currency, prices)}</td>
                  <td className="num">{chainTot.settled > 0 ? usd0(chainTot.realized / chainTot.settled, currency, prices) : D}</td>
                  <td className="num">{usd0(chainTot.gas, currency, prices)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="panel">
            <h3 title="per-day opportunity and profit history, UTC days, newest first">Daily history</h3>
            <table className="tbl">
              <thead><tr>
                {thD('day', 'Day (UTC)')}{thD('signals', 'Opportunities')}
                {thD('submitted', 'Submitted')}{thD('net_usd', 'Est. net P&L')}
              </tr></thead>
              <tbody>
                {sortedDays.length === 0 ? (
                  <tr><td colSpan={4} className="dim">No history yet — samples accumulate every 60s while runners are live.</td></tr>
                ) : sortedDays.map(r => (
                  <tr key={r.day}>
                    <td>{r.day}</td>
                    <td className="num">{cnt(r.signals)}</td>
                    <td className="num">{cnt(r.submitted)}</td>
                    <td className={`num ${r.net_usd > 0 ? 'pos' : r.net_usd < 0 ? 'neg' : ''}`}>
                      {usd0(r.net_usd, currency, prices)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--line)', fontWeight: 600 }}>
                  <td>TOTAL — {days.length}d</td>
                  <td className="num">{cnt(dayTot.signals)}</td>
                  <td className="num">{cnt(dayTot.submitted)}</td>
                  <td className={`num ${dayTot.net > 0 ? 'pos' : dayTot.net < 0 ? 'neg' : ''}`}>
                    {usd0(dayTot.net, currency, prices)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : <WalletIntelligence />}
    </div>
  )
}

function topKill(m, re, exclude = []) {
  let best = null, bestV = 0
  for (const [k, v] of Object.entries(m || {})) {
    const g = k.match(re)
    if (g && !exclude.includes(g[1]) && v > bestV) { best = g[1]; bestV = v }
  }
  return best
}
