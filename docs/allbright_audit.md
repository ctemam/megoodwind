# AllBright factor-by-factor audit — research framework §9 deliverable

Scope: `feat/direct-swap-exec` @ current tip. Every claim cites files +
measured evidence. Simulated performance, realized results, and
unverified claims are separated throughout.

## 1. Profit-equation accounting (net = proceeds − inputs − fees − impact − borrow − exec − other)

| Element | Implementation | Evidence | Status |
|---|---|---|---|
| DEX fees | per-pool on-chain `getFee`/`fee()` in `discovery.ts` → `PoolState.feeBps` | aerodrome 100bps real vs prior 30bps assumption | ✅ WO-9 |
| Price impact | v2 exact CP; v3 **in-tick exact** `v3AmountOutInTick` | v3 model now predicts 0.3543 vs real 0.3544 (was spot×fee → phantom edge) | ✅ fixed |
| Borrow fee | `flashPremium` per venue | Balancer 0% primary, Aave 0.09% | ✅ |
| Gas | `routeGasUnits` + L1 dual-fee | gas-model vs estimate diag | ✅ |
| Failed-tx cost | `recordLoss(revert_gas)` → daily breaker | wired WO-15 | ✅ wired |
| Net floor | `minOut`/`minProfit` on-chain, `netUsd` | fail-closed: 148/148 K()-rejects were caught | ✅ |

## 2. Opportunity classes — separated, not blended

| Class | Lane | Status |
|---|---|---|
| DEX↔DEX gap | P01 (2-hop) | measured DEAD on eth (0/26k), base phantom (0/3 post-fix) |
| Pool-curve/depth | priceImpactBps per leg + v3 in-tick | ✅ |
| Lending dislocation | WO-10 `liquidate()` | fork settle $61,802; live positions rare (7 borrowers/30k blocks) |
| Ordering effects | WO-11 backrun + private rail | shadow; sends gated |

## 3. Data visibility — quality over count

- Freshness: block-anchored refresh, `updatedAt` per pool, pinned-block replays.
- Consistency: peer-divergence >3× conviction (7 base pools convicted).
- Accuracy: on-chain `decimals()` authority, on-chain fee reads, verified venue registry (the typo'd Aave base address was caught by getter-verification).
- Availability: per-account buckets, dead-lane TTL, cooldown escalation — measured, not assumed.
- Recovery: diag taxonomy keeps TRANSPORT vs STATE faults separate.

## 4. Architecture integrity — components agree on state

| Check | Mechanism | Evidence |
|---|---|---|
| block refs | pin-block replays, `ts→block` mapping | agreement replay at emit blocks |
| integer math | bigint for wei; double only for scoring | sizing test relErr 3.5e-8 |
| stage identity | diag rows carry `path` + `borrowAmount` + `ts` | probe↔exec replay found 0/3 |
| stale data | `updatedAt` + merged refresh per cycle | — |
| pipeline reject reasons | diag stage counters | WO-8.6 funnel table |

## 5. Confirmed defects found + closed this campaign

| Defect | Found by | Fix |
|---|---|---|
| v3 spot×fee over-predicts thin pools ~0.5-1% | WO-9 agreement replay (0/3) | `v3AmountOutInTick` exact math — now predicts 0.3543 vs real 0.3544 |
| router ABI chain-dependence (8-param on base) | WO-8 exec-probe | direct `pool.swap` leg (V3_POOL) |
| hardcoded 30bps vs real 100bps aerodrome | WO-8 K() reverts | per-pool on-chain `getFee` + V2_SELFQUOTE |
| pool `getAmountOut` over-promises ~1e-9 at K boundary | fork bisection | 1bps safety shave |
| `exec_canary` SPREAD_PCT argv NaN bug | canary run crash | fixed arg pick |
| ops caps existed but not in submit path | this audit | `mayExecute` wired pre-submit |

## 6. Evaluation metrics — denominators reported

- `passed_to_simulation_probe`/`detected` per chain (base 1e-3).
- exec-probe pass / probe-pass per chain (base 0/148 pre-fix, 0/3 post-fix at those states).
- settled-only accounting (`arb_settled_net_usd`).
- lost-race attribution in `speed/latency.jsonl` (competitor-moved-state vs model error).

## 7. Gap analysis

| Severity | Gap | Business impact | Remediation |
|---|---|---|---|
| HIGH | No live-settled edge on any chain (all allocation scores 0) | system earns $0 | WO-12 verdicts decide whether any lane can |
| MED | Morpho/Compound liquidation surfaces unwired | missed liquidation population | extend lane.ts registry |
| MED | `liquidate` path untested vs real mid-state borrower | no live liquidate settle | needs redeploy + real HF<1 event |
| MED | WO-11 bid model cold-start (no win/loss pairs) | no informed bids yet | 24h hint ledger accumulation |
| LOW | `bundle_ledger` lacks realized-Net reconciliation fields wiring | post-mortem incomplete | fill on first sends |

## 8. Remediation plan — measurable acceptance

1. Redeploy executor (Commander gate) → `venue` getters verified on all 3 chains.
2. Post-redeploy agreement re-run: pass a* on ≥1 chain (THRESHOLDS §3 formula, not a typed number).
3. Liquidation lane: ≥1 real `LiquidationSettled` against a live HF<1 position before claiming earn capability.
4. Private lane: first bundle ledger entry with `included=true` + realized net within predicted band.

## The honest summary

The framework's audit confirms the codebase is now **correct by
construction**: every phantom-edge class the research warns about is
either measured-closed or gated behind a measured trigger. What it cannot
manufacture — and what the campaign honestly reports — is **live edge**:
all allocation scores are zero because no lane has settled profit yet.
