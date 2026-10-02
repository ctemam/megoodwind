import React from 'react'
import { useApp } from '../state.jsx'

function pct(m, le) {
  const under = m[`arb_scan_latency_seconds_bucket{le="${le}"}`] ?? 0
  const count = m['arb_scan_latency_seconds_count'] ?? 1
  return ((under / count) * 100).toFixed(1)
}

export default function Infra() {
  const { all } = useApp()
  const chains = all.chains || {}
  return (
    <div className="grid">
      <div className="panel" style={{ marginTop: 0 }}>
        <h3>Per-chain scan latency (Prometheus histogram)</h3>
        <table>
          <thead><tr><th>Chain</th><th>Block lag</th><th>Pools</th><th>≤100ms</th><th>≤500ms</th><th>≤1s</th><th>Scans</th></tr></thead>
          <tbody>
            {['bsc', 'base'].map(c => {
              const m = chains[c]
              return (
                <tr key={c}>
                  <td>{c.toUpperCase()}</td>
                  <td>{m ? `block ${m.arb_current_block?.toLocaleString()}` : '—'}</td>
                  <td>{m?.arb_pool_count ?? '—'}</td>
                  <td>{m ? `${pct(m, '0.1')}%` : '—'}</td>
                  <td>{m ? `${pct(m, '0.5')}%` : '—'}</td>
                  <td>{m ? `${pct(m, '1')}%` : '—'}</td>
                  <td className="mono">{m?.arb_scan_latency_seconds_count?.toLocaleString() ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h3>Infrastructure notes</h3>
        <div className="step"><span className="n">RPC</span><div>32 BSC / 17 Base verified read nodes, 60s blacklist failover; premium keys via <code>gen_rpc_pool.py --alchemy-key …</code></div></div>
        <div className="step"><span className="n">WSS</span><div>BSC mempool p50 2µs / p99 4µs (publicnode); Base via onfinality — sole free emitter found</div></div>
        <div className="step"><span className="n">MC3</span><div>Multicall3 salvage: 8/8 pools per block in one round-trip; deployless mode covers V2/V3</div></div>
        <div className="step"><span className="n">VNU</span><div>VenueRouter: EMA-ordered submits, 60s bench on 3 misses; per-chain budgets 8/400ms BSC, 250/1600ms Base</div></div>
      </div>
    </div>
  )
}
