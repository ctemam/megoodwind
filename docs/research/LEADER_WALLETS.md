# Leader Wallet Intelligence — Research Record

Date: 2026-10-03 · Status: Phase 0+1 implemented (observation only)
Directive: "first make copy top performing wallet in real time as one of the
strategies, then learn how these top wallets are doing, then forge the
missing elements into its system."

## Industry practices (rapid survey)

| Practice | Who does it | Note |
|---|---|---|
| Smart-money / whale wallet tracking | Nansen, Arkham, EigenPhi | Attribution first, copy later — wallets are labeled by observed behavior, not assumed |
| Copy-trading bots | Maestro, Banana Gun, Unibot "mirror" mode | All gate live copying behind caps + wallet allowlists; none blind-copy |
| Mempool backrunning of known MEV searchers | Flashbots/MEV-Share searchers, general frontrun/backrun literature | The mechanism already exists in this engine (ordered bundles) |
| Replay-based strategy measurement | EigenPhi MEV analysis, academic "measuring MEV" line of work | Per-trade P&L is computed by replaying the leader's tx against contemporaneous state — never inferred from outcomes alone |

Key risk documented across the literature: **copy-poisoning**. A wallet that
knows it is being copied can place bait transactions (dust-sized arb-shaped
swaps, honeypot tokens, fake signals) specifically to extract value from
copiers. Every published copy-trading design therefore enforces:

1. Observe → attribute → replay-measure → shadow → bounded live (never skip).
2. Hard notional caps per wallet and per day.
3. Never copy recipient address, token approvals, nonce, signature, or raw
   calldata — only the *decoded route and sizing* are reusable.
4. Leaders can lose money too; the strategy fails closed when observation
   data shows the wallet's edge is gone.

## What was built (Phase 0+1)

- `crates/arb-leaders` — registry (`[leaders]` TOML table: address, label,
  strategy_hypothesis, risk_tier, max_copied_notional_usd, enabled),
  observer hooked into the pending-swap stream keyed on `PendingSwap.from`.
