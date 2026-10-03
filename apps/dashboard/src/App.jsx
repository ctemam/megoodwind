import React, { useState } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { useApp, fmt } from './state.jsx'
import Overview from './pages/Overview.jsx'
import PnL from './pages/PnL.jsx'
import Wallet from './pages/Wallet.jsx'
import Deployment from './pages/Deployment.jsx'
import Opportunities from './pages/Opportunities.jsx'
import Infra from './pages/Infra.jsx'
import Report from './pages/Report.jsx'
import ChainConfig from './pages/ChainConfig.jsx'
import AgentPanel from './AgentPanel.jsx'

const NAV = [
  ['/', '⌂', 'Dashboard'],
  ['/pnl', '◔', 'Profit & Loss'],
  ['/report', '≣', 'Report'],
  ['/wallet', '◉', 'Wallet'],
  ['/deploy', '▣', 'Deployment'],
  ['/opps', '⚡', 'Opportunities'],
  ['/infra', '⛓', 'Infrastructure'],
  ['/config', '⚙', 'Chain Config'],
]

export default function App() {
  const { refreshMs, setRefreshMs, currency, setCurrency, profitPeriod, setProfitPeriod, prices, all, history } = useApp()
  const [collapsed, setCollapsed] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const net = (profitPeriod === 'day' ? all.profit?.day : all.profit?.lifetime)
    ?? (history.length ? history[history.length - 1].net : 0)
  const online = Object.values(all.chains || {}).filter(Boolean).length

  return (
    <>
      <nav className={collapsed ? 'collapsed' : ''}>
        <div className="brand">
          <img src="/logo.png" alt="AB" />
          <div>
            <div className="name">ALLBRIGHT</div>
            <div className="sub">Arbitrage Intelligence</div>
          </div>
        </div>
        {NAV.map(([to, icon, label]) => (
          <NavLink key={to} to={to} end={to === '/'} title={label}>
            <span className="ic">{icon}</span><span className="lbl">{label}</span>
          </NavLink>
        ))}
        <button className="collapse-btn" onClick={() => setCollapsed(c => !c)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? '»' : '«'}
        </button>
        <div className="tagline"><b>Smarter Capital</b>Brighter Returns</div>
      </nav>
      <main className={collapsed ? 'wide' : ''}>
        <header>
          <div className="pulse">
            <div className={`dot ${online ? '' : 'off'}`} />
            <span className={`val ${net >= 0 ? 'pos' : 'neg'}`}>{fmt(net, currency, prices)}</span>
            <select className="period" value={profitPeriod} onChange={e => setProfitPeriod(e.target.value)} title="Profit window">
              <option value="day">24h</option>
              <option value="life">Lifetime</option>
            </select>
          </div>
          <div className="status-pill">
            <div className="sd" style={online < 2 ? { background: 'var(--warn)', boxShadow: '0 0 8px var(--warn)' } : {}} />
            <div><b>{online === 2 ? 'SYSTEM ONLINE' : 'DEGRADED'}</b><br /><span>{online}/2 runners · {all.live ? 'LIVE' : 'dry-run'}</span></div>
          </div>
          <button className={`agent-btn ${agentOpen ? 'on' : ''}`} onClick={() => setAgentOpen(o => !o)} title="Ops Copilot">◆</button>
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
          <Route path="/report" element={<Report />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/deploy" element={<Deployment />} />
          <Route path="/opps" element={<Opportunities />} />
          <Route path="/infra" element={<Infra />} />
          <Route path="/config" element={<ChainConfig />} />
        </Routes>
        <div className="footer-strip">
          <div className="seg"><b>ALLBRIGHT</b></div>
          {Object.entries(all.chains || {}).map(([c, m]) => (
            <div className="seg" key={c}>
              <span className={`fd ${m ? 'on' : 'off'}`} />
              {c.toUpperCase()}{m?.arb_current_block ? ` · ${Math.round(m.arb_current_block)}` : ''}
            </div>
          ))}
          <div className="seg">{all.live ? 'LIVE' : 'DRY-RUN'}</div>
          <div className="seg" style={{ marginLeft: 'auto' }}>Scan → Evaluate → Execute → Settle</div>
          {all.commit && <div className="seg dim" style={{ fontFamily: 'monospace' }}>{all.commit}</div>}
        </div>
        <AgentPanel open={agentOpen} onClose={() => setAgentOpen(false)} />
      </main>
    </>
  )
}
