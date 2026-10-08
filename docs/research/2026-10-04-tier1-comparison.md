# allbrightA vs tier-1 open-source flash-loan / MEV arbitrage bots

Date: 2026-10-04. Commander order: thorough research comparison of
allbright's two strategies vs the top three tier-1 open-source
arbitrage apps, in a table.

Reference bots chosen [research — verified project sources]:

- **Paradigm `artemis`** — the canonical Rust MEV framework
  (collector → strategy → executor pipeline); most production searchers
  are built on this pattern or derivatives of it.
- **`rusty-sando`** (mouseless0x) — the reference competitive sandwich
  bot: Rust + Huff executor, multi-meat sandwiches, concurrent local
  EVM simulations, salmonella (anti-poisoning) checks, token-dust gas
  optimization, Flashbots bundles.
- **Hummingbot** — the dominant open-source arbitrage *application*
  (V2 `ArbitrageExecutor` / AMM-arb): cross-market CEX↔DEX and DEX↔DEX
  two-leg arb with own-inventory capital, order tracking, profit
  netting of tx costs.

Honorable mentions not tabulated: `subway`/`subway-rs` (sandwich
reference whose ideas rusty-sando generalizes), flashbots
`simple-blind-arbitrage` (on-chain-sized blind backrun vs MEV-Share —
a legitimately different sizing model, noted in findings).

## Comparison table

| Axis | allbrightA classic | allbrightA wallet-intel | artemis (+ production derivatives) | rusty-sando | hummingbot |
|---|---|---|---|---|---|
| Strategy class | Resting-state cyclic arb + mempool backrun | Leader-wallet discovery → shadow → bounded-live route reuse | Framework only; shipped example is NFT cross-market arb | Generalized sandwich (V2/V3, multi-meat) | Two-leg cross-market arb (CEX↔DEX, DEX↔DEX) |
| Signal source | Block-triggered pool refresh + pending-tx decode | Pending-tx stream classified by wallet; offline mined-P&L scans | Any (pluggable collectors) | Pending mempool txs | REST/WS exchange quotes |
| State model | Local store; reader+Multicall3 extsload incl. V4 | Same store + per-wallet evidence JSONL | Up to strategy impl | Concurrent local REVM sims | Connector quote polling |
| Trade sizing | Ternary-search optimal flash amount per path | Verified route geometry + own sim amounts | Up to strategy | Simulated optimal frontrun size | Fixed `order_amount`, quoted both legs |
| On-chain sizing option | No (sizing off-chain only) | No | n/a | No | No — *contrast: flashbots `simple-blind-arbitrage` sizes ON-chain so state drift can't invalidate the bid* |
| Execution path | Flash-loan executor contract + venue fan-out (4 bundle venues + Warp/Blink/Direct + Pimlico 4337) | Same execution path via opportunity bridge | Executors pluggable (Flashbots bundles, mempool, orders) | Huff contract + Flashbots bundles | Exchange order APIs |
| Ordering control | `[victim, ours]` bundles to ordering-aware venues | n/a | Yes (bundle executor) | Yes (Flashbots bundle position) | None (cross-venue latency risk instead) |
| Private orderflow | Env-gated WSS sources (wired, no key yet) | Same watcher | MEV-Share/direct feeds | Public mempool only | n/a |
| Capital model | Flash loans (0 capital) | Same | Any | Own ETH inventory | Own inventory both legs |
| Chain coverage | BSC live; ETH/Polygon/Base scan | BSC+ETH+Polygon observation | Ethereum-centric | Ethereum | 50+ venues incl. DEX chains |
| Verification layer | Sham-pool provenance, outlier quarantine, victim-bound cap, exec-probe eth_call, net-of-gas gate | StrategyRegistry lifecycle + auto-demote on settled loss | None built-in | Salmonella checks + local sim | Tx-cost netting only |
| Wallet intelligence | n/a | Full pipeline (classify→discover→scan→merge→lifecycle) | None | None | None |
| Gas economics | net-of-gas profit floor since 69dcbd3 | inherits gate | n/a | Dust storage + Huff gas micro-opt | Explicit gas in profitability calc |
| Weakness vs peers | No on-chain sizing fallback; public-RPC latency floor | Coverage-limited (wallets must broadcast visibly) | Framework ≠ product | No cyclic/3-hop arb; toxic flow only | No bundles/MEV ordering; legs not atomic |

## Findings

- **Where allbright is ahead of all three**: the wallet-intelligence
  pipeline (auto-discovery → realized-P&L ranking → lifecycle gating)
  has no counterpart in any open-source bot — tier-1 searchers do this
  privately; none publish it. `artemis` requires you to write the
  strategy entirely; `rusty-sando` is a single vertical.
- **Where allbright matches the top tier**: executor-side fan-out to
  four ordering-aware bundle venues + ordering-correct backrun bundles
  is the rusty-sando / flashbots-searcher pattern; the anti-phantom
  defenses (sham-pool provenance, victim-bound cap, implausibility cap)
  exceed anything shipped in the public bots.
- **Where the tier-1s beat allbright**:
  1. `simple-blind-arbitrage`'s *on-chain* sizing model is immune to
     our observed state-staleness floor — off-chain sizing + ~59ms
     public-RPC reads is the structural reason resting-state arb dies
     on BSC for us.
  2. `rusty-sando`'s concurrent REVM simulation fleet evaluates
     candidates at mainnet-fork fidelity — richer than our exec-probe
     (which sims the executor call but not alternate placements).
  3. `hummingbot`'s breadth (CEX connectors) opens spreads we structurally
     cannot see (DEX-only chain state).
- **[assumption]** The four bundle venues allbright fans out to are
  the practical BSC equivalent of Flashbots-bundle submission on ETH;
  relative win-rate vs private searcher relays is unmeasured.
- **[unknown]** Whether BSC sandwiching via rusty-sando's model is
  viable on our chain set — sandwich economics on BSC (builder/relay
  fragmentation) were not measured here.

## Repo impact

No code changes. This is an analysis document; concrete leverage points
it suggests (on-chain sizing option, REVM fork sims, free MEV-Share-style
orderflow where available) are candidates for a future Commander order.