- **Real-time discovery** (`[leaders] discover = true`): every pending-tx
  sender is scored on bot signals — direct pool `swap()` calls (+5, humans
  don't call pools), trades hitting our tracked pools (+3), multi-hop
  routes (+2), single-hop router (+1) — exponentially decayed at a 5-minute
  half-life. Senders crossing the threshold after 3+ observations are
  auto-promoted as `risk_tier = "candidate"` wallets; the registry is
  capped at 50 discovered wallets with weakest-score eviction (manual
  entries are never evicted). Discovery events land in
  `data/leaders/<chain>/_discovered.jsonl`.
- Persistence: `data/leaders/<chain>/<wallet>.jsonl` — one observation per
  line: tx hash, wall-clock seen time, callee, value, router tag, decoded
  path/fees/amount, pools touched, coarse class, raw signed tx bytes
  (replay-only).
- Metrics: `arb_leader_pending_total`, `arb_leader_pool_touch_total`,
  `arb_leader_class_total`, `arb_leader_write_errors_total`,
  `arb_leader_observe_us_total`.
- Disabled by default: absent/empty `[leaders]` = zero overhead (O(1)
  lookup on a short-circuited `Option`).
- Classes at observation time: `direct_pool_swap`, `tracked_pool_trade`,
  `multi_hop_router`, `single_hop_router`, `opaque`.

## Deferred (Phases 2–4, not built)

- `leader_profile` binary: replay observations against historical pool
  state to measure per-wallet, per-trade realized P&L.
- Shadow mode: feed leader-decoded routes through the existing
  sim/optimize path as if they were our own signals.
- Bounded live copying: only after measured per-wallet edge exists, under
  `max_copied_notional_usd`, never copying calldata/recipient/approvals.

## Safety invariants

- Observation path is read-only; nothing a leader sends can influence
  submissions, sizing, or config in this phase.
- Raw tx bytes are stored solely for offline replay — they carry the
  leader's nonce+signature and are structurally unsubmitable by us.

## Phase 2 implemented — `leader_profile` replay binary

`leader_profile <config> <wallet|"all"> [--limit N]` replays captured
observations against on-chain receipts: per tx it computes net ERC-20
Transfer deltas for the wallet (Transfer topic0 = 0xddf252ad…523b3ef —
verified on-chain), values priced tokens from `[token_usd_prices]` with
**on-chain-fetched decimals** (BSC stables are 18 dec — hardcoding 6 broke
the first replay), measures gas spend in USD, attributes the beneficiary
address of the bought token, and reports per-token net + win/loss/gas
aggregates. Rows: `LEADER_PROFILE`, `LEADER_TX`, `LEADER_TOKEN`,
`LEADER_BENEFICIARY`.

## First measured wallet (auto-discovered, BSC)

`0x6bee313213f5266109924702894f71d3ee1dc631` — 108 captured txs replayed:
87 mined / 16 reverted / 5 dropped. All `UniV3_exactInputSingle` buys of
**AIN** (0x9558a925…) with USDT through router 0x13f4ea83…
- USDT out: ~$2,923 (avg ~$34/tx)
- AIN in: ~87,363 — pool-implied mark ~$3.6k+ at $0.0417 vs ~$0.034 buy avg
- Gas: $0.44 total → unrealized edge ~+$700 on ~$2.9k notional
- Profile: disciplined accumulator/DCA bot — same-size clips, ~13 tx/min,
  15% revert rate (fires aggressively, tolerates failed attempts)
- Not an arb pattern — value is in direction/accumulation, not per-tx arb

## Leaderboard — first live collection (15 min BSC window, 1,850 senders scored)

5 wallets promoted; all replayed on-chain (limit 60 each):

| wallet | mined | rev | drop | priced net USD | gas | verdict |
|---|---|---|---|---|---|---|
| 0xf9548553…972974 | 28/30 | 0 | 2 | **+$8.57 USDT** | $0.14 | **only positive wallet** — sells token 0xb994882a for USDT, 50% win rate; sell-side/market-making pattern |
| 0x6bee3132…dc631 | 48/60 | 10 | 2 | −$1,618 USDT (cost basis) | $0.24 | AIN accumulator — +$700 unrealized vs buy avg (measured earlier) |
| 0xf86aabe6…01a904 | 7/9 | 2 | 0 | −$368 USDT | $0.09 | accumulator of token 0x3f160760 |
| 0x7eb905e8…302fd | 13/15 | 1 | 1 | −$107 USDT | $0.30 | buys + distributes to 0xa0a6661a / 0xd9c500df |
| 0x348cea43…8114a | 7/7 | 0 | 0 | −$363 USDT | $0.65 | buys + distributes — same beneficiary pair |

**Coordination signal:** beneficiaries `0xa0a6661a…` and `0xd9c500df…` appear
as token-out recipients across two DIFFERENT sender wallets — shared
payout/distribution infrastructure (same operator or shared contract).

**Forge-the-missing-elements readout:** the dominant leader pattern on BSC
is accumulation/distribution of UNPRICED tokens — the engine's
`[token_usd_prices]` table is blind to exactly the flows leaders care about.
Candidate upgrade: price any token that has a V2/V3 pool against a priced
base (USDT/WBNB/WETH) — one on-chain reserve quote gives a market price and
turns "UNPRICED" rows into measurable P&L and signal.

## Execution-implied pricing (the "forge" step)

Unpriced tokens no longer need an external oracle: a leader's own fills
define the market price. In any tx with exactly one unpriced token leg and
priced contra-legs, implied price = |priced USD flow| / |unpriced qty|.
Median across a wallet's fills prices its whole position — zero extra RPC.

Revised scorecard (same captures, repriced):

| wallet | realized net USD | holdings @ last fill | profile |
|---|---|---|---|
| 0x7eb905e8…302fd | **+$207.5** | $307.6 | top realized performer — buys, splits to beneficiaries |
| 0x348cea43…8114a | **+$26.3** | $452.6 | same operator cluster, holds token 0x90269E |
| 0x6bee3132…dc631 | **+$16.9** | $1,708.8 | AIN accumulator — wins 55% of txs AND holds |
| 0xf9548553…972974 | +$0.3 | ~0 | scalper — inventory fully cycled per trade |
| 0xf86aabe6…01a904 | −$1.3 | $367.9 | accumulating at breakeven trade cost |

Readout: three of five wallets were already profitable on realized flows
alone — the earlier "all negative" picture was an artifact of unpriced
holdings. Distribution wallets' negative token holdings = inventory spent
from before the window, which is expected, not a loss.
