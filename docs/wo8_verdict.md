# WO-8.6 verdict — static-scan arbitrage on Base

## Verdict: **DEAD as built / counterfactual UNDECIDED**

- As built: **DEAD.** p = exec-pass rate = **0/148 measured** → every
  candidate the solver passed is un-executable; realized D = $0.
- Counterfactual (both exec bugs fixed): **UNDECIDED** per THRESHOLDS §2 —
  D ≈ **$33–61/day** vs C_run = **REQUESTED** (host invoice + engineering
  cost + redeploy amortization are Commander inputs, not assumed).
  Resolves to FIX-WORTHY iff D_lo > C_run.

## Funnel (live counters, base shadow)

```
detected              761,028
forensic-bait       2,059,493   (peer divergence convictions)
profit-margin      17,069,808   (depth 16.34M · no_spread 705k · impact 16.3k
                                 · below_gas 924 · min_profit_floor 8,194)
passed_to_simulation_probe    148
exec-probe pass                 0/148   (100% revert 0xa932492f = aerodrome K())
```

## Distinct paths

All 148 probe_pass events = **one path**: aerodrome-V1 VIRTUAL/WETH
`0x21594b…` → UniV3-500 `0x9c087e…`. Recurs in bursts (11–23 events/hr).
14 distinct paths exist across near-miss + pass rows.

## Counterfactual EV (THRESHOLDS §1, computed not picked)

735 emit rows → **44 distinct (path, hour)** opportunities over 0.47 days
(≈88/day). Nets corrected −13% for the 30→100bps aerodrome fee misread
(measured on the replayed candidate: $2.57 → $2.246).

| p (post-fix exec agreement) | f* (break-even floor) | argmax EV floor | candidates/day | EV/day |
|---|---|---|---|---|
| 0.5 | $0.0085 | $0.00 | ~88 | **$33.43** |
| 0.9 | $0.0009 | $0.00 | ~88 | **$60.78** |

Floor binders: f* ≈ 0 (cheap base gas c≈$0.0085); the binding gate is the
configured MIN_PROFIT_USD=$2.50, not EV — under f*≈0 the system should
attempt everything with positive modelled net, letting the atomic
minOut/minProfit guards reject failures at cost c only.

## v3 fidelity

14 real SwapRouter02 swaps on fork — model error ≈0.00% (p50/p90/max).
Math is not the problem; exec encoding is.

## Memory (WO-1 regression)

mem_telemetry flat in sampled windows; post-GC flag did not thread the
tsx wrapper (pre-GC heapUsed only — flagged, not hidden).

## Could NOT verify

- Contested share / competitor extraction (swap persistence starved —
  8 rows/20h).
- Post-fix exec agreement p (needs WO-9 + agreement measurement; the
  sweep brackets it at 0.5/0.9).
- Whether the recurring VIRTUAL/WETH dislocation is already farmed.
- C_run — REQUESTED from Commander.

## What would make it FIX-WORTHY

D_lo > C_run: at ~$50/day counterfactual, payback horizon > redeploy +
ops cost decides. Requires: WO-9 shipped, agreement p measured ≥ a*,
and competition measured — not assumed away.
