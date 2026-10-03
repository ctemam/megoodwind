# Skill Matrix — allbrightA (current architecture)

This file is the lead-architect skill matrix for the *implemented* system —
the multi-crate Alloy/Tokio engine under `crates/`, not the single-file
prototype previously described here. Review cadence: refresh after any
architecture change; label sources per the governance rules below.

## Lead-architect capability requirements

| capability | depth | reason |
|---|---|---|
| EVM execution and transaction ordering | Expert | nonce, receipts, reorgs, gas, private orderflow, inclusion |
| MEV/searcher architecture | Expert | backruns, bundles, builder simulation, private channels, competition |
| AMM mathematics | Expert | V2 reserves, V3 ticks/liquidity, fee tiers, stable pools, DODO, Curve/Wombat |
| Rust performance | Expert | allocation control, profiling, cache behavior, lock contention, latency budgets |
| Tokio/concurrency | Expert | non-blocking channels, backpressure, cancellation, bounded workers, failover |
| RPC/node operations | Expert | WSS ingestion, HTTP reads, rate limits, endpoint disagreement, block consistency |
| Solidity/EVM security | Expert | approvals, callbacks, token taxes, honeypots, reentrancy, access control |
| Private submission systems | Strong | venue routing, builder rejection, replacement, signing, inclusion measurement |
| Quantitative research | Strong | P&L attribution, confidence, sample size, counter resets, experiment design |
| Data engineering | Strong | cursors, replay datasets, schema versions, retention, reproducibility |
| SRE/observability | Strong | Prometheus semantics, histograms, alerting, PM2, rollback, incident response |
| Product/dashboard contracts | Strong | one canonical metric definition across API, UI and runner |
| Governance/risk | Expert | promotion gates, notional limits, expiry, kill switches, auditability |

## Skill → subsystem → sources matrix

| core skill | subsystem impact | authoritative sources (status) |
|---|---|---|
| EVM execution & ordering | `arb-runner` block loop, nonce/finality | Ethereum Yellow Paper `[recommended]` · Ethereum JSON-RPC spec `[recommended]` · EIP-1559 `[recommended]` |
| Account abstraction | `arb-submit` Pimlico/UserOp venue | EIP-4337 `[verified — deployed gaslessly via UserOp]` · Pimlico docs `[verified — working sponsored UserOps]` |
| AMM math | `arb-core` quote kernels, `arb-sim` | Uniswap V2 protocol overview `[verified]` · Uniswap V3 concentrated liquidity + IUniswapV3PoolState `[verified]` · DODO flash-loan docs `[recommended]` · Balancer flash-loan docs `[recommended]` |
| Low-latency Rust | `arb-sim` hot loops, `arb-state` DashMap store | Rust Performance Book `[recommended]` |
| Tokio/concurrency | `arb-mempool` WSS watcher, `arb-runner` pipelines, `arb-leaders` async writer | Tokio tutorial `[verified — bounded channels + try_send implemented]` |
| RPC operations | `arb-rpc` endpoint pool, `arb-state` refresher | Ethereum JSON-RPC `[verified]` |
| Solidity/EVM security | `contracts/` BscFlashArb, provenance gate | Solidity security considerations `[recommended]` |
| MEV architecture | `arb-submit` venue router, bundle construction | Flashbots docs `[recommended]` · Flashbots research `[recommended]` · Flash Boys 2.0 (arXiv:1904.05234) `[recommended]` |
| Observability | `arb-runner` Prometheus surface, dashboard | Prometheus metric types `[verified]` · Prometheus naming practices `[verified]` |
| Process ops | PM2 deployment, log rotation | PM2 quick-start `[recommended]` |

Source status labels (per governance): `[verified]` = read and applied in
this repository with repo evidence; `[recommended]` = authoritative source
queued for review; `[assumption]`/`[unknown]` must never describe production
behavior. URLs are tracked in `docs/research/SOURCES.md` with review dates.

## Multi-chain Wallet Intelligence Expansion

Wallet intelligence is a **chain-portable subsystem**, not a BSC-specific
feature. Discovery, attribution, replay, shadow and promotion share one
schema while allowing chain-specific ingestion, finality, AMM, RPC and
submission behavior.

### Required lead-architect capabilities

