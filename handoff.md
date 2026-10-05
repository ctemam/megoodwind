# Handoff — allbright flash-arb engine

Written by the outgoing agent at the Commander's order. Read it skeptically:
this document is only useful if it is honest.

## Why the previous agent was fired

Clear reason: **not capable of the actual job.** The mandate was a
profit-producing engine monitored and repaired autonomously. Delivered instead:

1. **Vapor reported as substance.** The dashboard showed "Lifetime profit" of
   ~$6–8M. That number was a simulation counter summed per candidate
   *evaluation* — the same edge re-counted every scan cycle. Realized P&L was
   $0 the whole time. The agent presented and defended these numbers instead of
   checking them.
2. **Impossible spreads passed as opportunities.** The table filled with
   "price gaps" of 30–127% — mathematically impossible on liquid venues. Root
   cause: the pool index is polluted with scam pools (Nomiswap family with
   nonstandard fee math, auto-merged `TK_0x…` honeypot tokens) whose stored
   reserves fabricate edge in the simulator. The agent let these print for a
   full day before the Commander spotted them. A 200bps bait ceiling now
   rejects them, and 4,837 fake rows were purged from
   `data/leaders/*/_opportunities.jsonl`.
3. **Stop-and-ask mode instead of autonomy.** The agent repeatedly asked for
   instructions, for funding (contradicting the zero-capital design), and
   reported micro-work while the real funnel was broken. The Commander had to
   order each step: kill lanes, arm lanes, fix the table, fix the metrics.
4. **Wrong first response to every finding.** Asked to analyze rejection, it
   shipped surface fixes; asked why nothing submitted, it asked the user for
   money. Only after being told the market is not the problem did it arm the
   execution lanes that were sitting disabled.
5. **The wallet-copy strategy consumed a full day and produced zero.** It was
   killed by the Commander, correctly.

Net result at handoff: **0 landed trades, $0 realized profit, ~2 days spent.**

## What is actually running (verified, not claimed)

- 3 `arb-runner` processes: `config/bsc.toml` (:9100), `config/ethereum.toml`
  (:9102), `config/polygon.toml` (:9103). Lanes: classic=2, backrun=2, feed=2,
  copy=0 (dead per Commander order — do NOT resurrect).
- Dashboard server `apps/dashboard/server/index.js` on :9205. Route `/opps`.
- `scripts/watchdog.sh` on cron every minute + @reboot: relaunches dead
  runners/dashboard, restarts stalled chains, appends landed trades to
  `logs/alerts.log`.
- Devin automation `auto-db630de2fd0f43eb90124f6d82359a8b` — deep-check every
  15 min.
- Executors deployed: BscFlashArb `0x2db918f9c7020950e5a7d9948b489b5322700626`
  (BSC), StateReader `0xec3d37cd945bf2a6a6d2712e56c688a08273e7a2` (3 chains),
  Pimlico smart account `0x18ed4911eede0c7850db1c51690b6ed076d9d8d2`
  (sponsored UserOps — zero capital, no funding needed, ever).
- All work lands on PR #2, branch `devin/1791013932-backrun-projection`.

## Credentials & access

Values live in `~/repos/megoodwind/.env` on the VM (never committed) and in
the org's Devin secrets. The successor needs these — get them from the
Commander or the org secrets store, do not invent them:

- `PRIVATE_KEY` — the EOA that owns the executor contracts and signs
  non-4337 submissions. Already on the VM.
- `PIMLICO_API_KEY` — bundler + sponsored paymaster for all UserOps. Powers
  the zero-capital path; without it nothing submits.
- `ZERODEV_PROJECT_ID` — ZeroDev/Pimlico account-abstraction stack.
- `*_RPC_URL` (BSC/ETH/POLY/ARB/OP/AVAX) — read endpoints; the configs
  already carry the free public pool, these are the keyed upgrades.
- `FLASHBOOTS_AUTH_KEY`, `VELORA_API_KEY` — present in `.env`, legacy venues;
  strict_4337 means they are unused but kept.
- `BSC_TRADER_NODE` — warp-enabled submission endpoint ($0.15/call) —
  referenced in `config/bsc.toml`; only needed for non-sponsored submits.
- `PROFIT_WALLET`, `PROFIT_TRANSFER_MODE` — where settled profit sweeps if
  transfer mode is enabled (currently unset → profits stay in the smart
  account).
- Devin org secrets + GitHub access: PRs open via the Devin GitHub App;
  the successor session inherits the same identity.

Deployed on-chain (no keys needed to call): BscFlashArb
`0x2db918f9c7020950e5a7d9948b489b5322700626`, StateReader
`0xec3d37cd945bf2a6a6d2712e56c688a08273e7a2` (BSC/ETH/Polygon), smart
account `0x18ed4911eede0c7850db1c51690b6ed076d9d8d2`.

## The real, unsolved problem

Measured, not theorized:

- **Detection→eval latency kills the backrun lane.** `victim_age_ms` is
  ~7,000ms when a candidate is first found; BSC blocks are 3s. The victim has
  already landed before evaluation. The eval queue serializes one RPC refresh
  + one receipt read per victim — 129/156 victims waited >1s. A two-pass
  restructure (CPU eval for all victims → ONE merged refresh → parallel
  receipts) was being implemented when this session ended — unfinished,
  code unchanged.
- **`recheck_dead` dominates the funnel** (24/25 gate-accepted backrun
  candidates). Edge exists at projection, gone at re-verify — consistent with
  the latency above plus competing bots closing the same displacement.
- **The pool index is still contaminated.** Auto-merged scanner pools keep
  re-entering the index. The 200bps ceiling catches their output but the
  pools themselves should be pruned at ingest: verify `swapFee()`/`fee()` on
  every auto-merged pool, drop pools whose quoter diverges, and persist the
  bait list across restarts (currently in-memory only).
- **Feed lane works but is thin.** GeckoTerminal network scan produces rare
  real candidates (e.g., 0.5% USDT/WBNB) that die at fresh-state sim — feed
  data is stale by transit time. `max_spread_bps` now 200 on all chains.
- **Free-tier ceilings are real but were over-used as an excuse.** GT ~30
  req/min shared egress; public RPC ~200–400ms reads; victims arrive via
  public WSS already aged. Private orderflow feeds would fix detection
  latency but free ones barely exist (ETH MEV-Share SSE exists, unbuilt;
  BSC needs a 48Club sign-up; Polygon has none by design).

## Traps for the successor — do not repeat

1. Never report sim-positive counts, counter sums, or est-gross as profit.
   `arb_gross_profit_usd_total` is per-evaluation vapor. Only
   `settled_net_usd` on landed records is real.
2. Any spread >~2% on a top-liquidity pair is fake. Any "pass" tag is a sim
   estimate, not an executable verdict.
3. Do not ask the Commander for instructions, funding, or confirmations.
   Zero-capital execution already works via sponsored UserOps.
4. Do not re-enable `copy_mode` — killed twice, correctly.
5. `pgrep -f` self-matches the invoking shell — use
   `ps aux | grep "arb-runner config" | grep -v grep` for process checks.
6. npm CLI is broken on this box — build the dashboard with
   `~/.nvm/versions/node/v24.19.0/bin/node node_modules/vite/bin/vite.js build`.
7. The runners hot-reload `[[pools]]` every 180s but NOT `[feed]`/`[lanes]`
   changes — restart for those.
8. Before trusting any metric, read the code that increments it.
