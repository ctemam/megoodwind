import React, { useCallback, useEffect, useState } from 'react'
import { useApp, fmt } from '../state.jsx'

const CHAIN_ORDER = ['bsc', 'base']
const STATUS_COLOR = { healthy: 'var(--acc)', degraded: 'var(--warn)', slow: 'var(--warn)', noisy: '#ff7a45', down: 'var(--neg)' }

function useApi(path, dep) {
  const [d, setD] = useState(null)
  useEffect(() => {
    let live = true
    fetch(path).then(r => r.json()).then(x => live && setD(x)).catch(() => {})
    return () => { live = false }
  }, [dep])
  return d
}

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
}).then(r => r.json())

export default function ChainConfig() {
  const { currency, setCurrency, refreshMs, setRefreshMs, prices, all } = useApp()
  const [chain, setChain] = useState('bsc')
  const [tick, setTick] = useState(0)
  const reload = () => setTick(t => t + 1)
  const chains = useApi('/api/config/chains', tick)
  const capacity = useApi('/api/config/capacity', tick)
  const recs = useApi(`/api/config/recommendations?chain=${chain}`, `${chain}:recs`)
  const health = useApi(`/api/config/chains/${chain}/health`, `${chain}:${tick}`)
  const drafts = useApi('/api/config/drafts', tick)
  const audit = useApi('/api/config/audit', tick)
  const cfg = chains?.chains?.[chain]

  // draft form
  const [ftype, setFtype] = useState('token')
  const [fields, setFields] = useState({})
  const [busy, setBusy] = useState(false)
  const f = k => e => setFields(x => ({ ...x, [k]: e.target.value }))

  const act = async (path, body) => {
    setBusy(true)
    try { await post(path, body) } finally { setBusy(false); reload() }
  }

  const cap = health?.capacity

  return (
    <div className="grid">
      <div className="panel" style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, marginRight: 'auto' }}>Chain configuration — Draft → Validate → Simulate → Apply</h3>
        {CHAIN_ORDER.map(c => (
          <button key={c} className={chain === c ? 'primary' : ''} onClick={() => setChain(c)}>
            {chains?.chains?.[c]?.label || c}
          </button>
        ))}
      </div>

      {/* ── Chain summary ── */}
      <div className="grid cards" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="card"><div className="k">Chain ID</div><div className="v">{cfg?.chain_id ?? '—'}</div><div className="s">{cfg?.name} · {cfg?.dry_run ? 'dry-run' : 'LIVE'}</div></div>
        <div className="card"><div className="k">Executor</div><div className="v" style={{ fontSize: 13 }} title={cfg?.arb_contract}>{cfg?.arb_contract?.slice(0, 10)}…{cfg?.arb_contract?.slice(-6)}</div><div className="s">reader {cfg?.state_reader ? `${cfg.state_reader.slice(0, 8)}…` : 'none'}</div></div>
        <div className="card"><div className="k">Endpoints</div><div className="v">{cfg ? cfg.rpc_https_pool.length + cfg.rpc_wss_pool.length : '—'}</div><div className="s">{cfg?.rpc_https_pool.length} HTTPS · {cfg?.rpc_wss_pool.length} WSS</div></div>
        <div className="card"><div className="k">Coverage</div><div className="v">{cfg ? `${cfg.pools.length} pools` : '—'}</div><div className="s">{cfg ? `${Object.keys(cfg.tokens).length} tokens · ${Object.keys(cfg.dexes).length} protocols` : ''}</div></div>
      </div>

      {/* ── Fleet capacity — expansion policy: green ≤50%, review >50%,
          throttle >70%, freeze >85% ── */}
      {capacity && (() => {
        const BAND = {
          green:    { c: 'var(--acc)',  label: 'GREEN — expansion eligible' },
          review:   { c: 'var(--warn)', label: 'REVIEW — >50%, expansion under review' },
          throttle: { c: '#ff9540',     label: 'THROTTLE — >70%, expansion blocked' },
          freeze:   { c: 'var(--neg)',  label: 'FREEZE — >85%, all expansion frozen' },
        }
        const b = BAND[capacity.band] || BAND.green
        const pct = capacity.fleet_capacity_pct * 100
        return (
        <div className="panel">
          <h3>Fleet capacity — expansion policy</h3>
          <div style={{ padding: '8px 12px', marginBottom: 10, borderRadius: 6, fontSize: 13,
            background: 'rgba(255,255,255,.04)', color: b.c, borderLeft: `3px solid ${b.c}` }}>
            {b.label} — fleet at {pct.toFixed(0)}% of theoretical capacity
            {capacity.expansion_eligible
              ? ` · ~${capacity.headroom_chains} chain slot${capacity.headroom_chains === 1 ? '' : 's'} of headroom at current load`
              : ' · new chains/tokens blocked until utilization returns below 50%'}
          </div>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
            <div style={{ flex: 1, height: 14, background: '#12203d', borderRadius: 7, overflow: 'hidden', position: 'relative' }}>
              <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', transition: 'width .4s', background: b.c }} />
              {[(capacity.policy_lines?.green ?? .5), (capacity.policy_lines?.throttle ?? .7), (capacity.policy_lines?.freeze ?? .85)].map(v => v * 100).map(x => (
                <div key={x} style={{ position: 'absolute', left: `${x}%`, top: 0, width: 1, height: '100%', background: 'rgba(255,255,255,.35)' }} />
              ))}
            </div>
            <b style={{ fontSize: 15, color: b.c }}>{pct.toFixed(0)}%</b>
          </div>
          <div style={{ display: 'flex', gap: 24, fontSize: 12.5, color: 'var(--dim)', flexWrap: 'wrap' }}>
            <span>CPU {(capacity.cpu_pct * 100).toFixed(0)}% (load {capacity.load1?.toFixed(2)}/{capacity.cpus} cores)</span>
            <span>MEM {(capacity.mem_pct * 100).toFixed(0)}% ({capacity.mem_used_gb}/{capacity.mem_total_gb} GB)</span>
            <span>Scan util {(capacity.scan_util * 100).toFixed(1)}% of block budget</span>
            <span style={{ color: 'var(--dim)' }}>zones: ≤{(capacity.policy_lines?.green ?? .5) * 100} green · >{(capacity.policy_lines?.green ?? .5) * 100} review · >{(capacity.policy_lines?.throttle ?? .7) * 100} throttle · >{(capacity.policy_lines?.freeze ?? .85) * 100} freeze · from [policy] in chain TOML</span>
          </div>
          {capacity.chains && (
            <table style={{ marginTop: 10 }}>
              <thead><tr><th>Chain</th><th>Scan util</th><th>Avg scan / budget</th><th>Pools</th><th>Tokens</th><th>Hits/M evals (1h)</th><th>Gross (1h)</th><th>Score</th></tr></thead>
              <tbody>
                {Object.entries(capacity.chains).map(([c, m]) => (
                  <tr key={c}>
                    <td>{c.toUpperCase()}</td>
                    <td style={{ color: m.utilization > 0.5 ? 'var(--warn)' : 'var(--acc)' }}>{(m.utilization * 100).toFixed(1)}%</td>
                    <td className="dim">{m.avg_scan_ms.toFixed(0)}ms / {m.block_time_ms}ms</td>
                    <td>{m.pools}</td>
                    <td>{m.tokens}</td>
                    <td>{m.hits_per_m.toFixed(1)}</td>
                    <td>${m.gross_profit_usd.toFixed(4)}</td>
                    <td>{m.score.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {capacity.runners?.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dim)' }}>
              {capacity.runners.map(r => (
                <span key={r.name} style={{ marginRight: 18 }}>{r.name}: {r.cpu.toFixed(0)}%cpu {r.mem_mb}MB</span>
              ))}
            </div>
          )}
        </div>
        )
      })()}

      {/* ── Capacity & health ── */}
      <div className="panel">
        <h3>Capacity & network health {health && <span className="dim" style={{ fontSize: 11 }}>(probed {new Date(health.t).toLocaleTimeString()})</span>}</h3>
        {cap && (
          <div className="grid cards" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 10 }}>
            <div className="card"><div className="k">Avg scan (1h)</div><div className="v">{cap.avg_scan_ms.toFixed(0)}ms</div><div className="s">{cap.scans_last_hour.toLocaleString()} scans</div></div>
            <div className="card"><div className="k">Capacity util.</div><div className={`v ${cap.utilization > 0.5 ? 'neg' : 'pos'}`}>{(cap.utilization * 100).toFixed(1)}%</div><div className="s">of {cap.block_time_ms}ms block budget</div></div>
            <div className="card"><div className="k">Blocks</div><div className="v">{cap.current_block?.toLocaleString()}</div><div className="s">current head</div></div>
            <div className="card"><div className="k">Evals / hits (1h)</div><div className="v">{cap.evals_last_hour.toLocaleString()}</div><div className="s">{cap.hits_last_hour.toLocaleString()} profitable</div></div>
            <div className="card"><div className="k">Endpoint health</div><div className="v">{health.healthy}/{health.endpoints.length}</div><div className="s">{health.degraded} degraded · {health.noisy} noisy · {health.down} down</div></div>
          </div>
        )}
        {health?.endpoints && (
          <table>
            <thead><tr><th>Endpoint</th><th>chainId</th><th>Block</th><th>RTT</th><th>Status</th></tr></thead>
            <tbody>
              {[...health.endpoints].sort((a, b) => (a.ms ?? 9e9) - (b.ms ?? 9e9)).map(e => (
                <tr key={e.url}>
                  <td className="mono" style={{ fontSize: 11 }}>{e.url}</td>
                  <td>{e.chain_id ?? '—'}</td>
                  <td className="mono">{e.block?.toLocaleString() ?? '—'}</td>
                  <td className="mono">{e.ms != null ? `${e.ms}ms` : '—'}</td>
                  <td><span className="tag" style={{ color: STATUS_COLOR[e.status], borderColor: STATUS_COLOR[e.status] }}>{e.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
          Unhealthy endpoints are auto-benched by the runner's 60s circuit breaker — config is never silently edited.
        </div>
      </div>

      {/* ── Token batch optimization — staged admission, 25–50 per chain,
          quarantine zero-hit tokens ── */}
      {capacity?.chains?.[chain] && (() => {
        const m = capacity.chains[chain]
        const ranked = Object.entries(m.token_hits || {}).sort((a, b) => b[1] - a[1])
        const zeroHit = m.zero_hit_tokens || []
        const bmin = m.batch_min ?? 25, bmax = m.batch_max ?? 50
        const batchOk = m.tokens >= bmin && m.tokens <= bmax
        return (
        <div className="panel">
          <h3>Token batch — {chain.toUpperCase()}</h3>
          <div style={{ display: 'flex', gap: 24, fontSize: 12.5, flexWrap: 'wrap', marginBottom: 8 }}>
            <span className="dim">Tokens: <b style={{ color: 'var(--txt)' }}>{m.tokens}</b>
              {' '}<span style={{ color: batchOk ? 'var(--acc)' : 'var(--warn)' }}>
                ({batchOk ? 'within' : m.tokens < bmin ? 'below' : 'above'} {bmin}–{bmax} target batch)</span></span>
            <span className="dim">Earning hits (1h): <b style={{ color: 'var(--acc)' }}>{ranked.length}</b></span>
            <span className="dim">Quarantine candidates: <b style={{ color: zeroHit.length ? 'var(--warn)' : 'var(--acc)' }}>{zeroHit.length}</b> (0 profitable hits)</span>
          </div>
          {ranked.length > 0 && (
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              <span className="dim">Top by hits: </span>
              {ranked.slice(0, 8).map(([sym, n]) => (
                <span key={sym} style={{ marginRight: 14, color: 'var(--txt)' }}>{sym} <b>{n}</b></span>
              ))}
            </div>
          )}
          {zeroHit.length > 0 && (
            <div style={{ fontSize: 12 }}>
              <span className="dim">Zero-hit: </span>
              {zeroHit.map(sym => <span key={sym} style={{ marginRight: 12, color: 'var(--warn)' }}>{sym}</span>)}
              <span className="dim"> — review for removal; rank by net profit per scan capacity, not raw path count</span>
            </div>
          )}
        </div>
        )
      })()}

      {/* ── Tokens & DEXes ── */}
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="panel" style={{ marginTop: 0 }}>
          <h3>Tokens ({cfg ? Object.keys(cfg.tokens).length : 0})</h3>
          <table>
            <thead><tr><th>Symbol</th><th>Address</th><th>Flash</th><th>USD price</th></tr></thead>
            <tbody>
              {cfg && Object.entries(cfg.tokens).map(([s, a]) => (
                <tr key={s}>
                  <td><b>{s}</b></td>
                  <td className="mono" style={{ fontSize: 11 }}>{a.slice(0, 10)}…{a.slice(-4)}</td>
                  <td>{cfg.flash_tokens.includes(s) ? <span className="tag live">flash</span> : '—'}</td>
                  <td className="mono">{cfg.prices[s] != null ? `$${cfg.prices[s]}` : <span className="dim">derived</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel" style={{ marginTop: 0 }}>
          <h3>DEXes & pools ({cfg?.pools.length ?? 0})</h3>
          <div style={{ marginBottom: 8 }}>
            {cfg && Object.entries(cfg.dexes).map(([p, n]) => (
              <span key={p} className="tag" style={{ marginRight: 6 }}>{p} ×{n}</span>
            ))}
          </div>
          <table>
            <thead><tr><th>Pool</th><th>Protocol</th><th>Pair</th><th>Fee</th></tr></thead>
            <tbody>
              {cfg?.pools.map(p => (
                <tr key={p.address}>
                  <td className="mono" style={{ fontSize: 11 }} title={p.address}>{p.name || `${p.address?.slice(0, 8)}…`}</td>
                  <td>{p.protocol}</td>
                  <td>{p.token0}/{p.token1}</td>
                  <td className="mono">{p.fee_bps}bp</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Recommended expansion queue ── ranked from DefiLlama TVL,
          chainid.network, canonical token lists + live probes only ── */}
      {recs && (
        <div className="panel">
          <h3>Recommended expansion queue
            <span className="dim" style={{ fontSize: 11, fontWeight: 400 }}> — admission: {recs.admissible}</span></h3>

          <h4 style={{ margin: '10px 0 4px', color: 'var(--dim)' }}>Next chains (DefiLlama TVL × live RPC probe)</h4>
          <table>
            <thead><tr><th>#</th><th>Chain</th><th>TVL</th><th>RPC health</th><th>Block int.</th><th>Latency</th><th>RPCs</th><th>Score</th><th>Action</th></tr></thead>
            <tbody>{(recs.chains || []).map(r => (
              <tr key={r.id}>
                <td>{r.rank}</td>
                <td><b>{r.name}</b> <span className="dim" style={{ fontSize: 11 }}>#{r.chain_id} {r.native}</span></td>
                <td>${r.tvl_usd >= 1e9 ? (r.tvl_usd / 1e9).toFixed(1) + 'B' : (r.tvl_usd / 1e6).toFixed(0) + 'M'}</td>
                <td style={{ color: r.rpc_health === 'healthy' ? 'var(--acc)' : r.rpc_health === 'degraded' ? 'var(--warn)' : 'var(--neg)' }}>{r.rpc_health}</td>
                <td>{r.block_interval_ms ? r.block_interval_ms + 'ms' : '—'}</td>
                <td>{r.latency_ms ? r.latency_ms + 'ms' : '—'}</td>
                <td>{r.rpc_endpoints}</td>
                <td>{r.score}</td>
                <td>{r.action === 'simulate'
                  ? <button disabled={busy} onClick={() => act(`/api/config/recommendations/${r.id}/promote`,
                      { kind: 'chain', payload: { name: r.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'), chain_id: r.chain_id, rpc_url: r.rpc_url, block_time_ms: r.block_interval_ms } })}>Draft</button>
                  : <span className="dim">{r.action}</span>}</td>
              </tr>))}</tbody>
          </table>

          <h4 style={{ margin: '14px 0 4px', color: 'var(--dim)' }}>Next tokens — {chain.toUpperCase()} (canonical list × on-chain verify × GoPlus)</h4>
          <table>
            <thead><tr><th>#</th><th>Token</th><th>On-chain</th><th>GoPlus</th><th>Priced</th><th>Score</th><th>Action</th></tr></thead>
            <tbody>{(recs.tokens?.[chain] || []).slice(0, 10).map(r => (
              <tr key={r.id}>
                <td>{r.rank}</td>
                <td><b>{r.symbol}</b> <span className="mono dim" style={{ fontSize: 10 }}>{r.address.slice(0, 10)}…</span></td>
                <td style={{ color: r.onchain_ok ? 'var(--acc)' : 'var(--neg)' }}>{r.onchain_ok ? 'verified' : 'failed'}</td>
                <td style={{ color: r.goplus_flags.length ? 'var(--neg)' : 'var(--acc)' }}>{r.goplus_flags.length ? r.goplus_flags.join(',') : 'clean'}</td>
                <td>{r.priced ? '✓' : '—'}</td>
                <td>{r.score}</td>
                <td>{r.action === 'simulate'
                  ? <button disabled={busy} onClick={() => act(`/api/config/recommendations/${r.id}/promote`,
                      { kind: 'token', chain, payload: { symbol: r.symbol, address: r.address } })}>Draft</button>
                  : <span className="dim">{r.action}</span>}</td>
              </tr>))}</tbody>
          </table>

          <h4 style={{ margin: '14px 0 4px', color: 'var(--dim)' }}>Next DEXes — {chain.toUpperCase()} (DefiLlama chain TVL)</h4>
          <table>
            <thead><tr><th>#</th><th>DEX</th><th>TVL on chain</th><th>Audits</th><th>Score</th><th>Action</th></tr></thead>
            <tbody>{(recs.dexes?.[chain] || []).map(r => (
              <tr key={r.id}>
                <td>{r.rank}</td>
                <td><b>{r.name}</b></td>
                <td>${r.tvl_usd >= 1e9 ? (r.tvl_usd / 1e9).toFixed(2) + 'B' : (r.tvl_usd / 1e6).toFixed(1) + 'M'}</td>
                <td>{r.audits || '—'}</td>
                <td>{r.score}</td>
                <td className="dim">{r.action}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}

      {/* ── Expansion drafts ── */}
      <div className="panel">
        <h3>Expansion drafts — add tokens, pools, endpoints</h3>
        <form className="inline" onSubmit={e => { e.preventDefault(); act('/api/config/drafts', { chain: ftype === 'chain' ? (fields.name || 'new') : chain, type: ftype, payload: fields }); setFields({}) }}>
          <select value={ftype} onChange={e => setFtype(e.target.value)}>
            <option value="token">Token</option>
            <option value="pool">DEX pool</option>
            <option value="endpoint">RPC endpoint</option>
            <option value="chain">New chain</option>
          </select>
          {ftype === 'chain' && <>
            <input placeholder="name (e.g. arbitrum)" value={fields.name || ''} onChange={f('name')} style={{ width: 150 }} />
            <input placeholder="chain id" value={fields.chain_id || ''} onChange={f('chain_id')} style={{ width: 90 }} />
            <input placeholder="https://…rpc" value={fields.rpc_url || ''} onChange={f('rpc_url')} style={{ minWidth: 260 }} />
          </>}
          {ftype === 'endpoint' && <input placeholder="https://…" value={fields.url || ''} onChange={f('url')} style={{ minWidth: 320 }} />}
          {ftype === 'token' && <>
            <input placeholder="symbol (e.g. CAKE)" value={fields.symbol || ''} onChange={f('symbol')} />
            <input placeholder="0x…" value={fields.address || ''} onChange={f('address')} style={{ minWidth: 320 }} />
          </>}
          {ftype === 'pool' && <>
            <input placeholder="0x…" value={fields.address || ''} onChange={f('address')} style={{ minWidth: 300 }} />
            <select value={fields.protocol || 'v3'} onChange={f('protocol')}>
              {['v2', 'v3', 'algebra', 'aero', 'pcs', 'dodo', 'wombat'].map(x => <option key={x}>{x}</option>)}
            </select>
            <input placeholder="fee bps" value={fields.fee_bps || ''} onChange={f('fee_bps')} style={{ width: 80 }} />
          </>}
          <button className="primary" disabled={busy}>Create draft</button>
        </form>
        {(drafts || []).length > 0 && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Draft</th><th>Type</th><th>Payload</th><th>Status</th><th>Checks</th><th>Actions</th></tr></thead>
            <tbody>
              {drafts.filter(d => d.type === 'chain' || d.chain === chain).map(d => (
                <tr key={d.id}>
                  <td className="mono" style={{ fontSize: 11 }}>{d.id}</td>
                  <td>{d.type}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{JSON.stringify(d.payload).slice(0, 60)}</td>
                  <td><span className="tag" style={{ color: d.status === 'sim_passed' || d.status === 'applied' ? 'var(--acc)' : d.status === 'rejected' || d.status === 'sim_failed' ? 'var(--neg)' : 'var(--warn)' }}>{d.status}</span></td>
                  <td>{(d.checks || []).map((c, i) => (
                    <div key={i} style={{ fontSize: 11, color: c.ok ? 'var(--acc)' : 'var(--neg)' }}>{c.ok ? '✓' : '✗'} {c.name}{c.detail ? ` — ${c.detail}` : ''}</div>
                  ))}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {d.status === 'draft' || d.status === 'rejected' || d.status === 'validated'
                      ? <button disabled={busy} onClick={() => act(`/api/config/drafts/${d.id}/validate`)}>Validate</button> : null}
                    {d.status === 'validated' || d.status === 'sim_failed'
                      ? <button disabled={busy} onClick={() => act(`/api/config/drafts/${d.id}/simulate`)}>Simulate</button> : null}
                    {d.status === 'sim_passed'
                      ? <button className="primary" disabled={busy} onClick={() => act(`/api/config/drafts/${d.id}/apply`)}>{d.type === 'chain' ? 'Apply (scaffold)' : 'Apply + restart'}</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Audit + engine flags (merged from Settings) ── */}
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="panel" style={{ marginTop: 0 }}>
          <h3>Config audit log</h3>
          {(audit || []).length === 0 ? <div className="dim" style={{ fontSize: 12.5 }}>No config events yet.</div> : (
            <table>
              <thead><tr><th>Time</th><th>Action</th><th>Detail</th></tr></thead>
              <tbody>
                {audit.slice(0, 15).map((a, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ fontSize: 11 }}>{new Date(a.t).toLocaleString()}</td>
                    <td>{a.action}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{JSON.stringify(a.detail).slice(0, 80)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="panel" style={{ marginTop: 0 }}>
          <h3>Console & engine flags</h3>
          <form className="inline">
            <label className="dim">Refresh</label>
            <select value={refreshMs} onChange={e => setRefreshMs(+e.target.value)}>
              {[1000, 2000, 5000, 10000, 15000, 30000].map(ms => <option key={ms} value={ms}>{ms / 1000}s</option>)}
            </select>
            <label className="dim">Currency</label>
            <select value={currency} onChange={e => setCurrency(e.target.value)}>
              {['USD', 'ETH', 'USDT'].map(c => <option key={c}>{c}</option>)}
            </select>
          </form>
          <div className="dim" style={{ margin: '8px 0', fontSize: 12 }}>
            ETH ${prices?.ethereum?.usd ?? '—'} · BNB ${prices?.binancecoin?.usd ?? '—'} · USDT ${prices?.tether?.usd ?? '—'}
          </div>
          <div className="step"><span className="n">MODE</span><div><strong>{all.live ? 'LIVE' : 'DRY-RUN'}</strong> — flip via Deployment → Go live</div></div>
          <div className="step"><span className="n">GATE</span><div>min_net_profit $1.50 floor · max 3 hops · strict_4337 submission</div></div>
          <div className="step"><span className="n">GOV</span><div>No live tx without SIMULATION_VERIFIED + Commander approval (.windsurfrules)</div></div>
        </div>
      </div>
    </div>
  )
}
