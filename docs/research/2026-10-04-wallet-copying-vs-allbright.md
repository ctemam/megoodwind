# Deep-dive: top-ranking wallet-copying strategies vs allbright

Date: 2026-10-04. Research only — no code changes.

## How the top systems work (industry pass)

The leading smart-money / copy-trading products share a 7-stage pipeline:

1. **Wallet discovery & scoring.** Nansen labels Smart DEX Traders by
   realized PnL ($1.5M+ cumulative for all-time label = top 0.1%), ROI,
   win-rate, number of profitable tokens, and consistency across 30/90/180d
   and 2Y windows; <0.01% of wallets earn a label. Arkham, WalletFinder,
   OKX Smart Money do the same with entity clustering (funds, KOLs,
   insiders). [verified]
2. **Detection layer.** Continuously watch tracked wallets: websocket feeds
   + polling fallback + dedup + reconnection + event ordering. The signal
   *is* the wallet acting — price indicators are only used as confirmation.
   Multiple independent detection channels are standard because single
   feeds fail. [verified]
3. **Copy filters.** Whitelist/blacklist tokens, max size per copy, min
   liquidity, and — critically — safety gates the arb world doesn't need:
   honeypot simulation (can the token be sold?), buy/sell tax %, owner
   privileges, LP lock, holder concentration, dev-wallet funding links.
   Verdict tiers: OK / CAUTION / HIGH_RISK / AVOID. [verified]
4. **Position sizing.** Fixed USD per copy, or proportional to the target's
   trade relative to bankroll — never the target's absolute size. Underfunded
   buy wallets mark `failed: insufficient_balance` rather than fake a fill.
   [verified]
5. **Execution race.** Copy latency directly shifts fill price (~5s delay =
   meaningfully different fill). EVM copiers aim for same-block or
   next-block landing; serious ones submit via private/bundle channels so
   the copy itself isn't sandwiched. [verified]
6. **Independent exit logic.** The #1 failure mode: the source wallet may
   scale out over many txs, hedge off-chain, or tolerate drawdowns a copier
   can't. Top systems run their own TP/SL, trailing stops, time stops, and
   partial-exit ladders — the source is an entry signal, not an exit signal.
   [verified]
7. **Feedback loop.** Per-wallet realized PnL attribution, attempted vs
   submitted vs filled with skip-reason telemetry, wallet demotion/re-scoring
   when performance decays, detection of "exit liquidity" patterns (wallet
   farming its followers). [verified]

## Where allbright already stands

allbright is an atomic flash-loan arbitrage + mempool-backrun engine, not a
copy-trader — but its substrate covers most of stages 2 and 5:

- **[repo evidence]** Mempool watcher streams full pending txs
  (`PendingSwap { raw_tx, decoded, seen_at }`) — same detection primitive a
  copy lane needs, minus the wallet match.
- **[repo evidence]** Backrun lane already does the "react to another
  wallet's swap, land right after it" mechanics: `pool_to_paths` impact
  projection, targeted `refresh_pools`, `[victim, ours]` ordered bundles via
  bundle venues — i.e., same-block copy execution infrastructure exists.
- **[repo evidence]** ProfitGate, presigned template pool, venue router,
  circuit breakers, quarantine, Prometheus stage metrics — the submission
  and safety skeleton is in place.
- **[repo evidence]** Latency work just landed: parallel eval, backrun lane
  joined with refresh — the copy race benefits directly.

## Missing gaps for a wallet-copying lane

1. **No wallet registry or scorer.** Nothing stores tracked wallets,
   labels, stats, or decay. Needed: a wallet table (address, label, window
   stats, score), ingestion from a PnL source (or self-computed scoring over
   DEX-trade history), and periodic re-ranking. [repo evidence: absent]
2. **No wallet-attribution filter in the watcher.** `PendingSwap` isn't
   matched against a tracked-wallet set — every pending tx is treated as a
   generic victim. Adding `tx.from ∈ watchlist` membership is cheap
   (HashSet lookup on decode). [repo evidence]
3. **No inventory/position model.** allbright is atomic: borrow–trade–repay
   in one tx, zero held positions. Copying means buying a token with real
   capital and holding it — requires a bankroll wallet, positions table,
   cost basis, mark-to-market. This is the largest architectural delta.
   [repo evidence]
4. **No token-safety gate.** Atomic arb never holds the token, so honeypot/
   tax/LP checks were never needed. A copy lane must simulate the sell
   (or use a GoPlus-style verdict) before every buy. [repo evidence]
5. **No exit manager.** No TP/SL, trailing stops, partial-exit ladders, or
   time-based position ageing. The backrun lane exits atomically; a copy
   position needs its own sell logic independent of the source wallet.
   [repo evidence]
6. **No per-source attribution metrics.** Metrics key on stage/venue/
   outcome, not on *which wallet generated the signal* — required for the
   demotion/re-scoring feedback loop. [repo evidence]
7. **Sizing engine mismatch.** `find_optimal_amount` sizes flash borrows
   for arb edge; copying needs bankroll-relative sizing (fixed-$ or
   proportional-to-target), plus per-copy caps. [repo evidence]
8. **Conceptual overlap to exploit.** The backrun lane already *is* a
   one-block copy strategy — it reads a victim's intent and trades the
   aftermath atomically. A full copy lane generalizes it: same detector,
   same bundle execution, new signal source (wallet watchlist), new state
   (positions), new risk layer (token gate + exit manager). [assumption —
   architecture reading]

## Summary

- allbright's detection + same-block execution stack is roughly 70% of a
  copy-trading engine.
- The missing 30% is everything that comes *after* detection: who to
  follow (scoring), whether it's safe (token gate), how much (sizing),
  and when to get out (exit manager) — all stateful, all absent today.
- Constrained by free public RPC: wallet-scoring data must come from a
  free feed (e.g. OKX Smart Money signals, self-computed from public
  swaps) — no paid Nansen/Arkham API.
