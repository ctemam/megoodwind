# Coordinator audit: Classic gate, execution/settlement path, RPC data plane, victim visibility

Date: 2026-10-06 · Branch: `devin/1791013932-backrun-projection` · Author: coordinator session (win12ab)

## Question

Which parts of the engine remain unverified or misattributed as profit
blockers? Cover the domains the engineer team couldn't staff (SWE-2
5-session cap): classic gate, exec/settlement, RPC health, victim timing.

## Findings

### Classic scanner gate (arb-sim/gate.rs) — [verified] honest, not a bug

- `below_safety_margin` (1,904 rejects): profit_bps ≤ safety_margin(10)
  + per-protocol extra. These are real spreads on majors of 5–26bps —
  round-trip swap fees alone (2×0.25%) are ~50bps. Gross < fees =
  honest reject.
- `below_min_usd` (1,465): net < $0.60 after `tx_gas_cost_usd` — correct
  economics.
- `bait_gap` (1,476): spread >200bps — phantom/bait per the measured
  honesty rule.
- **Conclusion [verified]:** the 3,369-found/0-submitted gap is market
  compression on tracked majors, not model error. Cyclic arb can only
  win in the long tail (fee-tier mismatches, unraced exotics) — that is
  the feed lane's job (Engineer E1).

### Execution path (arb-submit) — [verified] byte-correct

- `PackedUserOp::pack_hash` matches ERC-4337 v0.6 `packUserOp` field-for-
  field (sender|nonce|keccak(initCode)|keccak(callData)|5 gas fields|
  keccak(paymasterAndData)); `user_op_hash` = keccak(packHash|entryPoint|
  chainId); signing = EIP-191 personal over userOpHash (SimpleAccount
  v0.6 semantics). JSON encoding correct.
- Venue health: merit rejections (exec_revert/rejected) no longer bench
  the venue — fixed earlier today (commit 8facfdf, tests locked).
- **Gap found [repo evidence]:** no profit-sweep code exists. Executor
  accumulates `totalProfit`; `emergencyWithdraw(token,to,amount)` is
  onlyOwner and callable via sponsored UserOp once profit exists. Add a
  post-settle sweep path to PROFIT_WALLET when first profit lands —
  designed, not yet needed (nothing to sweep).

### RPC data plane — [verified] healthy

- latency_bench (v3 probe, 8-pool reads, 3 samples): all 23 configured
  BSC endpoints p50 call 60–112ms; best 59.5ms eth_blockNumber
  (bsc-dataseed4.bnbchain.org). drpc WSS fails cold eth_blockNumber —
  cosmetic. Endpoint breadth adequate; 15rps throttle is the binding
  constraint only at boot bursts (chunk_size=128 cold, self-recovers).
- No cull required; chronic losers already blacklisted at runtime.

### Victim timing (backrun lane) — [verified] structural dead end (gasless)

- All 35 logged victim events this session: `victim_landed=true`,
  victim_age_ms 70–180ms (tail to ~900ms). The public WSS mempool only
  surfaces victims AFTER landing — zero pre-landing visibility window.
- Even with instant detection, a sponsored UserOp lands ≥1 block later;
  measured post-victim edges decay <200ms. Same-block capture requires
  a builder bundle (needs funded EOA executor — documented bounded
  decision, not a code gap).

## Impact

Eliminates exec-encoding, RPC health, and gate-calibration as candidate
blockers. The only live frontier under current constraints: persistent
long-tail dislocations via the feed lane (E1) + capital-gated same-block
path (Commander decision, documented).

## Verification

- Gate code read + live reject counter reconciliation.
- UserOp struct/hash/sign vs ERC-4337 v0.6 spec field walk.
- latency_bench run on all 23 BSC endpoints (table above).
- 35 victim events mined from current pm2 logs.
