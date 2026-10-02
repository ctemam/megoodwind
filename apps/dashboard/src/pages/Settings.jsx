import React from 'react'
import { useApp } from '../state.jsx'

export default function Settings() {
  const { refreshMs, setRefreshMs, currency, setCurrency, prices, all } = useApp()
  return (
    <div className="grid">
      <div className="panel" style={{ marginTop: 0 }}>
        <h3>Console settings</h3>
        <form className="inline">
          <label className="dim">Refresh interval</label>
          <select value={refreshMs} onChange={e => setRefreshMs(+e.target.value)}>
            {[1000, 2000, 5000, 10000, 15000, 30000].map(ms => <option key={ms} value={ms}>{ms / 1000}s</option>)}
          </select>
          <label className="dim">Display currency</label>
          <select value={currency} onChange={e => setCurrency(e.target.value)}>
            {['USD', 'ETH', 'USDT'].map(c => <option key={c}>{c}</option>)}
          </select>
        </form>
        <div className="dim" style={{ marginTop: 12, fontSize: 12 }}>
          Live prices (CoinGecko): ETH {prices?.ethereum?.usd ? `$${prices.ethereum.usd}` : '—'} ·
          BNB {prices?.binancecoin?.usd ? `$${prices.binancecoin.usd}` : '—'} ·
          USDT {prices?.tether?.usd ? `$${prices.tether.usd}` : '—'}
        </div>
      </div>
      <div className="panel">
        <h3>Engine flags (read-only)</h3>
        <div className="step"><span className="n">MODE</span><div><strong>{all.live ? 'LIVE' : 'DRY-RUN'}</strong> — flip in config/*.toml + .env LIVE_COMMANDER_APPROVED</div></div>
        <div className="step"><span className="n">GATE</span><div>min_net_profit $1.50 floor · max 3 hops · strict_4337 submission</div></div>
        <div className="step"><span className="n">GOV</span><div>No live tx without SIMULATION_VERIFIED + Commander approval (.windsurfrules)</div></div>
      </div>
    </div>
  )
}
