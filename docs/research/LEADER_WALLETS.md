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
