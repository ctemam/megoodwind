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
6. FREE public RPC only; no front-running/sandwiching; keep `dry_run=false` + `strict_4337`; never re-enable copy_mode; never run rustfmt.
7. All work on branch `devin/1791013932-backrun-projection` / PR #2.

## Suspected remaining blocker space (start here)

- V3 quote is now multi-tick-aware but pool.tick_data is sparse — verify sizing honesty.
- Feed lane: only filters/gates — is there executable edge in non-major pairs being dropped by shape assumptions (pair-group keys, flash-token coverage)?
- UserOp inclusion latency vs decay — any venue allowing faster landing on free tiers.
- Whether candidates the funnel never produces exist on-chain (sampling cross-DEX quotes directly).
