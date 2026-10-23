# Skill ↔ Work-Order map (ENFORCED)

Rule: every WO report must cite the skill.md section(s) that produced its
evidence. A completion claim that cannot name its skill is rejected.
Numbers come from skill-formula output, not hand-typed reasoning.

| skill.md section | Governs | Required in WOs |
|---|---|---|
| Price & quote math (V2 CP, V3 spot, tick-walk guard, **closed-form sizing R1**, per-pool on-chain fee) | leg quoting + optimal input t* | WO-8.6 (counterfactual nets), WO-9 (sizing+legs), WO-10 (collateral sell sizing), WO-12 ($/day scoring) |
| Profit constraint (net = gross − gas − L1 − premium − bribe; **exact gas gate**; **MEV-Share refund leg**) | the only net formula that counts | WO-8.6 (EV sweep), WO-9 (gas gate), WO-10 (net incl. protocolFee), WO-11 (net incl. refund), WO-12 |
| Bellman-Ford pathfinder (size-blind; convex note) | cycle discovery | WO-9 (compose (P,Q,R) per R1), WO-12 |
| Predictive drift + variant presets (FLAGGED hand-set) | variant lanes | WO-13 (derive/learn, never hand-pick) |
| Credibility ceiling + forensics (bait, peer divergence, explorer verdicts) | liar-pool exclusion | WO-10 (oracle-manip + bad-debt guards), WO-12, all shadows |
| Filtration gate counters | funnel audit | WO-8.6, WO-10 §7, WO-11 shadows — every shadow run MUST report the 4 counters |
| Performance analytics ledger | variant@lane outcomes | WO-13 (feature rows: regime, gap, depth, hops, gas, latency, outcome) |
| On-chain decimals authority | 10ᵏ scale correctness | WO-9, WO-10 — never feed metadata |
| L1 data-fee oracle (OP_STACK) | L2 net correctness | WO-9, WO-10, WO-12 — base/op/blast nets invalid without it |
| Dynamic slippage engine | impact bound per leg | WO-9, WO-13 (bounds become learned) |
| Flash venue ladder (Balancer 0% → Morpho/Maker → Aave 0.09%) | capital source order | WO-9, WO-10 — never pick paid before free |
| Deploy address registry (VENUES / DEX_ROUTERS, EIP-55) | redeploy correctness | WO-9 step 6 — getters must answer post-deploy |
| Provider catalog + account-bucket doctrine | RPC capacity | WO-12 (census budgets), WO-14 (latency), WO-16 (paid tier) |
| Multicall3 request algebra | request-count discipline | WO-9 (fee reads), WO-10 (HF batch), WO-12 (census) — per-pool queries forbidden |
| Flashbots private rail (`eth_callBundle` gate, `mev_sendBundle` format, refund telemetry) | private lanes | WO-11 — raw signed txs only; 4337 UserOp is not a bundle tx |
| RPC overlay + fault interception | endpoint health | WO-14, WO-15 — transport faults never convict |
| Strategy-layer skills (regime gate, variant eval, whale routing) | conditioning | WO-13 (learner consumes regime+variant outcomes) |
| Live-fork skills (`fork_live_chain_state`, `execute_fork_dry_run`, failure taxonomy) | simulation honesty | WO-9 canaries, WO-10 fork liquidation, WO-11 callBundle — mocks forbidden |
| Chainstack MCP platform | capacity expansion | WO-16 only (armed quota) |
| Liquidation mechanics (Aave V3 source-verified) | WO-10 profit math | WO-10 — close factor 50%/100%@HF<0.95, bonus×(1−protocolFee) |
| LVR pool-ranking prior (UNVERIFIED) | WO-12 scoring prior | WO-12 — σ²·TVL as prior only until arXiv:2208.06046 confirmed |
| Competition & bidding game (log discipline) | bid-model data | WO-11 — every bundle logs gross/bid/builders/inclusion/net |
| Source ledger + open research queue | citation honesty | ALL — no claim without fetched source; MEASURE for market properties |

## Enforcement (WO workflow)

1. WO brief → tag required skills before starting (this table).
2. During work → every evidence row names its producing skill.
3. Report → "Skills exercised" line is mandatory; a verdict without it
   is incomplete.
4. Any threshold not produced by THRESHOLDS.md formulas = UNDECIDED by
   default.
