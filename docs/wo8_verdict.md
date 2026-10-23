# WO-8 verdict — static-scan arbitrage on Base

## Verdict: **DEAD** (as built)

Not for lack of candidates — for execution. Every candidate the solver ever
passed on base is un-executable under the current contract stack, and the
counterfactual edge even with both bugs fixed is floor-scale.

## The numbers (raw, from persisted rows + live counters)

**Funnel (cumulative, base shadow):**

| gate | rows |
|---|---|
| total_detected_opportunities | 761,028 |
| rejected depth | 16,339,366 |
| rejected no_spread | 705,024 |
| rejected price_impact | 16,300 |
| rejected forensic divergence | 2,059,493 |
| rejected below_gas_multiple | 924 |
| rejected min_profit_floor | 8,194 |
| **passed_to_simulation_probe** | **148** |
| **exec-probe pass (state-overridden current executor)** | **0** |
| exec-probe deterministic revert | **148 / 148 (100%)** |

Every one of the 148 exec-probes reverted `0xa932492f` (aerodrome `K()`).

**Distinctness:** all 148 probe_pass events are **one path** —
aerodrome V1 VIRTUAL/WETH `0x21594b…` → UniV3 fee=500 VIRTUAL/WETH
`0x9c087e…`. Emissions recur in bursts (h0: 23, h7: 11, h8: 14) with
modelled net $3.14–$5.30 — always sub-floor or phantom.

**Counterfactual (bugs fixed):** near-miss + pass rows deduped by path —
floor $0.25 → 6 paths, sum-of-best-net **$9.38**; $0.50 → $8.58;
$1.00 → $7.90; $2.50 → 1 path $5.30. One path produces ~$3.4–5.3 per
emission window; the *entire observed base edge* is one persistent
VIRTUAL/WETH dislocation worth ≤$5.30 per occurrence.

**v3 fidelity:** 14 real SwapRouter02 swaps on fork — model error ≈ 0.00%
(p50/p90/max). The pricing math is not the problem; the exec stack is.

**Memory:** mem_telemetry running, no snapshot files generated this run
(HEAP_SNAP_MINUTES=0); rss trend flat (see reports/wo8_shadow_*.txt tail).

**Swap persistence:** only 8 raw rows in ~20h — the per-block getLogs
scanner is starved by shared free-tier rate limits competing with the
shadow runner itself. Raw swap coverage this window: insufficient for
offline re-threshold; the in-flight counters (0 dislocations ≥10bps on
16 peer-evaluated swaps when the process was breathing) stand as
log-derived, not raw-persisted, evidence.

## Required fixes to change the verdict (WO-9 scope — NOT approved)

1. Per-pool fee reads (`getFee`/`fee()`) at discovery — aerodrome pools
   charge real fees ≠ 30bps (this pool: 100bps).
2. V3 leg via SwapRouter02 7-param `exactInputSingle` or direct
   `pool.swap` — base has no deadline-ABI router.
3. Redeploy executor (deployed 0x6614… is stale, 11,060B vs 9,016B
   source, venue getters dead) — on base AND eth/arb.

## Cost of the fix vs measured edge

Even granting all three fixes: the best observed single-path net is
$3.4–$5.3/event, ~12 events/hour *during bursts*, and bursts occupy
~3 of the observed 11 hours — a theoretical ceiling of roughly
**$100–150/day** if exec worked and the dislocation were unclaimed.
But a persistent recurring dislocation is precisely the profile of an
edge someone already farms (contested-share unmeasured — swap coverage
was starved). That ceiling does not survive a redeploy + arming risk
profile, and it does not generalize beyond this one pair.
