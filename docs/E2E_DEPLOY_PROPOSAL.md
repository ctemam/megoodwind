# End-to-end deployment proposal — allbright arb + wallet intelligence

Date: 2026-10-04. Status: proposal — nothing executed.

## The pipeline as it exists in code (verified)

```
[1] DISCOVERY
    ├── Pool scan: config TOML pools → PoolStore (DashMap),
    │   refreshed every block via StateReader/Multicall3
    ├── Mempool watch: WSS pending-tx feed → PendingSwap
    │   {raw_tx, decoded router swap} → backrun lane
    └── Leader intel: leader_scan (off-line) + LeaderObserver
        (in-runner, writes data/leaders/<chain>/*.jsonl,
        observe-only)
              │
              ▼
[2] EVALUATION (parallel — this session's work)
    ├── evaluate_all: rayon par_iter over all paths (~200ns each)
    ├── screen → top-20 eval sweep → candidate optimize
    │   (ternary find_optimal_amount), all par_iter
    └── ProfitGate.should_submit: net-of-gas USD decision,
        label metrics per rejection
              │
              ▼
[3] EXECUTION
    ├── PresignPool.build_fast: pre-signed executor calldata,
    │   nonce via Endpoint::bump_nonce (Mutex)
    ├── Probe: eth_call sim before submitting
    └── Router.submit_all → venues:
        strict_4337=true: Pimlico sponsored UserOps
        (BSC/ETH/Polygon executor OWNER = smart acct
        0x18ED4911…8d9d8d2)
        strict_4337=false: [victim, ours] ordered bundles to
        Puissant/BlockRazor/JetBldr/NodeReal + flash loan
              │
              ▼
[4] SETTLEMENT
    settle_tx → receipt (eth_getUserOperationReceipt for
    UserOps, eth_getTransactionReceipt otherwise) →
    ERC-20 flow parsing → realized_usd →
    arb_settlements_total + _settlements.jsonl +
    StrategyRegistry.mark_settled (feedback into scoring)
```

Every stage exists in code and is exercised. [repo evidence]

## Deploy readiness — what exists vs what blocks E2E

| Item | BSC | Ethereum | Polygon | Base |
|---|---|---|---|---|
| Executor contract | ✅ `0x279b1b7e` (env) | ✅ `0x70DD16A8` | ✅ `0xe4286046` | ❌ env var only |
| dry_run=false committed | ✅ | ✅ | ✅ | ❌ (true, correct) |
| strict_4337 path | ✅ | ✅ | ✅ | config ready |
| StateReader freshness | ⚠️ stale (Multicall3 fallback ~0.57s) | ⚠️ fallback ~1.3s | ⚠️ fallback ~1.3s | — |
| Public mempool | ✅ | ✅ | ✅ | ❌ private sequencer |
| PRIVATE_KEY secret | required | required | required | — |
| PIMLICO_API_KEY | required | required | required | — |

[repo evidence + config values]

## The three tracks inside "wallet copy / intelligence"

1. **Leader observation (deployed, observe-only)** — `[leaders]` registry
   watches registered wallets' pending swaps, writes JSONL, feeds the
   dashboard Wallet-attribution tab. No execution.
2. **Shadow/paper replay** — `arb-leaders` has observe → replay → shadow →
   bounded_live states and `sim_verified` flags; the runner records
   shadow attempts/positives but **never executes a leader copy** —
   bounded_live is a state label only.
3. **A real copy lane does not exist** — matching `tx.from` to a watchlist
   + copy sizing + positions + exits is the gap list from
   `docs/research/2026-10-04-wallet-copying-vs-allbright.md`.

So "end-to-end deploy" today means: **arb + backrun lanes live on BSC,
ETH, Polygon; wallet intelligence in observe→shadow.** [repo evidence]

## Pre-flight checklist for 100% confidence

Blockers that must be cleared before any live run:

1. **Secrets** (hard stop): `PRIVATE_KEY`, `PIMLICO_API_KEY`,
   `BSC_ARB_CONTRACT` — env-expansion requires them in the process env;
   repo-scoped secrets on the new box, `.env` for the dashboard.
   [verified — config.rs expand_env_vars]
2. **Fleet state**: runner processes for bsc/eth/polygon (PM2
   `arb-runner` × 3 + dashboard :9200), each with the right TOML.
3. **Executor funding check**: gasless UserOps need Pimlico account
   balance; warp budget `warp_budget_usd=5.0` caps BSC spend.
   [repo evidence]
4. **StateReader staleness**: live on BSC but stale on ETH/Polygon —
   Multicall3 fallback works but costs ~1.3s/block of RPC. Acceptable
   for measure; for live profit it's the known #1 latency drag.
   [verified — memory + config comments]
5. **Verification run**: `latency_profile` + `statecheck` bins produce
   real per-chain measurements before go-live; `verify4337` assembles a
   real UserOp without broadcasting — all three exist and were used
   before. [repo evidence]
6. **Monitoring**: `/metrics` on 9100/9102/9103 + dashboard + the
   hourly ping automation — exists. [verified]

## Proposed rollout (no execution yet)

- **Phase A — verify** (no secrets): build release bin, run
  latency_profile + statecheck on all 3 chains, confirm metrics pages.
- **Phase B — secrets**: request `PRIVATE_KEY` + `PIMLICO_API_KEY` +
  `BSC_ARB_CONTRACT` (repo-scoped).
- **Phase C — fleet**: PM2 runners bsc/eth/polygon (dry_run=false
  already committed) + dashboard; verify metrics, gate counters, and
  the Strategies/Opportunities pages populate.
- **Phase D — validate live**: `verify4337` per chain, watch first
  submissions through settle, confirm `arb_settlements_total` and
  realized P&L land.
- **Phase E — wallet copy build-out** (separate effort): watchlist
  match + token gate + copy sizer + positions + exits — the 30% gap.

## Open decision for Commander

- **Deploy scope**: BSC+ETH+Polygon live-execution now (arb+backrun),
  wallet copy stays shadow-only? Or gate everything on the copy lane
  being built first? Recommendation: live the existing lanes — the copy
  lane is weeks of work and shouldn't block already-deployed
  executors.
