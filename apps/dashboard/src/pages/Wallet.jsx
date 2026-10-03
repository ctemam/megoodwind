import React, { useEffect, useState } from 'react'
import { useApp, fmt } from '../state.jsx'
import Collap from '../Collap.jsx'

const CHAIN_INFO = { 56: { key: 'bsc', label: 'BSC', sym: 'BNB', px: 'binancecoin' }, 8453: { key: 'base', label: 'BASE', sym: 'ETH', px: 'ethereum' } }
const chainInfo = id => CHAIN_INFO[id] || { key: `chain${id}`, label: `ETH #${id}`, sym: 'ETH', px: 'ethereum' }

export default function Wallet() {
  const { prices, currency } = useApp()
  const [wallets, setWallets] = useState([])
  const [live, setLive] = useState(false)
  const [cfg, setCfg] = useState(null)
  const [form, setForm] = useState({ chain: 'bsc', to: '', amountWei: '' })
  const [msg, setMsg] = useState(null)
  const [mm, setMm] = useState(null)      // {available, accounts:[{address, chainId, balanceWei}]}
  const [mmBusy, setMmBusy] = useState(false)
  const [sort, setSort] = useState({ key: 'chain', dir: 1 })

  const load = async () => {
    const [w, c] = await Promise.all([
      fetch('/api/wallets').then(r => r.json()).catch(() => null),
      fetch('/api/withdraw/config').then(r => r.json()).catch(() => null),
    ])
    if (w) { setWallets(w.wallets || []); setLive(w.live) }
    if (c) setCfg(c.auto)
  }
  useEffect(() => { load() }, [])

  // ── MetaMask auto-detect: silent read of already-connected accounts,
  //    one-click connect otherwise. eth_getBalance on the active chain. ──
  const detect = async (request = false) => {
    const eth = window.ethereum
    if (!eth) { setMm({ available: false, accounts: [] }); return }
    setMmBusy(true)
    try {
      let accounts = await eth.request({ method: request ? 'eth_requestAccounts' : 'eth_accounts' })
      const chainId = parseInt(await eth.request({ method: 'eth_chainId' }), 16)
      const rows = []
      for (const address of accounts || []) {
        let balanceWei = null
        try { balanceWei = BigInt(await eth.request({ method: 'eth_getBalance', params: [address, 'latest'] })).toString() } catch {}
        rows.push({ address, chainId, balanceWei })
      }
      setMm({ available: true, accounts: rows })
      if (!eth.__abWatch) {
        eth.__abWatch = true
        eth.on?.('accountsChanged', () => detect(false))
        eth.on?.('chainChanged', () => detect(false))
      }
    } catch (e) {
      setMm({ available: true, accounts: [], error: e.code === 4001 ? 'connection rejected' : e.message })
    } finally { setMmBusy(false) }
  }
  useEffect(() => { detect(false) }, [])

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

  // Unified rows: executor/signer wallets + detected MetaMask accounts.
  const rows = [
    ...wallets.map(w => ({
      chain: w.chain.toUpperCase(), role: w.kind.replace('_', ' '), address: w.address,
      native: eth(w.balanceWei), sym: w.chain === 'bsc' ? 'BNB' : 'ETH',
      usd: eth(w.balanceWei) != null ? eth(w.balanceWei) * (w.chain === 'bsc' ? prices?.binancecoin?.usd : prices?.ethereum?.usd) || null : null,
    })),
    ...(mm?.accounts || []).map(a => {
      const ci = chainInfo(a.chainId)
      const n = eth(a.balanceWei)
      return { chain: ci.label, role: 'metamask', address: a.address, native: n, sym: ci.sym,
        usd: n != null ? n * (prices?.[ci.px]?.usd ?? 0) || null : null }
    }),
  ]
  const sorted = rows.slice().sort((a, b) => {
    const va = a[sort.key], vb = b[sort.key]
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1
    return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir
  })
  const th = (key, label) => (
    <th style={{ cursor: 'pointer', userSelect: 'none' }}
      onClick={() => setSort(s => ({ key, dir: s.key === key ? -s.dir : 1 }))}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  )

  return (
    <div className="grid">
      <Collap title={`Balances · ${rows.length} account${rows.length === 1 ? '' : 's'}`}
        style={{ marginTop: 0 }}
        extra={<>
          <span className={`tag ${live ? 'live' : 'dry'}`}>{live ? 'LIVE' : 'DRY-RUN'}</span>
          {mm?.available === false
            ? <span className="dim" style={{ fontSize: 11 }}>MetaMask not detected</span>
            : <button onClick={() => detect(true)} disabled={mmBusy}>
                {mm?.accounts?.length ? `${mm.accounts.length} MetaMask account${mm.accounts.length === 1 ? '' : 's'}` : 'Connect MetaMask'}
              </button>}
        </>}>
        <table>
          <thead><tr>{th('chain', 'Chain')}{th('role', 'Role')}{th('address', 'Address')}{th('native', 'Balance')}{th('usd', 'USD')}</tr></thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.address}:${r.chain}:${i}`}>
                <td>{r.chain}</td>
                <td>{r.role === 'metamask' ? <span className="tag">metamask</span> : r.role}</td>
                <td className="mono">{r.address.slice(0, 10)}…{r.address.slice(-6)}</td>
                <td>{r.native === null ? '—' : `${r.native.toFixed(6)} ${r.sym}`}</td>
                <td>{r.usd != null ? fmt(r.usd, currency, prices) : '—'}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="dim">No wallet/contract addresses configured in .env yet — connect MetaMask to add yours.</td></tr>}
          </tbody>
        </table>
        {mm?.error && <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>MetaMask: {mm.error}</div>}
      </Collap>

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
