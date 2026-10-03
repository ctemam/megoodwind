# Agent / Architecture Specification — allbrightA

This document describes the **implemented** system. It replaces the previous
version of this file, which contained a pasted single-file prototype
(`src/main.rs`, ethers-rs, mock RPC URLs, sub-5µs static-array targets). That
prototype was never the shipped architecture; where this file and the code
disagree, the code wins and this file must be corrected.

## System shape

```text
mempool ingestion          block stream
    │                          │
    ▼                          ▼
┌──────────────┐      ┌─────────────────┐
│ arb-mempool  │      │  arb-state      │
│ watcher      │      │  pool store +   │
│ (WSS pending │      │  refresher      │
│  tx stream)  │      │  (RPC reads)    │
└──────┬───────┘      └────────┬────────┘
       │ pending swaps         │ pool states
       ▼                       ▼
        ┌──────────────────────────┐
        │ arb-runner               │
        │ path enumeration →       │
        │ impact projection →      │
        │ arb-sim quote/optimize → │
        │ profit gate → exec probe │
        └───────────┬──────────────┘
                    │ bundles/UserOps
                    ▼
        ┌──────────────────────────┐
        │ arb-submit               │
        │ venue router: builders + │
        │ Pimlico ERC-4337 bundler │
        └──────────────────────────┘

Side pipeline (never on the execution path):
pending stream → arb-leaders observer → bounded queue → async writer
→ data/leaders/<chain>/{wallet,_scanned,_strategies,_pools,_tokens}
→ dashboard /api/wallet-intelligence
```

## Crate map

| crate | responsibility |
|---|---|
| `arb-core` | AMM math kernels (V2, V3 ticks, stable, DODO/Wombat), path types |
| `arb-rpc` | endpoint pooling, rotation, health, failover |
| `arb-state` | pool state store (DashMap), multicall refresh, staleness timestamps |
| `arb-mempool` | WSS watcher, swap decode, post-swap impact projection, quarantine |
| `arb-sim` | `evaluate_all`, `simulate_profit`, `find_optimal_amount` (ternary) |
| `arb-submit` | venue router (BlockRazor/NodeReal/JetBldr/Puissant/Warp/Pimlico), presign pool |
| `arb-leaders` | wallet-intel observer, async writer, strategy registry, lifecycle |
| `arb-runner` | orchestration: scan loop, gates, exec probe, metrics; plus bins (`leader_scan`, `leader_profile`, `statecheck`, `profit_profile`, `pathdump`) |
| `apps/dashboard` | read-only ops UI + `/api/*` aggregation |

## Invariants

### Latency (measured targets, not aspirational)

- Wallet intelligence runs **off** the execution path: the observer enqueues
  via bounded `try_send` (cap 2048); a dedicated writer thread persists.
  Under queue pressure the job is dropped + counted, never the trade.
- Budgets (Phase-1): observer enqueue p50 <100µs, p95 <500µs, p99 <2ms —
  measured via `arb_leader_observe_seconds`; race window via
  `arb_pending_to_eval_seconds` / `arb_pending_to_submit_seconds`.
- Queue blocking on the execution path: **zero** by construction (sync
  channel + try_send only).

### Accounting (canonical)

```text
net P&L = gross profit − warp/trader spend − gas
```

Single definition across runner counters, `/api/metrics/canonical`, and all
dashboard pages. Gross, simulated, projected and realized values must be
labeled separately — `[measured]` / `[projection]` / `[assumption]`.

### Strategy lifecycle (internalization)

```text
observe →(evidence: net≥$50, txs≥2, win≥50%)→ replay
       →(route coverage = 100%)→ shadow
       →(production simulator reproduces positive profit)→ bounded_live
                                                             (auto, ≤$25 cap)
       →(unseen 20k blocks)→ expired
```

No code path reaches `bounded_live` without sim verification; promotion is
backend-governed — the dashboard can never enable live copying. Discovery
data flows only into the registry artifact
(`data/leaders/<chain>/_strategies.jsonl`), never directly into submission.

### Adversarial security

- Pool provenance gate: V2 imports require `totalSupply>0` + `factory()≠0`;
  V3 require `factory()≠0` + `liquidity()` depth — sham contracts that fake
  `getReserves`/`token0` cannot enter the config (see the 0x306cD1b6 bait
  incident, commit `b4700ad`).
- Outlier quarantine: pools diverging >3× from ≥3 same-pair peers are
  excluded from candidate paths each refresh.
- Behavioral defense: pools repeatedly present in gate-pass→revert paths are
  suppressed (`arb_bait_suspect_total`); victims >$100M or profit > victim
  input are dropped as unverifiable.
- Exec probe simulates against live chain state before any submission;
  `InsufficientProfit` reverts never reach a venue.

### Distributed-state correctness

- Stale-pool suppression: candidate paths with pool updates older than 90s
  are dropped (`arb_stale_suppressed_total`).
- State refreshes stamp per-pool `updated_at`; impact projection preserves
  source timestamps into the projected store.

## Verification and rollback

Rollback triggers (Phase-4): p95 latency over budget, landed success rate
drop, revert-rate increase, net P&L per opportunity decrease, observation
queue drops, stale strategy evidence. A change is only "successful" with a
same-chain baseline-vs-treatment comparison — never from a single short run.

## Required response structure for Commander directives

1. Research findings → 2. Repository impact → 3. Recommended decision →
4. Implementation plan → 5. Verification and rollback.

(Filed research lives under `docs/research/`; source registry:
`docs/research/SOURCES.md`.)
