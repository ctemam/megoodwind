# Senior Engineer Brief — Profit Generation on allbrightA

## Mission
Make the engine generate real, positive P&L. Every candidate currently dies
before submission or would be unprofitable. Find and fix the remaining
structural gaps between "paths evaluated" and "net profit > $0".

## What the system is
Rust workspace (`ctemam/megoodwind`, branch `main`) — multichain flash-loan
arb engine, BSC + Base, gasless execution via ERC-4337 + Pimlico paymaster.
Pipeline: RPC pool → state refresh (Multicall3 / StateReader) → path
enumerator → simulator (V2 reserves, V3 ticks) → sizing optimizer → profit
gate → sponsored UserOp submission.

## Verified current state (live metrics, this box)
- BSC: ~520k path evals/cycle, ~90-100ms avg scan, 28 pools / 8 tokens /
  ~932 paths. Candidates: real but edges of 1-2 bps → `below_safety_margin`
  / `below_min_usd` rejects.
- Base: ~84k evals, 84-225 candidates/12min, avg effective profit ~$0.0002.
- Gate floor recalibrated for sponsorship economics: hard floor $0.25,
  config `min_profit_usd = 0.30`, BSC `min_profit_bps = 3`,
  `safety_margin_bps = 10` (Base: 0/0).
- Profit counters since live: gross $0, net $0, submits 0.
- The pipeline is verified clean end-to-end: state → sim → gate →
  pm_sponsorUserOperation reaches execution simulation with dummy signature.

## Bugs already found and fixed (do not re-litigate)
1. Token-order inversion: 13/28 BSC pools declared token0/token1 flipped vs
   on-chain sorted order → inverted prices → phantom $1.38B edges. Fixed in
   config + boot normalization (`crates/arb-runner/src/runner.rs` ~L468).
2. Gate `implausible` cap: `profit_bps > 100_000` now rejected
   (`crates/arb-sim/src/gate.rs`).
3. Optimizer discards: `find_optimal_amount` converged to a zero-profit
   point and returned nothing; now returns best observed probe.
4. AA23: `pm_sponsorUserOperation` simulates `validateUserOp`; empty sig
   died. Fixed with canonical 65-byte dummy signature
   (`crates/arb-submit/src/pimlico.rs` `dummy_signature()`).
5. Stale deployed StateReader returns 5-field V2State vs Rust 6-field →
   reader marked dead → Multicall3 fallback for all reads (slower but works).
6. Slim Multicall3: static fields (token/fee) from config → ~60% fewer
   calls (`crates/arb-state/src/refresher.rs` `pool_config_fee_raw()`).
7. Stale token prices corrected (BNB 600→769, ETH 2500→2680).

## What we believe the remaining problem is (theories to verify/refute)
A. Latency, not coverage: at free-RPC block-boundary latency (~100-300ms),
   every spread > a few bps is captured by competition inside the same
   block; residual is dust. If true, code can't fix it — need evidence.
B. Sizing/pnl math still wrong somewhere: verify V3 tick-liquidity-aware
   sizing — are we simulating depth correctly, or is effective_bps computed
   on mid-price instead of depth-weighted? Check `crates/arb-sim`.
C. Graph too narrow: 28 pools BSC / 20 Base is thin for triangular arb.
   117 additional live pools were just discovered via factories and are
   being added on this box — do not duplicate; build on top.
D. Missing route surface: Balancer 0%-fee + Aave flash routes are coded but
   inactive until executor redeploy (needs signer gas). Check if
   `crates/arb-sim` already models them; if the engine can't route through
   them, candidates requiring them are invisible.

## Your task
1. Clone `ctemam/megoodwind`, read the pipeline end-to-end (focus:
   `crates/arb-sim`, `crates/arb-state`, `crates/arb-runner`, `crates/arb-scan`).
2. Write a simulation/profiling harness that answers, with numbers: given
   real pool states, where do the best candidates lose profit — spread too
   small, sizing too shallow, depth miscounted, or graph too sparse?
3. Fix whatever is provably wrong in code. Candidate wins: V3 depth-aware
   effective-price math, multi-hop path quality (2-hop only? extend),
   parallel path evaluation, reserve-staleness handling.
4. Open ONE PR to `main` with: the analysis, the measured bottleneck, and
   the code fix. Keep changes minimal and idiomatic; follow existing style.
5. Do NOT touch config values (dry_run, floors, keys), contracts/, or
   runtime infra. Code-level only.

## Constraints
- No invented helpers: reuse crates.io libs and repo utilities.
- Honesty: no mock numbers; every claim backed by a measured number.
- Success = a PR where the diff measurably raises expected profit on real
  state (or proves the bottleneck is external, with the experiment).
