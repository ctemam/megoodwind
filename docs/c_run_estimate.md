# C_run — daily operating-cost estimate (D3, measured where possible)

## Measured inputs

| Component | Measured value | Source |
|---|---|---|
| shadow active window (eth) | 57.8 h, 762k signal rows | `data/monitor/eth_signals.jsonl` |
| cycle cadence | ~8–17 s per chain per cycle | `lastStageMs` sampler (WO-1b) |
| requests per cycle/chain | ~10–20 JSON-RPC calls | blockNumber + baseFee + prioFee + L1-fee + discovery scan + ONE Multicall3 aggregate3 refresh + gas probe |
| request rate (6 chains) | ≈ 450 req/min ≈ **650k req/day** | above × 6 chains |
| documented free-tier capacity | ~7.2M req/day across 6 accounts | AGENTS.md provider inventory (measured 2026-10-20) |
| **RPC cost** | **$0/day** at current load | headroom ~11× — even 5× shadow cadence stays free |
| paid RPC trigger (WO-16) | **no spend** — measured, not assumed | `data/rpc_upgrade_recommendation.json` |

## Deployment / infra

| Component | Estimate | Notes |
|---|---|---|
| executor redeploy (per chain) | ~1.8–2.0M gas | measured contract ~9KB bytecode |
| at 30 gwei eth | ≈ 0.054 ETH ≈ **$130 one-time** | eth only; L2 deploys ~$2–10 |
| compute | local box | electricity ~$0.20–0.40/day — de minimis |
| VPS (if moved off local) | ~$10–20/mo | not currently incurred |
| RPC paid tier | **$0** | WO-16 trigger unmet |

## The honest C_run number

| Item | $/day |
|---|---|
| RPC (free tier) | 0.00 |
| Deployment (amortized 90d, one chain) | ~1.45 |
| Compute | ~0.30 |
| **C_run measured** | **~$1.75/day** |

## What this does NOT include (Commander input needed)

- **Operator time** — the dominant real cost of any trading system at
  this scale. Even 15 min/day at $30/h = $7.50/day, exceeding all
  infra combined. WO-8.6's $33–61/day counterfactual covers infra
  comfortably; whether it covers operator time is **your call, not mine**.
- Revert gas losses — currently $0/day (no live txs), but a live lane
  with Gate-B-failing revert rates adds real spend.

## Verdict impact

At C_run ≈ $1.75/day + operator time: the WO-8.6 counterfactual
($33–61/day best-case) is positive on infra alone IF it materializes —
but Gate A measured 0/3, so the counterfactual remains **unverified
optimism**, not a business case. The honest statement: *the machine's
marginal cost of staying shadowed is ~$1.75/day; the marginal cost of
arming is that plus revert gas + operator attention.*
