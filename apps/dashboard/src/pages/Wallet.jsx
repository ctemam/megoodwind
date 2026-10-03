import React, { useEffect, useState } from 'react'
import { useApp, fmt } from '../state.jsx'
import Collap from '../Collap.jsx'

export default function Wallet() {
  const { prices, currency } = useApp()
  const [wallets, setWallets] = useState([])
  const [live, setLive] = useState(false)
  const [cfg, setCfg] = useState(null)
  const [form, setForm] = useState({ chain: 'bsc', to: '', amountWei: '' })
  const [msg, setMsg] = useState(null)

  const load = async () => {
    const [w, c] = await Promise.all([
      fetch('/api/wallets').then(r => r.json()).catch(() => null),
      fetch('/api/withdraw/config').then(r => r.json()).catch(() => null),
    ])
    if (w) { setWallets(w.wallets || []); setLive(w.live) }
    if (c) setCfg(c.auto)
  }
  useEffect(() => { load() }, [])

  const setAuto = async (patch) => {
    const r = await fetch('/api/withdraw/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(r => r.json())
    setCfg(r.auto); setMsg(r.note)
  }
  const manual = async (e) => {
    e.preventDefault()
    const r = await fetch('/api/withdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }).then(r => r.json())
    setMsg(r.dryRun ? `DRY-RUN: would call ${r.wouldCall} on ${r.chain} → ${r.to || '(owner)'} ${r.amountWei || ''} wei` : (r.error || 'submitted'))
  }
  const eth = (wei) => wei ? Number(BigInt(wei)) / 1e18 : null

  return (
    <div className="grid">
      <div className="panel" style={{ marginTop: 0 }}>
        <h3>Balances <span className={`tag ${live ? 'live' : 'dry'}`}>{live ? 'LIVE' : 'DRY-RUN'}</span></h3>
        <table>
          <thead><tr><th>Chain</th><th>Role</th><th>Address</th><th>Balance</th><th>USD</th></tr></thead>
          <tbody>
            {wallets.map((w, i) => {
              const native = eth(w.balanceWei)
              const price = w.chain === 'bsc' ? prices?.binancecoin?.usd : prices?.ethereum?.usd
              return (
                <tr key={i}>
                  <td>{w.chain.toUpperCase()}</td>
                  <td>{w.kind.replace('_', ' ')}</td>
                  <td className="mono">{w.address.slice(0, 10)}…{w.address.slice(-6)}</td>
                  <td>{native === null ? '—' : `${native.toFixed(6)} ${w.chain === 'bsc' ? 'BNB' : 'ETH'}`}</td>
                  <td>{native !== null && price ? fmt(native * price, currency, prices) : '—'}</td>
                </tr>
              )
            })}
            {!wallets.length && <tr><td colSpan={5} className="dim">No wallet/contract addresses configured in .env yet</td></tr>}
          </tbody>
        </table>
      </div>

      <Collap title="Auto-withdrawal">
        <form className="inline">
          <label className="dim">Sweep when balance ≥ USD</label>
          <input type="number" value={cfg?.thresholdUsd ?? 100} onChange={e => setAuto({ thresholdUsd: +e.target.value })} style={{ width: 100 }} />
          <label className="dim">to</label>
          <input placeholder="0x destination" value={cfg?.to || ''} onChange={e => setAuto({ to: e.target.value })} style={{ width: 340 }} />
          <button type="button" className={cfg?.enabled ? '' : 'primary'} onClick={() => setAuto({ enabled: !cfg?.enabled })}>
            {cfg?.enabled ? 'Disable sweep' : 'Enable sweep'}
          </button>
          {cfg?.enabled && <span className={`tag ${live ? 'live' : 'dry'}`}>{live ? 'ARMED' : 'ARMED (dry-run)'}</span>}
        </form>
      </Collap>

      <Collap title="Manual withdrawal">
        <form className="inline" onSubmit={manual}>
          <select value={form.chain} onChange={e => setForm(f => ({ ...f, chain: e.target.value }))}>
            <option value="bsc">BSC</option><option value="base">Base</option>
          </select>
          <input placeholder="to address (0x…)" value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value }))} style={{ width: 340 }} />
          <input placeholder="amount (wei)" value={form.amountWei} onChange={e => setForm(f => ({ ...f, amountWei: e.target.value }))} style={{ width: 160 }} />
          <button className="primary" type="submit">Withdraw</button>
        </form>
        {msg && <div className={msg.startsWith('DRY-RUN') ? 'warn-box' : 'ok-box'}>{msg}</div>}
        <div className="dim" style={{ marginTop: 10, fontSize: 12 }}>
          Manual withdraw calls the executor's owner-only <code>emergencyWithdraw</code>. Broadcast is gated by <code>LIVE_COMMANDER_APPROVED</code> — in dry-run it returns the exact call it would make.
        </div>
      </Collap>
    </div>
  )
}
