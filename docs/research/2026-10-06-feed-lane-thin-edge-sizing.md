# Feed lane — thin-edge sizing ceiling + TickLens verdict (2026-10-06)

Owner lane: `feed_lane.rs` / `feed_probe`. Trigger: fleet-relayed funnel —
`arb_feed_verified` pass=3 BSC / 3 Polygon this window, all dying
`negative_net_after_gas` at nets $0.015–$0.041 vs "~$0.046 gas floor"
(profit_bps 9.6–13.7, e.g. ETH/WBNB).

## Findings

1. **The floor is min_net + gas ≈ $1.046, not $0.046** [repo evidence].
   `verify_and_submit` rejects when `gross_usd - gas_usd < cfg.min_net_usd`
   with `min_net_usd = 1.0`. The relayed "~$0.046" is only the gas
   component. Observed $0.015–0.041 gross nets are ~25–70× below the real
   floor.

2. **Size does NOT rescue the observed class** [measured]. Live cost-curve
   scan (`feed_probe` prints `peak[local=… qv2=…]` per candidate over the
   optimizer range extended to a depth-only bound): every current BSC
   candidate's QuoterV2-verified net curve peaks at the smallest size
   (`$0.000@1`) — cost rises monotonically, no interior peak. For the
   fleet's positive edges (~0.75–2 bps net margin on ETH/WBNB-class pools),
   clearing $1.046 needs ~$25–70k notional at linear scaling, and pool
   impact turns superlinear well before that on non-majors. Conclusion:
   `negative_net_after_gas` on these candidates is **honest thin
   economics**, not a sizing bug. `find_optimal_amount` already searches
   [floor, cap]; the cap is not what makes them fail — the $1 profit floor
   is.

3. **Borrow cost does not scale** [verified on-chain]. The submitted path
   (`executeV4Arbitrage` — the only entry `builder.rs` emits) borrows via
   PancakeSwap V4 PoolManager `take/settle` — 0% flash premium, unlike the
   Aave path (premium enforced on-chain). Deployed executor's
   `minProfitBasisPoints() = 0` — no contract-level profit bps scaling.

4. **Deep pools DO have rescuable headroom** [measured]. Round-trip cost
   curve on USDT/WBNB (PCS V2 25bps → PCS V3 0.05% via QuoterV2):

   | notional | round-trip cost | bps |
   |---|---|---|
   | $500 | $1.48 | 29.5 |
   | $2,000 | $6.03 | 30.1 |
   | $8,000 | $26.02 | 32.5 |
   | $16,000 | $57.17 | 35.7 |

   Cost stays ~linear to ~$8–16k on deep pools (fee-dominated) — a 32bps
   spread there peaks above the floor near $3–4k, which the old $2000
   `max_notional_usd` cap would never have reached.

5. **TickLens vs QuoterV2** [measured]: `getPopulatedTicksInWord` needs
   ~5 bitmap-word reads + 187–742 `ticks()` liquidityNet reads per pool,
   then a full tick-crossing swap-math reimplementation — strictly inferior
   to one QuoterV2 eth_call that executes the real multi-tick swap inside
   the pool contract. Rejected as a new wheel. The deterministic `n/a`s
   observed (BTCB/USDT `0x247f5188`, DOGE/WBNB `0xce6160bb`) are pools not
   under either mapped factory — likely PCS Infinity CL (PoolManager
   singleton, V3-like slot0) — correctly falling through to exec-probe.

## Decisions / changes

- **`max_notional_usd` 2000 → 8000 on BSC + Polygon** [feed-scoped]. Lets
  the optimizer reach deep-pool peaks above the $1.046 floor; thin pools
  stay capped by `pool_share_bps=1500`. Risk unchanged: revert-protected
  (minOut=flash_amount), 0% borrow premium, sponsored gas — an oversized
  decayed attempt reverts exactly like a $2k one. ETH left at $2000 — its
  ~$8 gas floor is a different regime.
- **Transport-error cache fix**: `factory_owns_pool` now returns
  `Option<bool>`; quoter-cache `None` entries are written only when every
  factory definitively answered — a dead endpoint can no longer strip the
  on-chain check from a pool for the process lifetime (same policy as the
  existing `sniffed` miss rule). Applied to `feed_lane.rs` and
  `feed_probe.rs`.

## Bounded decision for Commander (no action taken)

Lowering `min_net_usd` below $1 would admit sub-$1 landed profits — the
observed $0.04-class edges still wouldn't clear it without a ~$52k
notional; only genuinely deeper/spread-wider candidates benefit from the
cap raise. Recommend keeping min_net at $1 — dust-profit fills at copy_mode
volume aren't worth bundler revert-rate reputation.

## Locks

- LOCKED_MODULES row: quoter cache never records a miss on transport error.
