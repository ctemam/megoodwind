# Handoff — Allbright Flash-Arb Profit Engine

## Repo access

- **Repository**: `ctemam/megoodwind` — https://github.com/ctemam/megoodwind
- **Working branch**: `devin/1791013932-backrun-projection` (PR #2 — all work lands here)
- **Local checkout on fleet VM**: `~/repos/megoodwind`
- **Credentials**: repo-scoped Devin secrets provide `PRIVATE_KEY`, `PIMLICO_API_KEY`, `PROFIT_WALLET`, and per-chain `*_RPC_URL`. `.env` lives at repo root on the VM (never committed — `.gitignore`d). Reference secrets via `secret:repo:ctemam/megoodwind:NAME`.

## What the system is

Rust workspace (alloy 1.8.x): multi-chain flash-loan arbitrage engine. Crates `arb-core`, `arb-discovery`, `arb-leaders`, `arb-mempool`, `arb-paths`, `arb-rpc`, `arb-runner`, `arb-sim`, `arb-state`, `arb-submit`. Fleet = 3 `arb-runner` processes (`config/bsc.toml` :9100, `config/ethereum.toml` :9102, `config/polygon.toml` :9103) under `scripts/watchdog.sh`. Dashboard at `apps/dashboard` (:9205). A 4×/hour Devin monitor automation hunts and self-repairs.

## Current verified state (2026-10-06)

- Realized lifetime P&L: **−$0.36** (one landed revert; floor fix shipped after).
- Detection/eval: µs-class (detached backrun lane, sub-ms pending→eval).
- Exec probe: local revm fork (foundry-fork-db 0.23 + alloy-evm 0.28 + revm 34), `eth_call` fallback.
- Feed lane: DexScreener token-pairs ingest → pair-groups gated on **on-chain** prices (MC3 reserves/sqrtP), not feed `price_native`.
- Executor owner = Pimlico smart account → UserOps only (~5-15s inclusion, no victim ordering). EOA `0x2eF3…14D56` is 0-balance — bundle venues configured but unusable (user-side lever).
- Ground truth 2026-10-05/06: deepest majors spreads 1-24bps raw — below executable cost; funnel kills all map to verified causes.

## Commander's standing orders

1. **No new wheels**: research and IMPORT industry tools (external crates/libs) — do not hand-roll what exists.
2. **Focus**: DexScreener-driven opportunity discovery → filtering → execution. Deep-dive and remove profit blockers with measurement, not assumptions.
3. **Lock completed modules**: row in `docs/LOCKED_MODULES.md` + regression test each.
4. Research before action: file under `docs/research/YYYY-MM-DD-<topic>.md` (findings → impact → decision → plan → verification).
5. Metrics honesty: only `arb_settled_net_usd` on landed records counts as profit.
6. FREE public RPC only; no front-running/sandwiching; keep `dry_run=false` + `strict_4337`; copy_mode LIVE per Commander order 2026-10-06 (backrun-copy semantics only — mirror after signal, never front-run); never run rustfmt.
7. All work on branch `devin/1791013932-backrun-projection` / PR #2.

## Suspected remaining blocker space (start here)

Resolved 2026-10-06 (commits `3c61429` + `d103b39`, verified live on BSC+Polygon):
- ~~Unlabeled dex ids dropped at ingest~~ → `probe_interfaces` batch-probes
  slot0/globalState/getReserves; ~49 BSC / ~67 Polygon pools/cycle rescued.
- ~~One divergent pool poisoned pair groups~~ → `trim_divergent` + persisted
  `_bait_pools.json` conviction (live: USDT/USDC 0.637-vs-0.9998 outlier
  excluded every cycle).
- ~~One failed aggregate3 chunk zeroed whole refreshes~~ → per-chunk
  `success:false` placeholders (Polygon 6/52→36/52 priced).
- ~~Fixed $2000 notional~~ → `find_optimal_amount` sizing before eval.
- ~~Non-major coverage~~ → top-60 token scan adds only ~5 groups, all majors;
  breadth exhausted — not a lever.

Residual blocker hierarchy (measured, evidence-ordered):
1. **Edge scarcity on majors**: honest on-chain spreads 1–31bps vs 30–50bps
   gates; fee-adjusted depth leaves ~$0. The funnel correctly rejects
   unprofitable edges — it is no longer blind.
2. **UserOp inclusion latency vs decay**: unmeasured end-to-end (free RPCs
   cap eth_getLogs at ~200 blocks; SA 0x18ed49…d8d2, nonce 6, all ops
   deployments). Measure once submissions exist — or fund the EOA path
   (user-side lever).
3. **V3 tick-cross honesty**: `quote_multi_tick_approx` approximates;
   exec probe backstops. Needs a spread-passing V3 pair to measure.
4. **Free-RPC transport ceiling**: chunk timeouts blacklist endpoints in
   rotation; per-chunk isolation contains it.

Live verification trail: BSC `probed`=49 + DOGE/WBNB candidate→sim_fail;
Polygon `probed`=67 + WPOL/USDT0 73.9bps→sim pass→`negative_net_after_gas`
(gas est ~600k×280gwei≈$0.035 — honest). End-to-end path proven:
discover→gate→sim→economics. Candidates now flow; submissions await a
real edge.
