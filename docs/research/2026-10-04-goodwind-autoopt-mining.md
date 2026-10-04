# GOODWIND auto-optimization comparison — mining review

Date: 2026-10-04
Source: Commander-shared "Optimization Analytics Comparison Table" (parallel GOODWIND effort)
Status labels: [verified] = observed in our code/runtime · [repo evidence] = GOODWIND doc claims · [assumption] = synthetic/sim-only · [unknown] = unverifiable

## Honesty flag (governance)

All GOODWIND performance figures are **synthetic-seeded harness output** — 930 seeded pairs, 5,000 trades, 100.00% win rate, $399,898.60 net, $3,991,661/hr "joint efficiency" on a 1000-tick simulator. [assumption] — a deterministic round-robin DEX selector and TVL-weighted opportunity generator, not live fills. Referenced anywhere downstream only as sim-only.

Their own data point that matches our reality: the fleet optimizer converged to **n\*=1 cap-bounded in Bootstrap** — same conservative shape as our verified=0/$0-spend engine.

## System-by-system evaluation vs our codebase

| GOODWIND system | Our equivalent | Verdict |
|---|---|---|
| Adaptive MEV bribe (5000–9000 bps) | Pimlico-sponsored UserOps pay no bribe; builder path uses live `gas_price()` + fixed 1 gwei priority | **Skip** — different venue model; nothing to adapt |
| Per-chain gas EMA | `endpoint.gas_price()` called **live per submit** — strictly fresher than an EMA; executor has on-chain `gas_price_too_high` revert | **Skip** — no measured gap; EMA would only pre-gate probes during spikes, unmeasured problem |
| Adaptive EMA half-life (60–600s) | No EMA exists in codebase [verified] | **Skip** |
| Per-(chain,DEX) sim-gate calibration (68 gates) | Static `min_bps`/`min_usd`/`safety_margin_bps` + one protocol margin (PancakeStable) | **Port — structure only.** Generalized to `[gate.protocol_margins]` per-protocol margin map; values stay at current defaults — calibration needs realized settles we don't have yet (0 submits) |
| Adaptive DFS hops (3–6) | Fixed `MAX_PATH_HOPS = 3` — tighter already | **Skip** — deeper hops multiply path space ~100× for no measured benefit |
| `winner_graph` liquidity-ranked truncation (top-32 tokens by reserve) | Adjacency edges ordered by declaration order; `max_paths_through_token=200` cap keeps whatever order pools were declared | **Port** — `PoolInfo.liquidity_hint` + liquidity-sorted adjacency; discovery `liquidity_usd` populates the hint where known, deterministic tie-break. Caps now keep deep pools first |
| Adaptive tick cadence | pending→eval p50 ≈1s, scan-loop bound | **Skip** |
| Fleet scaling 1–10 + daily cap + 4-phase GrowthController | Strategy lifecycle (observe→replay→shadow→bounded_live ≤$25, ~20k-block expiry) is the shipped equivalent | **Skip** — equivalent exists; daily cap has nothing to bind at 0 submits |
| SimulationGate (kill + verify) | Literal-route sim verify + exec-probe before every submit | **Skip** — already shipped |
| `verify_auto_optimization` zero-trust binary | `profit_profile --backrun` + `statecheck` already zero-trust against live state | **Already have** |

## What actually shipped

1. **Liquidity-ranked adjacency** (`crates/arb-paths/src/enumerate.rs`): `PoolInfo.liquidity_hint` field; each token's edge list sorted hint-desc (tie-break pool addr asc, neighbor asc) before DFS — the 200-paths-through-token and 25k-per-flash-token caps now keep deep pools first. Populated from `liquidity_usd` where discovery data carries it; 0.0 = unknown (stable — declaration order preserved).
   Gap closed: thin/phantom pools no longer crowd out deep pools inside caps when ranking data exists.

2. **Per-protocol gate margins** (`crates/arb-sim/src/gate.rs`, `crates/arb-runner/src/config.rs`): `[gate.protocol_margins]` TOML map (protocol-name keys via `parse_protocol_name`); gate adds the max margin across a path's hops to `safety_margin_bps`. Backward compatible — `stable_pool_extra_margin_bps` still seeds the PancakeStable entry.
   Gap closed: provides the calibration slot GOODWIND's 68-gate scheme points at, without fabricating calibrated values we can't measure yet.

## Industry-practice check (rapid pass)

Static gas-price gating + break-even gas calc, two-stage path screening (rate-only → full sim), liquidity-bounded graph pruning, threshold+margin gating are the documented baselines [verified via public MEV-bot docs/blogs]. GOODWIND's "adaptive" layer wraps the same knobs; most adapt quantities we either don't have (bribes) or already read live (gas price).

## Verification

- `cargo check --workspace --all-targets`: green
- `cargo test -p arb-sim -p arb-paths`: 17/17 pass
- Behavior-neutral where no liquidity data exists (stable sort preserves prior enumeration)
