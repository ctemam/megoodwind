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
