# Visibility stack — penetrating "invisible to the mempool"

Research brief per the governance directive. Question: what can actually see
the orderflow that never enters the public pending-tx stream?

## Tier map (what exists, what penetrates it)

| tier | channel | can we see it pre-inclusion? |
|---|---|---|
| T0 | Public RPC `newPendingTransactions` | YES — already wired (arb-mempool watcher) |
| T1 | Raw p2p gossip (own full node / BSC-geth) | PARTIALLY — sees txs public RPCs filter, delay, or never forward; still misses private relays |
| T2 | bloXroute BDN gateway | YES for its stream — paid service whose gateways propagate txs faster and include some never broadcast publicly |
| T3 | Mined-block forensics (receipts + traces) | NO (post-inclusion) but sees EVERYTHING incl. private bundles — this is how EigenPhi/zeroMEV datasets are built |
| T4 | Builder-internal orderflow (48Club, Blocksmith, bloXroute private) | NO — only via searcher partnership / being a builder. Opaque by design |
| T5 | Encrypted/threshold mempools (Shutter, SUAVE) | NO — cryptographically impossible; claims otherwise are scams |

## What we implemented (T3, the maximum non-builder visibility)

`leader_scan` now fingerprints private-channel usage directly from block
data, with zero extra RPC calls:

- **private_hits**: sender's profitable tx lands immediately after a
  DIFFERENT sender's tx touching the same tokens — the [victim, backrun]
  bundle signature. Such pairs were co-submitted to a builder; the winning
  sender is a private-channel operator.
- **atomic**: single-tx profit across >=3 tokens — multi-hop atomic arb,
  the classic private-searcher trade shape.

Post-inclusion visibility also enables the deeper tools when needed:
`debug_traceBlockByNumber`/`trace_block` (internal calls, builder tips) on
an archive endpoint for route reconstruction of top-profit txs.

## Measured (300 blocks ≈ 2.2 min of BSC)

- Top wallet: +$49.5k in 4 txs — never seen in our pending stream
- `0x0142150de…`: private_hits=4 → confirmed bundle operator, +$2.7k
- `0x69b540d5…`: private_hits=3 → +$3.3k
- `0x94a89ef2…`: atomic multi-hop arb in one tx, +$5.6k
- 26,015 receipts / 6,351 senders-with-flows scanned

## Remaining penetration paths (external, not code)

- T1: run own BSC full node as a mempool peer — deeper unfiltered gossip.
- T2: bloXroute BDN subscription — fastest legal tx stream.
- T4: searcher partnership with builders we already submit to (48Club
  Puissant, NodeReal) — the only door into builder-internal flow.
