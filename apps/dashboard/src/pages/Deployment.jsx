import React, { useEffect, useState } from 'react'
import { useApp, fmt } from '../state.jsx'

const LABEL = { bsc: 'BNB Chain', base: 'Base' }

function useApi(path, dep) {
  const [data, setData] = useState(null)
  useEffect(() => {
    let live = true
    fetch(path).then(r => r.json()).then(d => { if (live) setData(d) }).catch(() => {})
    return () => { live = false }
  }, [path, dep])
  return [data, setData]
}

export default function Deployment() {
  const { all, currency, prices, refreshMs } = useApp()
  const chains = all.chains || {}
  const [preflight] = useApi('/api/deploy/preflight', refreshMs)
  const [sim, setSim] = useApi('/api/deploy/sim', refreshMs)
  const [deploys] = useApi('/api/deploy/instances', refreshMs)
  const [sort, setSort] = useState({ key: 'registered_at', dir: -1 })
  const [confirm, setConfirm] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)

  const simTotal = sim ? Object.values(sim.chains || {}).reduce(
    (s, c) => s + (c?.evals || 0), 0) : 0
  const simHits = sim ? Object.values(sim.chains || {}).reduce(
    (s, c) => s + (c?.hits || 0), 0) : 0

  const preflightOk = preflight?.checks?.every(c => c.ok)
  const live = all.live || sim?.live || preflight?.live

  const verify = async () => {
    setBusy(true)
    const d = await fetch('/api/simulation/verify', { method: 'POST' }).then(r => r.json()).catch(() => null)
    if (d) setSim(s => ({ ...s, verified: d.verified, verifiedAt: d.verifiedAt }))
    setBusy(false)
  }

  const goLive = async () => {
    setBusy(true); setResult(null)
    const d = await fetch('/api/deploy/golive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm }),
    }).then(r => r.json()).catch(e => ({ error: e.message }))
    setResult(d)
    setBusy(false)
  }

  return (
    <div className="grid">
      {live && <div className="ok-box">ENGINE LIVE — runners are submitting real transactions. Simulation is closed.</div>}

      {/* ── 1. PREFLIGHT ── */}
      <div className="panel" style={{ marginTop: 0 }}>
        <h3>1 · Preflight</h3>
        {(preflight?.checks || []).map((c, i) => (
          <div className="step" key={i}>
            <span className="n" style={{ color: c.ok ? 'var(--good)' : 'var(--bad)' }}>{c.ok ? '✓' : '✗'}</span>
            <div><strong>{c.name}</strong><div className="dim" style={{ fontSize: 12 }}>{c.detail}</div></div>
          </div>
        ))}
        {(preflight?.advisory || []).map((a, i) => (
          <div className="step" key={`a${i}`}>
            <span className="n" style={{ color: 'var(--warn)' }}>○</span>
            <div><div className="dim" style={{ fontSize: 12 }}>{a}</div></div>
          </div>
        ))}
      </div>

      {/* ── 2. SIMULATION ── */}
      <div className="panel">
        <h3>2 · Simulation {!live && sim?.verified && <span className="tag live" style={{ marginLeft: 8 }}>verified</span>}</h3>
        <div className="grid cards" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {['bsc', 'base'].map(c => {
            const s = sim?.chains?.[c]
            return (
              <div className="card" key={c}>
                <div className="k">{LABEL[c]} sim</div>
                <div className="v" style={{ fontSize: 18 }}>{s?.online ? `${(s.hitRate * 100).toFixed(2)}% hit` : 'offline'}</div>
                <div className="s">{s?.online ? `${s.hits.toLocaleString()} profitable of ${s.evals.toLocaleString()} evals · ${s.scans.toLocaleString()} blocks` : 'runner down'}</div>
              </div>
            )
          })}
          <div className="card">
            <div className="k">Sim total</div>
            <div className="v" style={{ fontSize: 18 }}>{simTotal.toLocaleString()}</div>
            <div className="s">paths evaluated · {simHits.toLocaleString()} profitable</div>
          </div>
        </div>
        {!live && (
          <form className="inline" onSubmit={e => { e.preventDefault(); verify() }}>
            <span className="dim" style={{ fontSize: 12 }}>
              {sim?.verified ? `Verified ${new Date(sim.verifiedAt).toLocaleString()}` : 'Review the metrics, then attest simulation quality (SIMULATION_VERIFIED).'}
            </span>
            {!sim?.verified && <button className="primary" disabled={busy || !simTotal}>Verify simulation</button>}
          </form>
        )}
      </div>

      {/* ── 3. GO LIVE ── */}
      <div className="panel">
        <h3>3 · Go live</h3>
        {live ? (
          <div className="dim" style={{ fontSize: 13 }}>Live mode active — this stage is closed. Simulation was auto-killed when the runners restarted.</div>
        ) : (
          <>
            <div className="dim" style={{ fontSize: 13, marginBottom: 10 }}>
              Flips <code>dry_run=false</code> + <code>LIVE_COMMANDER_APPROVED=true</code> and restarts both runners —
              <b> the restart auto-kills simulation</b>. Real transactions begin immediately.
            </div>
            {!preflightOk && <div className="warn-box">Preflight has failing checks — go-live stays disabled.</div>}
            {!sim?.verified && preflightOk && <div className="warn-box">Verify simulation (step 2) to unlock go-live.</div>}
            <form className="inline" onSubmit={e => { e.preventDefault(); goLive() }}>
              <input placeholder="type GO_LIVE" value={confirm} onChange={e => setConfirm(e.target.value)} style={{ width: 160 }} />
              <button className="primary" disabled={busy || confirm !== 'GO_LIVE' || !sim?.verified || !preflightOk}>
                Go live
              </button>
            </form>
            {result?.error && <div className="warn-box">{result.error}</div>}
            {result?.ok && <div className="ok-box">{result.note} Flipped: {result.flipped?.join(', ') || 'already live'}</div>}
          </>
        )}
      </div>

      {/* ── Deployment registry — auto-registered instances ── */}
      <div className="panel">
        <h3>Deployment registry</h3>
        <table>
          <thead>
            <tr>
              {[
                ['id', 'ID'], ['instance', 'Instance'], ['chain', 'Chain'],
                ['contract', 'Contract'], ['reader', 'State reader'],
                ['commit', 'Commit'], ['mode', 'Mode'], ['online', 'Status'],
                ['pid', 'PID'], ['uptime_ms', 'Uptime'], ['restarts', 'Restarts'],
                ['registered_at', 'Registered'],
              ].map(([k, label]) => (
                <th key={k} style={{ cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => setSort(s => ({ key: k, dir: s.key === k ? -s.dir : 1 }))}>
                  {label}{sort.key === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(deploys?.instances || [])
              .slice()
              .sort((a, b) => {
                const va = a[sort.key], vb = b[sort.key]
                if (va == null && vb == null) return 0
                if (va == null) return 1
                if (vb == null) return -1
                return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir
              })
              .map(r => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td>{r.instance}</td>
                  <td>{LABEL[r.chain] || r.chain}</td>
                  <td className="mono" title={r.contract}>{r.contract ? `${r.contract.slice(0, 8)}…${r.contract.slice(-6)}` : '—'}</td>
                  <td className="mono" title={r.reader}>{r.reader ? `${r.reader.slice(0, 8)}…${r.reader.slice(-6)}` : '—'}</td>
                  <td className="mono">{r.commit || '—'}</td>
                  <td><span className={`tag ${r.mode === 'LIVE' ? 'live' : 'dry'}`}>{r.mode}</span></td>
                  <td><span className={`tag ${r.online ? 'live' : ''}`}>{r.online ? 'online' : 'down'}</span></td>
                  <td className="mono">{r.pid ?? '—'}</td>
                  <td className="mono">{r.uptime_ms != null ? `${Math.floor(r.uptime_ms / 60000)}m` : '—'}</td>
                  <td className="mono">{r.restarts ?? '—'}</td>
                  <td className="mono">{r.registered_at ? new Date(r.registered_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
