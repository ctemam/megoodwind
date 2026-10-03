import React, { useEffect, useState } from 'react'
import { useApp, fmt } from '../state.jsx'
import Collap from '../Collap.jsx'

export default function Wallet() {
  const { prices, currency } = useApp()
  const [wallets, setWallets] = useState([])
  const [accts, setAccts] = useState([])   // registered user accounts (persisted)
  const [live, setLive] = useState(false)
  const [cfg, setCfg] = useState(null)
  const [form, setForm] = useState({ chain: 'bsc', to: '', amountWei: '' })
  const [msg, setMsg] = useState(null)
  const [mm, setMm] = useState(null)      // {available, accounts:[{address, chainId, balanceWei}]}
  const [mmBusy, setMmBusy] = useState(false)
  const [sort, setSort] = useState({ key: 'nick', dir: 1 })
  const [nicks, setNicks] = useState({})  // address.lower -> nickname
  const [mmBals, setMmBals] = useState({}) // address.lower -> {bsc, base}

  const saveNick = async (address, name) => {
    const r = await fetch('/api/wallet/nicknames', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, name }),
    }).then(r => r.json()).catch(() => null)
    if (r?.nicknames) setNicks(r.nicknames)
  }
  useEffect(() => {
    fetch('/api/wallet/nicknames').then(r => r.json()).then(setNicks).catch(() => {})
  }, [])

  // Per-chain balances for every user account (registered + detected) —
  // queried on EVERY configured chain, not just MetaMask's active one.
  useEffect(() => {
    const seen = new Set()
    for (const a of [...accts.map(x => x.address), ...(mm?.accounts || []).map(x => x.address)]) {
      const key = a.toLowerCase()
      if (seen.has(key) || mmBals[key]) continue
      seen.add(key)
      fetch(`/api/wallet/balance?address=${a}`).then(r => r.json())
        .then(d => setMmBals(x => ({ ...x, [key]: d }))).catch(() => {})
    }
  }, [mm, accts])

  const load = async () => {
    const [w, c] = await Promise.all([
      fetch('/api/wallets').then(r => r.json()).catch(() => null),
      fetch('/api/withdraw/config').then(r => r.json()).catch(() => null),
    ])
    if (w) { setWallets(w.wallets || []); setLive(w.live); setAccts(w.accounts || []) }
    if (c) setCfg(c.auto)
  }
  useEffect(() => { load() }, [])

  // Register a detected account server-side — it then stays in the table
  // permanently with per-chain balances even without MetaMask open.
  const register = async (address, chainId) => {
    const r = await fetch('/api/wallet/accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, chainId, source: 'metamask' }),
    }).then(r => r.json()).catch(() => null)
    if (r?.ok) load()
  }
  const removeAcct = async (address) => {
    await fetch(`/api/wallet/accounts/${address}`, { method: 'DELETE' })
    load()
  }

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
      for (const a of rows) register(a.address, chainId)
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
  const usdOf = (c, n) => n != null ? n * ((c === 'bsc' ? prices?.binancecoin?.usd : prices?.ethereum?.usd) ?? 0) : null

  // Unified rows: one row per account, per-chain balance columns + total.
  const rows = [
    ...wallets.map(w => {
      const n = eth(w.balanceWei)
      return {
        address: w.address, role: w.kind.replace('_', ' '),
        nick: nicks[w.address.toLowerCase()] || '',
        bsc: w.chain === 'bsc' ? n : null, base: w.chain === 'base' ? n : null,
        usd: w.chain ? usdOf(w.chain, n) : null,
      }
    }),
    // user accounts — union of persisted registrations + live MetaMask
    ...[...new Set([...accts.map(x => x.address), ...(mm?.accounts || []).map(x => x.address)])].map(addr => {
      const key = addr.toLowerCase()
      const b = mmBals[key] || {}
      const bsc = eth(b.bsc), base = eth(b.base)
      const usd = [usdOf('bsc', bsc), usdOf('base', base)].reduce((s, v) => s + (v ?? 0), 0)
      return { address: addr, role: 'metamask', nick: nicks[key] || '', removable: true,
        bsc, base, usd: (bsc != null || base != null) ? usd : null }
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
  const tot = k => rows.reduce((s, r) => s + (r[k] ?? 0), 0)
  const totUsd = rows.reduce((s, r) => s + (r.usd ?? 0), 0)
  const showN = (n, sym) => n == null ? '—' : `${n.toFixed(6)} ${sym}`

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
          <thead><tr>
            {th('nick', 'Nickname')}{th('role', 'Role')}{th('address', 'Address')}
            {th('bsc', 'BSC · BNB')}{th('base', 'BASE · ETH')}{th('usd', 'Total USD')}<th></th>
          </tr></thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.address}:${i}`}>
                <td>
                  <input className="nick" placeholder="—"
                    defaultValue={r.nick} key={r.address}
                    onBlur={e => e.target.value !== r.nick && saveNick(r.address, e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && e.target.blur()} />
                </td>
                <td>{r.role === 'metamask' ? <span className="tag">metamask</span> : r.role}</td>
                <td className="mono">{r.address.slice(0, 10)}…{r.address.slice(-6)}</td>
                <td className="mono">{showN(r.bsc, 'BNB')}</td>
                <td className="mono">{showN(r.base, 'ETH')}</td>
                <td>{r.usd != null ? fmt(r.usd, currency, prices) : '—'}</td>
                <td>{r.removable && <button title="Remove" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => removeAcct(r.address)}>✕</button>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="dim">No wallet/contract addresses configured in .env yet — connect MetaMask to add yours.</td></tr>}
          </tbody>
          {rows.length > 0 && (
            <tfoot><tr className="total">
              <td colSpan={3}><b>Total · {rows.length} accounts</b></td>
              <td className="mono"><b>{showN(tot('bsc'), 'BNB')}</b></td>
              <td className="mono"><b>{showN(tot('base'), 'ETH')}</b></td>
              <td><b>{fmt(totUsd, currency, prices)}</b></td>
              <td></td>
            </tr></tfoot>
          )}
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
