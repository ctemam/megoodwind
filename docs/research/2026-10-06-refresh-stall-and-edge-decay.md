# Refresh stall root cause + edge-decay frontier (BSC, live-measured)

Date: 2026-10-06 · Branch: `devin/1791013932-backrun-projection` · Commit: `fad5f30`

## Question

Every BSC block logged `V2 chunk read timed out (2200ms)`, `readAlgebra chunk
timed out`, rotating `blacklisted for 60s` on ALL ~23 read endpoints, and
`Exceeded budget … budget_ms=800` — while wire tests showed every endpoint
fast. What actually stalls the refresh, and does fixing it unlock profit?

## Findings

1. [verified] **Root cause of the stall: per-endpoint governor cap of 1 req/s.**
   `arb-rpc` `retry_http_provider` stacks `ThrottleLayer::new(N)` where
   `RATE_LIMIT_REQS_PER_5S = 5` → alloy `Quota::per_second(1), allow_burst(1)`.
   Any burst >1 concurrent call on an endpoint queued >2200ms → timeout →
   blacklist → pool shrinks → deeper queues → every chunk times out every
   block (blacklist storm). Commit `c758fbd` added it to stop 429s.
   [repo evidence] `endpoint.rs`; alloy 1.8.3 `tower::limit::RateLimit`.
   Fix: `RATE_LIMIT_PER_SEC = 15` (measured headroom: 20-way concurrent +
   3r/s sustained per endpoint ~0.25s p50, zero 429s).
   Result: timeouts stopped; `scans_delta` ~25k/min → ~165k/min.

2. [verified] **Transport was always healthy** — `readV2(68 pools)` ≈
   65–100ms p50 on every endpoint (latency_bench), standalone `statecheck`
   refreshes 205 pools in ~300ms, `arb_reader_rpc_seconds` shows all calls
   <0.4s. The stall was in-process governor queueing only.

3. [verified] **With refresh fixed, the funnel finally produced real
   submissions — and revealed the next blocker: edge decay.**
   In ~15 min: 30 backrun candidates passed the profit gate
   (effective_usd $0.6–$9.3). ALL 30 logged `edge gone on re-check` at
   victim_age 70–180ms. Three still reached Pimlico: all rejected
   `sponsorship exec_revert` — selector `0x4e88422a` = `InsufficientProfit`
   (gross < required) at bundler simulation time.
   → Post-victim edges on BSC majors persist < ~200ms. A next-block UserOp
   cannot win that race: the window where chain state = post-victim-with-edge
   does not exist for a tx that lands ≥1 block later. In-block backrunners
   (builder bundles) capture these within the victim's own block.

4. [verified] **Same-block backrunning is structurally unreachable under
   current constraints**: `strict_4337` executor `OWNER` = Pimlico SA —
   bundle venues need a signed tx; the SA path needs a sponsored op whose
   paymaster simulation runs pre-victim and rejects (exactly the
   `exec_revert` observed); SA EP deposit = 0, EOA balance = 0.
   The non-4337 bundle machinery exists (`victim_tx` + puissant/
   blockrazor/jetbldr/nodereal submitters, all configured) but requires an
   executor whose OWNER is an EOA plus gas float. [assumption] ~$5–20 BNB
   seed would unblock the designed-but-disabled same-block path.

5. [verified] **False bait convictions**: decay reverts
   (`insufficient_profit`) struck pools via `record_revert_for_path`, and
   `>BAIT_GAP_BPS` rejected paths convicted every hop — 48 pools benched on
   BSC including PCS V2 USDT/WBNB `0x16b9a828` (~$60M, deepest tracked),
   PCS V3 USDC/USDT `0xf304a4c6`, `0x3d7c3190`. Fixed:
   `revert_blames_pool` gates strikes; ceiling rejects convict only
   quarantined pair-outliers (`flag_bait_pools_in`); dry-run preview uses
   the same classifier; `exec_revert_streak→executor_broken` ignores
   insufficient_profit (3-consecutive-reject mute was armed).
   48 soft-flagged BSC pools + 5 on ETH rehabilitated in `_bait_pools.json`;
   hard (`pool_revert`, ~30M-block) convictions kept.

6. [verified] Cyclic (non-victim) space measured empty today: ~165k
   scans/min find zero profitable paths; 40×/2min live sampling of the
   canonical USDT/WBNB V2↔V3 spread stayed 6.4–13.1bps vs ~26bps
   fee-breakeven.

## Impact

The engine now detects ~2 gate-worthy edges/min on BSC but cannot capture
them gaslessly. Two remaining capture channels within standing orders:
(a) cyclic/persistent dislocations on unraced pairs (feed lane long-tail —
today honest sim_fails on depth), (b) same-block bundles — blocked on gas
budget, not code.

## Decision

- Keep hunting (a) — it's the only zero-cost channel; engine is honest.
- (b) is a Commander decision: a small BNB gas float + second executor
  deployment (OWNER=EOA) enables the already-built victim_tx bundle path —
  the designed mechanism for these exact edges.

## Verification

- `cargo test --release -p arb-runner` — all green incl. 2 new regression
  tests (`test_bait_pool_outlier_attribution_spares_collateral_pools`,
  `test_revert_blames_pool_attribution`).
- Live: timeout storm gone, `Bait pool list restored from disk restored=1`
  (hard flags only), fleet hunting all 3 chains, `dry_run=false`.
