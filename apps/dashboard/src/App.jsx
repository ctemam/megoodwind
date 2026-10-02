import React from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { useApp, fmt } from './state.jsx'
import Overview from './pages/Overview.jsx'
import PnL from './pages/PnL.jsx'
import Wallet from './pages/Wallet.jsx'
import Deployment from './pages/Deployment.jsx'
import Opportunities from './pages/Opportunities.jsx'
import Infra from './pages/Infra.jsx'
import Settings from './pages/Settings.jsx'

const NAV = [
  ['/', 'Overview'],
  ['/pnl', 'Profit & Loss'],
  ['/wallet', 'Wallet'],
  ['/deploy', 'Deployment'],
  ['/opps', 'Opportunities'],
  ['/infra', 'Infrastructure'],
  ['/settings', 'Settings'],
]

export default function App() {
  const { refreshMs, setRefreshMs, currency, setCurrency, prices, all, history } = useApp()
  const net = history.length ? history[history.length - 1].net : 0
  const online = Object.values(all.chains || {}).filter(Boolean).length

  return (
    <>
      <nav>
        <div className="brand">allbright<span>A</span></div>
        {NAV.map(([to, label]) => (
          <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>
        ))}
      </nav>
      <main>
        <header>
          <h1>Total Profit Pulse</h1>
          <div className="pulse">
            <div className={`dot ${online ? '' : 'off'}`} />
            <span className={`val ${net >= 0 ? 'pos' : 'neg'}`}>{fmt(net, currency, prices)}</span>
            <span className="dim" style={{ fontSize: 12 }}>
              {online}/2 runners online · {all.live ? 'LIVE' : 'dry-run'}
            </span>
          </div>
          <div className="ctl">
            <select value={currency} onChange={e => setCurrency(e.target.value)}>
              {['USD', 'ETH', 'USDT'].map(c => <option key={c}>{c}</option>)}
            </select>
            <select value={refreshMs} onChange={e => setRefreshMs(+e.target.value)}>
              {[1000, 2000, 5000, 10000, 15000, 30000].map(ms => (
                <option key={ms} value={ms}>{ms / 1000}s refresh</option>
              ))}
            </select>
          </div>
        </header>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/pnl" element={<PnL />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/deploy" element={<Deployment />} />
          <Route path="/opps" element={<Opportunities />} />
          <Route path="/infra" element={<Infra />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </>
  )
}
