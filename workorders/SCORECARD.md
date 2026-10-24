# AllBright capability scorecard — evidence-based (Commander-ordered, 2026-10-24)

**To: Principal Architect. From: Commander (via Devin). Request: approval
of this scorecard as the standing capability register.**

Rubric (per `skill.md` §competitive-capability): 0 absent | 1–2
conceptual | 3–4 implemented, weakly verified | 5–6 functionally
verified | 7–8 operationally validated | 9 competitively demonstrated |
10 sustained advantage. **unknown ≠ 0.** Every claim labeled
built/replayed/shadow/settled + the `skill_wo_map` capability.

## Master scorecard — AllBright vs top-tier searcher

| # | Capability | AllBright score | Evidence class | Evidence | Top-tier target |
|---|---|---|---|---|---|
| 1 | Information advantage | **3** | built/shadow | public mempool WSS (`scoutListener`); MEV-Share hint stream **built, unexercised** (WO-11); no private-flow agreements; no CEX feed; free-tier RPC only | private flow + builder-integrated feed + CEX |
| 2 | Opportunity intelligence | **6** | replayed | auto-discovery (377 base + 540 arb pools, on-chain factory matrix); Bellman-Ford cycles; R1 sizing 3.5e-8 verified; **0/26k census + 0/3 replay** = detection works, edge absent | coverage × accuracy × hit rate |
| 3 | Strategy portfolio | **5** | built/replayed | DEX arb + backrun built; liquidation **fork-settled** Aave $61.8k + Morpho $36k; no CEX-DEX/JIT/cross-chain | 4+ validated lanes |
| 4 | Latency & infrastructure | **2** | built | LatencyTracker stamped; free-RPC 160–250ms measured; single-host, no sequencer-adjacent infra; **not measured end-to-end vs block time** | <50ms event-to-submit |
| 5 | Execution engineering | **6** | replayed | direct `pool.swap` + `uniswapV3SwapCallback`; `V2_SELFQUOTE` + fee shave; atomic minOut/minProfit — **deployed bytecode is STALE (11,060B vs 15,047B)** → capability exists, live verification pending | tuned calldata + verified deploy |
| 6 | Block-space access | **3** | built | `eth_callBundle` gate + `eth_sendBundle` + `mev_sendBundle`; fixed-% bribe only; **zero landed bundles** → unexercised | multi-builder, learned bid, inclusion feedback |
| 7 | Competitive intelligence | **2** | built | `firstMover` attribution + `bundle_ledger` schema exist; **no landed data** → unexercised | win/loss attribution on settled evidence |
| 8 | Capital & inventory | **3** | built | flash-loan-only (Balancer 0% → Morpho/Maker 0% → Aave 0.09%); no inventory → structural ceiling vs inventory-backed searchers | flash + inventory hybrid |
| 9 | Risk & security | **8** | replayed | atomic exec, fail-closed, `mayExecute` enforced (kill/loss/capital), `DIAG_ONLY` hard-stop, peer-divergence convictions, per-pool fee/decimal authority — verified on forks + replay; **no live incident data** | same + production track record |
| 10 | Learning & adaptation | **4** | built | Thompson arms, VariantScheduler, regime gates (6 classes incl. fail-closed `DEGRADED_INFO`) — built, **~0 settled rows** → cold start | learned allocation with data |
| 11 | Operational resilience | **4** | built/shadow | kill file, loss breaker, account-bucket RPC pools + cooldown — **dRPC monthly quota exhausted this week** = measured resilience failure; Ankr/Alchemy fallback worked | redundancy + alerts + recovery tests |
| 12 | Operating economics | **5** | built | `rpcEconomics` measured → **no spend**; C_run ≈ $1.75/day infra; operator time unmeasured (Commander input) | full P&L per lane |

**Aggregate: ~4.2/10** — a competent research machine with a
risk-control spine (the only near-top-tier dimension) and an unproven
edge. Honest reading: the gap is not code volume, it is
**information access + inclusion + measurable edge**.

## Strategy-specific scorecards

| Category | DEX arb | Liquidation | Backrun |
|---|---|---|---|
| detection | 6 (discover+solve works) | **7** (indexer+HF watch live, Morpho+Aave settled on fork) | 4 (planner built) |
| execution | 5 (built, deployed stale) | **6** (two protocols fork-settled) | 3 (built) |
| info source | 3 (public mempool) | **6** (protocol state, deterministic trigger — least info-advantage-dependent) | 2 (needs hints/private flow) |
| latency req | 2 (loses to faster searchers) | **5** (first-liquidator wins but event-driven, not pure speed) | 2 (same-block race) |
| realized evidence | **0** (0/3 replay, 0/26k census) | fork-only | 0 |
| **lane score** | **~3.5** | **~5.5** | **~3** |

## Gap analysis

| Gap | Type | Fixable by code? |
|---|---|---|
| No private order flow / CEX feed | structural | ❌ needs commercial access |
| 160–250ms latency vs <50ms | structural | ⚠️ paid infra, not code |
| 0 landed bundles / zero inclusion data | unexercised | ✅ needs redeploy + shadow run |
| Deployed executor stale | operational | ✅ redeploy (Commander-held) |
| 0 settled live events | **the blocker** | ⛔ needs Gate A pass |
| Operator time unmeasured | accounting | ✅ Commander input |
| Variants = 1 hypothesis | design honesty | ✅ already flagged (WO-18) |

## Top-5 recommendations (impact × cost × confidence)

1. **Redeploy + Gate-A replay** (the unlock) — cost ~$130 eth deploy; unblocks ALL live evidence. Commander-held.
2. **Liquidation lane to live shadow** — strongest lane (fork-proven, least info-dependent); measure HF-band hit rate + competitor-landing rate.
3. **Bundle-ledger reconciliation on live sends** — closes the inclusion-measurement gap (D6 code ready, unexercised).
4. **RPC resilience fix** — dRPC exhaustion this week was a measured failure; add quota-aware throttling + more account diversity before it repeats.
5. **Funnel attribution deepen** — the 0/26k + 0/3 result needs per-stage failure accounting (already instrumented) to distinguish "no edge" from "bad data".

## Measurement plan per recommendation

| # | Metric | Test |
|---|---|---|
| 1 | Gate A: ≥12 candidates, ≥20% settle, ≤5% model error | pinned-block replay vs deployed address |
| 2 | HF-band hit rate, time-to-liquidatable, competitor closure | liq_shadow rows over shadow window |
| 3 | included rate, realizedNetUsd per bundle | `reconcileLedger` on sent bundles |
| 4 | rpc request success %, quota headroom | rpcPool counters + registry |
| 5 | stage-reject ratios by reason | diag jsonl histograms |

## Unknowns (explicitly NOT scored as zero)

- Competitor set and their actual capabilities (research gives mechanisms, not rankings).
- Whether any lane has live edge — Gate A unrun.
- Operator-time cost.
- WO-8.6 counterfactual C_run verdict.

**Requested action:** Principal Architect approve/adjust this
scorecard; Commander decides which single lane to validate first.
Devin's recommendation stands with the Architect's — **liquidation
first** (best evidence, least structural disadvantage).
