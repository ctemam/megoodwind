import React, { useEffect, useMemo, useState } from 'react'
import { useApp, fmt } from '../state.jsx'
import { useSort } from '../Sortable.jsx'
import WalletIntelligence from './WalletIntelligence.jsx'

const D = '—' // missing values are never inferred

// Native-token price key per chain (prices feed: coingecko slugs).
const NATIVE_PRICE = { bsc: 'binancecoin', ethereum: 'ethereum', base: 'ethereum', polygon: null }

const cnt = v => (v == null ? D : v.toLocaleString())
const pct = v => (v == null ? D : `${(v * 100).toFixed(1)}%`)
const sec = v => (v == null ? D : `${v.toFixed(2)}s`)

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

function topLabel(m, re, exclude = []) {
  if (!m) return null
  let best = null, bestV = 0
  for (const [k, v] of Object.entries(m)) {
    const g = k.match(re)
    if (g && !exclude.includes(g[1]) && v > bestV) { best = g[1]; bestV = v }
  }
  return best
}

// ── Lane table ──────────────────────────────────────────────────────────
// One row per strategy lane, all chains rolled up, every column sortable.
// Each column answers an operational question: is the lane seeing signals,
// submitting, filling, spending gas, earning — and where signals die.
export default function Strategies() {
  const { all, currency, prices, refreshMs } = useApp()
  const [tab, setTab] = useState('lanes')
  const [opp, setOpp] = useState(null)

  useEffect(() => {
    let dead = false
    const tick = async () => {
      try {
        const r = await fetch('/api/opportunities')
        if (r.ok && !dead) setOpp(await r.json())
      } catch {}
    }
    tick(); const t = setInterval(tick, refreshMs || 10000)
    return () => { dead = true; clearInterval(t) }
  }, [refreshMs])

  const rows = useMemo(() => {
    const chains = Object.entries(all?.chains || {})
    const lanes = [
      { strategy: 'Atomic flash-loan arb', chains: [], signals: 0, submitted: 0, landed: 0, gas_usd: 0, net_usd: 0, kills: {}, live: false, any: false },
      { strategy: 'Mempool backrun', chains: [], signals: 0, submitted: 0, landed: 0, gas_usd: 0, net_usd: 0, kills: {}, live: false, any: false },
    ]
    for (const [c, m] of chains) {
      if (!m) continue
      const dry = m.arb_dry_run === 1
      // Lane 0 — classic atomic arb
      const sig0 = (total(m, 'arb_profitable_found_total') ?? 0)
      const sub0 = (total(m, 'arb_submit_attempts_total') ?? 0)
      const land0 = (total(m, 'arb_submit_landed_total') ?? 0)
      const gas0 = (total(m, 'arb_gas_spent_wei_total') ?? 0)
      const net0 = (total(m, 'arb_net_profit_usd_total') ?? 0)
      if (sig0 > 0 || sub0 > 0) {
        lanes[0].any = true
        lanes[0].chains.push(c.toUpperCase())
        lanes[0].signals += sig0; lanes[0].submitted += sub0; lanes[0].landed += land0
        lanes[0].net_usd += net0
        lanes[0].live = lanes[0].live || !dry
        const gasWei = gas0 / 1e18
        const nativeUsd = NATIVE_PRICE[c] ? prices?.[NATIVE_PRICE[c]]?.usd : null
        if (nativeUsd) lanes[0].gas_usd += gasWei * nativeUsd
        else if (gasWei > 0) lanes[0].gas_usd = lanes[0].gas_usd || null
        const k = topLabel(m, /arb_gate_rejects_total\{reason="([^"]+)"\}/)
        if (k) lanes[0].kills[k] = (lanes[0].kills[k] || 0) + 1
      }
      // Lane 1 — mempool backrun
      const sig1 = (total(m, 'arb_backrun_candidates_total') ?? 0)
      const sub1 = (total(m, 'arb_backrun_submitted_total') ?? 0)
      let land1 = 0
      for (const [k, v] of Object.entries(m)) {
        const g = k.match(/arb_backrun_stage_total\{stage="venue_accept"\}/)
        if (g) land1 += v
      }
      if (sig1 > 0 || sub1 > 0) {
        lanes[1].any = true
        lanes[1].chains.push(c.toUpperCase())
        lanes[1].signals += sig1; lanes[1].submitted += sub1; lanes[1].landed += land1
        lanes[1].live = lanes[1].live || !dry
        const k = topLabel(m, /arb_backrun_stage_total\{stage="([^"]+)"\}/, ['venue_accept'])
        if (k) lanes[1].kills[k] = (lanes[1].kills[k] || 0) + 1
      }
    }

    // Lane 2 — wallet copy (shadow): signals/submitted from the
    // opportunities feed; fidelity = share of decoded leader signals that
    // matched live state — how far we actually copy.
    const copy = { strategy: 'Wallet copy (shadow)', chains: [], signals: 0, submitted: 0, landed: 0, gas_usd: null, net_usd: null, kills: {}, live: false, fidelity: null, any: false }
    for (const [c, cd] of Object.entries(opp?.chains || {})) {
      const f = cd?.funnel || {}
      if ((f.decoded || 0) > 0) {
        copy.any = true
        copy.chains.push(c.toUpperCase())
        copy.signals += f.decoded || 0
        copy.submitted += (f.submitted || 0) + (f.matched_live || 0)
        copy.landed += f.landed || 0
        if (f.decoded > 0 && f.matched_live != null)
          copy.fidelity = (copy.fidelity ?? 0) + f.matched_live / f.decoded
        for (const [k, v] of Object.entries(f)) {
          if (k.startsWith('rejected_')) {
            const r = k.slice(9)
            copy.kills[r] = (copy.kills[r] || 0) + v
          }
        }
      }
    }
    if (copy.fidelity != null && copy.chains.length > 1)
      copy.fidelity = copy.fidelity / copy.chains.length

    const out = [...lanes.map(l => {
      const net = l.any && l.net_usd !== 0 ? l.net_usd : (l.any ? 0 : null)
      return {
      strategy: l.strategy,
      chain_list: l.chains.join(' · ') || D,
      status: l.live ? 'Live' : 'Measure',
      signals: l.any ? l.signals : null,
      submitted: l.any ? l.submitted : null,
      fill_rate: l.submitted > 0 ? l.landed / l.submitted : null,
      avg_latency: null,
      gas_usd: l.any && l.gas_usd != null && l.gas_usd > 0 ? l.gas_usd : null,
      net_usd: net,
      pnl_per_trade: net != null && l.submitted > 0 ? net / l.submitted : null,
      copy_fidelity: null,
      kill: Object.entries(l.kills).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }}), {
      strategy: copy.strategy,
      chain_list: copy.chains.join(' · ') || D,
      status: 'Shadow',
      signals: copy.any ? copy.signals : null,
      submitted: copy.any ? copy.submitted : null,
      fill_rate: copy.submitted > 0 ? copy.landed / copy.submitted : null,
      avg_latency: null,
      gas_usd: null,
      net_usd: null,
      pnl_per_trade: null,
      copy_fidelity: copy.fidelity,
      kill: Object.entries(copy.kills).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }]
    return out
  }, [all, opp, prices])

  const [sorted, th] = useSort(rows, ['strategy', 1])
  const totalNet = rows.reduce((s, r) => s + (r.net_usd || 0), 0)

  return (
    <div className="grid">
      <div className="panel" style={{ padding: '8px 12px' }}>
        <form className="inline" onSubmit={e => e.preventDefault()}>
          {[
            ['lanes', 'Lanes — strategy health'],
            ['intel', 'Wallet attribution — per-leader scoring'],
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
            <div className="card"><div className="k">Lanes with signals</div>
              <div className="v">{rows.filter(r => r.signals != null).length}</div>
              <div className="s">of {rows.length} tracked</div></div>
            <div className="card"><div className="k">Net P&L</div>
              <div className={`v ${totalNet > 0 ? 'pos' : totalNet < 0 ? 'neg' : ''}`}>
                {usd0(totalNet, currency, prices)}</div>
              <div className="s">all lanes, all chains</div></div>
            <div className="card"><div className="k">Signals</div>
              <div className="v">{cnt(rows.reduce((s, r) => s + (r.signals || 0), 0))}</div>
              <div className="s">since runner start</div></div>
            <div className="card"><div className="k">Submitted</div>
              <div className="v">{cnt(rows.reduce((s, r) => s + (r.submitted || 0), 0))}</div>
              <div className="s">reached venues</div></div>
          </div>

          <div className="panel">
            <h3 title="one row per strategy lane — health, spend, and the stage where signals die">Strategy lanes</h3>
            <table className="tbl">
              <thead><tr>
                {th('strategy', 'Strategy')}{th('chain_list', 'Chains')}{th('status', 'Status')}
                {th('signals', 'Signals')}{th('submitted', 'Submitted')}{th('fill_rate', 'Fill rate')}
                {th('avg_latency', 'Avg latency')}{th('gas_usd', 'Gas spent')}
                {th('net_usd', 'Net P&L')}{th('pnl_per_trade', 'P&L/trade')}{th('copy_fidelity', 'Copy fidelity')}
                {th('kill', 'Top kill stage')}
              </tr></thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={i}>
                    <td>{r.strategy}</td>
                    <td className="dim">{r.chain_list}</td>
                    <td><span className={`tag ${r.status === 'Live' ? 'live' : r.status === 'Shadow' ? 'dry' : ''}`}>{r.status}</span></td>
                    <td className="num">{cnt(r.signals)}</td>
                    <td className="num">{cnt(r.submitted)}</td>
                    <td className="num">{pct(r.fill_rate)}</td>
                    <td className="num">{sec(r.avg_latency)}</td>
                    <td className="num">{usd0(r.gas_usd, currency, prices)}</td>
                    <td className={`num ${r.net_usd > 0 ? 'pos' : r.net_usd < 0 ? 'neg' : ''}`}>
                      {usd0(r.net_usd, currency, prices)}</td>
                    <td className={`num ${r.pnl_per_trade > 0 ? 'pos' : r.pnl_per_trade < 0 ? 'neg' : ''}`}>
                      {usd0(r.pnl_per_trade, currency, prices)}</td>
                    <td className="num">{pct(r.copy_fidelity)}</td>
                    <td className="dim">{r.kill || D}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="dim" style={{ marginTop: 8, fontSize: 12 }}>
              Copy fidelity = share of a leader's decoded signals matched on
              live state — how far we actually copy. Only meaningful for the
              wallet-copy lane. Per-leader scoring lives in the Wallet
              attribution tab.
            </p>
          </div>
        </div>
      ) : <WalletIntelligence />}
    </div>
  )
}

function usd0(v, currency, prices) {
  return v == null ? '—' : fmt(v, currency, prices)
}