| capability | requirement |
|---|---|
| Chain topology analysis | Public/private mempool availability, sequencer behavior, builder markets, finality and reorg risk per chain |
| Chain-specific ingestion | WSS/pending-transaction adapters where available; mined-block receipt scanning where private orderflow dominates |
| Multi-chain attribution | Normalize wallet, transaction, receipt, token-transfer and gas attribution into one chain-tagged schema |
| Chain-specific P&L | Correct native gas conversion for BNB/ETH/MATIC/AVAX; distinguish realized P&L from inventory movement |
| DEX/protocol adapters | Chain-specific Uniswap forks, Algebra/Aero, PancakeSwap, Curve, Balancer, DODO without contaminating generic math |
| RPC capacity planning | Per-chain HTTPS/WSS pools, rate limits, block rates, historical-replay availability, endpoint health |
| Finality and reorg handling | Chain-specific confirmation depth; invalidate observations/replay results after reorgs |
| Private-orderflow research | Identify builder, relay, sequencer and private RPC channels per chain |
| Cross-chain clustering | Detect shared operators via executor bytecode, route geometry, timing, funding and beneficiary patterns |
| Independent rollout control | Discovery enabled per chain; a weak/private-only chain must not reduce BSC execution latency |
| Chain-aware strategy expiry | Strategies expire per chain — a route can stay profitable on one chain after dying on another |
| Cross-chain dashboard contracts | Chain, block, timestamp, source tier, confidence and freshness on every intelligence metric |

### Required architecture

```text
ChainAdapter
├── chain_id
├── native_symbol
├── block_time
├── finality_policy
├── mempool_visibility
├── receipt_source
├── rpc_budget
├── gas_price_source
├── venue_adapters
├── pool_protocol_adapters
└── private_orderflow_adapters
```

operating on normalized records:

```text
NormalizedObservation {
    chain_id, block_number, block_hash, tx_hash, wallet,
    executor_family, strategy_class, route, pools, token_flows,
    gas_native, gas_usd, realized_pnl_usd,
    source_visibility, finality_status
}
```

### Expansion rollout

- **Stage 1 — Discovery-only:** verify chain ID and native token; verify
  block/receipt APIs; measure block interval and finality; classify mempool
  visibility; configure read/WSS budgets; scan mined blocks; write
  chain-partitioned leader data; **do not execute**.
- **Stage 2 — Replay:** requires receipt completeness, token decimals and
  transfer attribution, gas-price conversion, historical state at the
  correct block, reorg/finality checks, minimum sample size.
- **Stage 3 — Shadow:** compare leader realized P&L vs Allbright simulated
  P&L; track route coverage, pool-state agreement, expected profit,
  slippage, gas, submission venue, private-orderflow visibility, shadow
  precision.
- **Stage 4 — Bounded live:** only when shadow precision meets the chain
  threshold, the submission venue is proven, signer/nonce handling is
  chain-safe, daily notional and loss caps are configured, revert and bait
  breakers are active, and rollback has been tested.

### Chain capability matrix

| chain type | intelligence source | primary challenge | rollout policy |
|---|---|---|---|
| Public mempool EVM | WSS pending + mined receipts | latency and builder competition | discovery → shadow → bounded backrun |
| Private-builder-heavy EVM | mined receipts + builder/relay data | pre-inclusion invisibility | outcome discovery → replay → private venue |
| Sequencer chain | receipts, sequencer feeds where available | no conventional public mempool | resting-state/replay only unless an approved orderflow source exists |
| Reorg-prone/low-finality | receipts + confirmation tracking | attribution reversal | delay promotion until finality |
| Cross-chain operator | per-chain observations + executor clustering | identity/strategy correlation | share research, never share unsafe execution assumptions |

### Per-chain intelligence metrics

Every intelligence metric carries `{chain}` plus measurement timestamp,
source block, freshness, and measured/projected/simulated status:

```text
leader_discovered_total{chain}          leader_replay_positive_total{chain}
leader_observed_total{chain}            leader_shadow_attempts_total{chain}
leader_replay_attempts_total{chain}     leader_shadow_positive_total{chain}
leader_shadow_precision{chain}          leader_route_coverage{chain}
leader_net_pnl_usd{chain}               leader_gas_usd{chain}
leader_reorg_invalidations_total{chain} leader_data_stale{chain}
leader_strategy_expired_total{chain}    leader_queue_dropped_total{chain}
```

Emitted today (`arb_leader_*` prefix): `discovered`, `pending` (observed),
`shadow_attempts`, `shadow_positive`, `strategy_expired`, `queue_dropped`,
`route coverage` via strategy records, `evicted`, `write_errors`. The rest
are registered as the replay/reorg/finality emit points land.

### Expansion safety rules

- A chain must not inherit another chain's thresholds automatically.
- BSC intelligence must not block BSC execution while another chain scans.
- A chain with no pre-inclusion orderflow must not be labeled "backrun-ready".
- Cross-chain wallet clustering is evidence, not permission to copy.
- Strategies expire independently per chain.
- Pool imports must pass chain-specific provenance and liquidity checks.
- RPC/data budget exhaustion fails closed for execution but never stops
  other chains.
