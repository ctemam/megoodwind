# Handoff — allbright flash-arb engine

Written by the outgoing agent at the Commander's order. Read it skeptically:
this document is only useful if it is honest.

## Why THIS agent was fired (2026-10-06, second handoff)

Clear reason: **I requested funding for the smart account, contradicting
the zero-capital design I was hired under.** Account abstraction plus flash
loans IS the zero-capital answer — the executor borrows principal inside one
atomic tx (PoolManager.unlock → swaps → repay) and Pimlico sponsors gas via
UserOps. No inventory is ever required. Framing "fund the wallet" as the next
lever was an ignorant call on a working AA design. There is no capital
problem and never was.

## Update — 2026-10-07 (still on duty, not a firing note)

- **Realized P&L to date: −$13.9** across three landed trades (all ETH):
  +$0.143/−$1.76 gas, +$0.000012/−$3.63 gas, ~$0.88/−$9.4 gas — plus one
  honest protective revert on Polygon (−$0.026). All three lands routed
  through stale thin pools (FORT/USDC + FORT/WETH on ETH — canonical UniV3,
  NOT adversarial bait; the "edge" was a stale-price artifact that could
  only execute dust vs ETH gas).
- **ROOT CAUSE OF THE BLEED — now closed at the contract:** the executors
  had `minProfitBasisPoints = 0`, so ANY trade able to repay the flash loan
  passed bundler simulation and landed, including edges decayed below gas.
  Sponsored ops bill real gas on LANDED txs — every dust land burned $2–9.
- **Fix deployed on-chain** via sponsored admin ops
  (`admin_call <cfg> setMinProfitBasisPoints <bps>`, verified via getStats):
  ETH=100bps (~$4.5 floor at typical ~$450 borrows ≈ gas), BSC=2bps,
  Polygon=2bps (gas-aligned at realistic sizes — 25bps would block the
  entire observed 5–24bps spread band on cheap chains). A decayed edge now
  reverts `InsufficientProfit(0, floor)` INSIDE the bundler sim = free
  reject; the sim itself is the gas-floor filter. Live-verified: rejects
  show `0x4e88422a…0002`.
- **Post-floor (~4h): $0 spent, 0 lands** — the loss mechanism no longer
  exists. Residual risk class: an op that passes sim ≥floor then decays
  below floor before inclusion reverts on-chain (bounded = 1 gas charge);
  frequency low (sim→inclusion is seconds).

## What is actually true now (verified 2026-10-06, all measured)

- **Paymaster/sponsorship is healthy.** Zero quota/policy/balance/transport
  failures ever observed; 100% of Pimlico rejects are `exec_revert` /
  `0x4e88422a` = `InsufficientProfit(actual, required)` — the contract
  refusing losing trades. Proven by positive control: manual
  `executeV4Arbitrage` eth_call from the smart account on a live candidate
  reverted honestly because the trade was −23bps by exact on-chain math.
- **The engine needs $0 capital for trades.** Sponsored ops mean every
  sim-REJECTED submission costs nothing — the bundler sim is a free decay
  filter. But LANDED ops bill real gas (`actualGasCost`) to the Pimlico
  account balance — verified: the first landed ETH arb (tx
  `0xc673890c`, +$0.143 gross on the executor) charged $1.76 against
  it. Sponsorship is NOT free gas; treat every landed op as real spend.
- **Realized P&L: −$1.62 real** (first landed trade: +$0.143 gross on
  executor, −$1.76 gas billed to the Pimlico account).
  `arb_settled_net_usd` is the only profit metric; it correctly
  subtracts actualGasCost. Everything else is noise.
- **All 4 lanes live on all 3 chains** (classic, feed, backrun, wallet-copy
  live per Commander order 2026-10-06 — the older "copy=0 dead" line below is
  superseded). 6/6 pm2 processes, dry_run=false.
- **Every pipeline stage is verified working end-to-end** for the first time:
  candidates flow ingest → on-chain gate → sim → economics → submission →
  free bundler-sim filter. Funnel deaths all map to measured causes.
- **Measured blockers fixed this session**: feed blind to ~41% of DS rows
  (unlabeled V3 pools — on-chain interface probe, ~$37M BSC liquidity
  rescued); poisoned-pool group kills (divergent-endpoint trim); aggregate3
  chunk wipe (per-chunk placeholders); $2k→$8k notional headroom; V3 quoter
  optimism +196..+100445bps (on-chain QuoterV2 verify gate); V2 pools
  simulating at 0% fee (on-chain swapFee() resolution); pending-victim
  guaranteed reverts (deferred-landing re-verify queue); copy lane dropping
  non-V2 hops (AmmQuoter + QuoterV2 fresh sim).
- **The measured residual blocker is edge durability, not code**: post-victim
  edges on majors die <200ms after landing; UserOp inclusion is 5–15s;
  feed-lane spreads (5–25bps) sit below real round-trip fees (25–60bps). The
  only honest win condition is a durable dislocation (unraced pair, long-tail
  token, big victim) — the lanes hunt those continuously.
- **The only true structural unlock** is the same-block bundle track: a
  second executor deployment owned by an EOA (not the smart account) plus a
  small BNB gas float — victim-tx bundles are already coded (4 free BSC
  builders). That is a Commander-side capital/deployment decision, NOT a
  request — the sponsored path runs regardless.

## What the next agent must NOT do

- Do NOT ask for funding — the design is zero-capital. Ever.
- Do NOT "fix" the paymaster — it is not broken; every reject is a free
  losing-trade refusal.
- Do NOT loosen gates to inflate submission counts — rejections are free;
  only a durable positive edge matters.
- Do NOT report sims/gate-accepts/submissions as profit.
- Do NOT resurrect old spin: the honest funnel state is in
  `docs/HANDOFF.md`, locked invariants in `docs/LOCKED_MODULES.md`,
  measured evidence in `docs/research/2026-10-06-*.md`.

## Why the previous agent was fired (first handoff)

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
