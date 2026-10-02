import React from 'react'
import { useApp } from '../state.jsx'

const STEPS = [
  ['done', 'Engine + PM2 runners', '2 dry-run runners live: allbrightA-bsc (16 pools), allbrightA-base (20 pools)'],
  ['done', 'Multicall3 read batching', 'aggregate3 salvage + deployless V2/V3 mode verified 8/8 pools/block'],
  ['done', 'Safety gates', 'GoPlus token screen + canonical token lists + VenueRouter armed'],
  ['pending', 'Redeploy executors', 'ops/DEPLOY.md — activates Balancer 0% + Aave V3 flash routes (needs deploy gas)'],
  ['pending', 'Sponsor policy', 'set ALLBRIGHTA_SPONSOR_POLICY_ID=sp_… in .env (self-funded fallback active)'],
  ['pending', 'Premium RPC keys', 'gen_rpc_pool.py --alchemy-key/--nodereal-key/… --write → 200+ node pool'],
  ['pending', 'Go live', 'SIMULATION_VERIFIED + LIVE_COMMANDER_APPROVED=true + dry_run=false'],
]

export default function Deployment() {
  const { all } = useApp()
  const chains = all.chains || {}
  return (
    <div className="grid">
      <div className="grid cards">
        {['bsc', 'base'].map(c => (
          <div className="card" key={c}>
            <div className="k">{c.toUpperCase()} deployment</div>
            <div className="v" style={{ fontSize: 16 }}>{chains[c] ? 'Runner online' : 'Runner offline'}</div>
            <div className="s">{chains[c] ? `block ${chains[c].arb_current_block?.toLocaleString()} · ${chains[c].arb_pool_count} pools · ${all.live ? 'live' : 'dry-run'}` : 'check pm2'}</div>
          </div>
        ))}
      </div>
      <div className="panel">
        <h3>Production readiness checklist</h3>
        {STEPS.map(([s, t, d], i) => (
          <div className="step" key={i}>
            <span className="n">{s === 'done' ? '✓' : '○'}</span>
            <div><strong>{t}</strong><div className="dim" style={{ fontSize: 12 }}>{d}</div></div>
          </div>
        ))}
      </div>
    </div>
  )
}