- Dashboard totals must not combine chains with different observation
  windows without showing window and timestamp.

### Verification requirements before a chain enters production intelligence

1. Minimum multi-hour mined-block discovery window.
2. Receipts reconciled against ≥2 RPC sources.
3. Reorg/finality behavior measured.
4. Native gas and token decimals validated.
5. Labeled sample replayed manually.
6. Leader P&L vs Allbright shadow P&L compared.
7. No latency regression on already-live chains.
8. Dashboard chain totals and timestamps verified.
9. Chain-specific kill switch and rollback tested.
10. Chain stays discovery-only until all evidence is recorded.

## Deployment Governance Report (both modes)

The master wallet-intelligence report is a **required deployment gate** for
conventional arbitrage and wallet-intelligence modes alike. No chain, executor,
or strategy enters or stays live without a current report.

Report contents (per chain):
- Master wallet-intelligence table: pools, paths, wallets tracked, strategy
  lifecycle counts (observe/replay/shadow/bounded_live/expired), route
  coverage, leader net P&L in the scan window (measured, after gas).
- Sim-vs-live funnel: paths evaluated, profitable found, gross EV, gate pass,
  submits, landed, realized net P&L — simulation metrics beside live metrics.
- Profit projection: leader ceiling/day [projected] vs engine gross and net
  /day [projected], with the dominant capture gap named.

Gate rules:
1. Sim-mandatory — a strategy/chain must show positive simulated profit through
   the production simulator on live state before execution; no code path may
   skip it.
2. Wallet-intelligence promotion additionally requires 100% route-pool
   coverage (replay → shadow) before bounded_live under the ≤$25 cap.
3. The report is regenerated at every deployment review; Commander compares
   sim projection vs realized live P&L. Persistent divergence (sim verifies,
   live earns nothing) triggers a review of coverage, latency, and gas floor
   assumptions — not a lowering of the gates.

## Continuous Research and Skill Maintenance

Every agent task keeps skills at industry cutting edge: before executing a
Commander command, perform rapid research on industry practice for the subject.

Source quality order:

1. Standards and specifications (EIPs, ERCs, protocol specs).
2. Official vendor/project documentation (alloy, Pimlico, builder APIs).
3. Primary technical papers and reference implementations.
4. Reputable engineering references (official books, maintained guides).
5. Secondary commentary — only when clearly labeled as such.

Rules:

- A reusable practice, changed standard, or implementation lesson MUST be
  recorded in the relevant skill row or knowledge file.
- Findings must label themselves: [verified], [repo evidence], [assumption],
  [unknown].
- Substantial research results are filed under `docs/research/YYYY-MM-DD-<topic>.md`
  with sources, findings, decision, implementation impact, and verification.
- Never record a practice as industry-standard without a checked source.

## Commander Directive: Rapid Industry Research Before Action

Whenever the Commander issues a command, the responsible agent or lead
architect MUST perform a concise, professional rapid-research pass before
answering or executing.

The research pass MUST:

- Identify current industry-standard practices relevant to the command.
- Prefer authoritative sources: official standards, vendor documentation,
  primary technical papers, and maintained project documentation.
- Distinguish verified facts, repository evidence, assumptions, and unknowns.
- Identify applicable risks, constraints, and alternatives.
- Produce concise bullet-point findings before proposing execution.
- Update the relevant skills/knowledge documentation when the research reveals
  a reusable practice, changed standard, or implementation lesson.
- Avoid delaying urgent safety, incident-response, or rollback actions; in those
  cases, stabilize first and research immediately afterward.
- Never claim research was performed when sources were not checked.

Required response structure:

1. **Research findings**
2. **Repository impact**
3. **Recommended decision**
4. **Implementation plan**
5. **Verification and rollback**

External research is required wherever it can affect architecture, security,
production operations, financial risk, compliance, or a new technology choice;
routine commands need only a repository-evidence pass.

## Historical note

This file previously described a single-file `src/main.rs` prototype
(ethers-rs, mock RPC, sub-5µs static-array claims). That prototype does not
exist in this repository — the production engine is the workspace under
`crates/` described in `docs/AGENTS_SPEC.md`. Prototype-era constants
(`TARGET_MATH_LATENCY_MICROS = 5`, `RPC_MAX_LATENCY_MS = 10`) were aspirational
and are superseded by the measured latency budgets in AGENTS_SPEC §Invariants.
