# Elite Flash-Arb Latency: Top-3 Systems Reverse-Engineered

Research pass ordered by Commander (2026-10-05). Goal: what the top
flash-loan / backrun systems actually spend their latency budget on, and
which of those levers allbright can pull on free public infrastructure.

## The three systems

### 1. Jaredfromsubway.eth — highest-public-profit MEV bot

- $6.3M profit in ~3 months (EigenPhi, 2023); present in >60% of Ethereum
  blocks at peak; 98% of its txs are sandwich + backrun bundles.
- **Latency model**: not a microseconds race — it wins inside the 12s
  slot cycle by *bid aggressiveness*. It overpays gas to guarantee
  builder inclusion and does not tip builders directly; the edge is
  "always in the block", not "first to compute".
- **Takeaway**: inclusion probability can be bought with gas priority.
  For a bot losing races on detection speed, part of the answer is
  economics, not nanoseconds.

### 2. aether (Pablosinyores/aether) — production OSS arb engine

- Advertised "sub-millisecond opportunity detection" on mainnet.
- Architecture: Rust detection (Bellman-Ford/SPFA, SIMD math), `revm`
  fork-mode simulation over `AlloyDB`, `DashMap` pool store fed by
  WebSocket reserve updates, `redb` disk bytecode cache, Alchemy
  `alchemy_pendingTransactions` mempool stream, Go bundle submission to
  Flashbots.
- **Key structural choice**: the sim is a *local* EVM fork. No eth_call
  network round-trip on the hot path — sim cost is ~µs because state is
  already in-process.

### 3. mev-engineering-stack (Faraone-Dev) — benchmarked reference

- Published per-stage numbers: classify 40ns → detect 120ns → AMM math
  220ns → bundle build 53ns; **full compute pipeline ~608ns, p999 ~2.3µs,
  network excluded**.
- Two-stage sim: constant-product fast filter (~35ns) rejects almost
  everything; only survivors pay the revm fork (~50–200µs).
- On Arbitrum (no public mempool) it classifies per-block transactions
  by 4-byte selector — i.e. it works with the data it actually has.

### Also relevant: bloXroute BackRunMe / arbOnlyMEV

- Private-transaction backrun stream on ETH, BSC, Polygon, Base — orderflow
  invisible to the public mempool; searchers submit backrun-only bundles.
- Relay-measured ingestion latencies (Flashbots BuilderNet criteria):
  Ultra Sound ~1ms, bloXroute ~3ms, Flashbots relay ~279ms. Geography +
  private transport dominate the *transport* budget.
- Cloud API free tier exists but requires an account/authorization
  credential (user-side signup) — not available from this box today.

## Allbright's measured budget (live, this box)

| Stage | Measured | Elite reference |
|---|---|---|
| Mempool poll → queue | ~5ms | ~ms (WS push) |
| Pass A CPU eval (all victims) | ~µs | ~600ns–µs |
| Merged MC3 refresh (≤256 pools) | ~300–700ms | state kept warm via WS, ~0ms marginal |
| Receipt batch | overlapped w/ refresh | — |
| Exec probe `eth_call` | ~300–500ms/candidate | local revm fork ~50–200µs |
| **pending → eval** | **~1.03s avg** | — |

The compute is already at elite level. The two network RTTs (refresh +
eth_call probe) are ~90% of the critical path.

## Decision: what transfers, on free infra

1. **Local in-process simulation for the exec probe** (aether's core
   move). Replace the `eth_call` probe with a revm/AlloyDB-style local
   fork warmed by the same store the refresher maintains. Probe cost:
   ~300–500ms → tens of µs. Pure software — no paid infra. This is the
   single largest remaining latency item.
2. **Bid economics over raw speed** (Jaredfromsubway). Once detection is
   fast, inclusion is won on gas priority + private-venue submission
   (already armed via builder venue + Pimlico 4337).
3. **Top-path-first refresh**: refresh the best candidate's 2 pools
   before the merged batch — first submit lands ~200-400ms earlier.
4. **Geography** (Frankfurt): eu-central puts bloXroute BDN, most BSC
   builders and RPC PoPs at single-digit ms RTT vs ~100–250ms now.
   Requires a user-provisioned VPS — flagged, cannot self-provision.
5. **Private orderflow** (arbOnlyMEV): requires a bloXroute account
   credential — flagged to Commander as an option, needs signup.

## Non-transferable / out of scope

- Sandwiching/front-running — excluded by mandate regardless of profit.
- Paid RPC tiers (Alchemy pending stream, BDN) — excluded by mandate.
- Valid items that remain free: local sim, batching, regional VPS,
  bloXroute *free* Cloud API tier.
