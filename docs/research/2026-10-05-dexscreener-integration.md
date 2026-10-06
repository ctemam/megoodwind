# DexScreener → flash-arb integration: how profitable operators use the feed

Commander order: research how others filter DexScreener arbitrage
opportunities and execute; find our knowledge gap; adopt existing tools —
no new wheels.

## Findings (industry practice)

1. **Feeds are discovery, not pricing.** Every working DS/GT arb pipeline
   (community bots, ARBSCAN-style scanners, dsfeed-triangular-arb repos)
   uses the feed for exactly three things: pool *addresses*, liquidity,
   and volume/activity filters. Reported prices are CDN-cached (~30s+,
   per-pool staleness varies), so comparing `price_native` across two
   pools mostly measures *relative cache staleness*, not a real spread.
2. **Pricing is always chain-side.** Filters gate on reserves/sqrtP read
   from chain state — the same state the execution sim will see. Tools
   used: Multicall3 batched reserve reads, `eth_call`/`eth_simulateV1`
   pre-broadcast probes, and venue-side sim (mev_simBundle) where a
   bundle relay exists.
3. **Filter order everyone uses:** liquidity + activity + dex-version +
   honeypot/bait conviction FIRST (all cheap), then on-chain spread gate,
   then size optimizer, then chain-truth probe before broadcast. The
   spread gate never sees API prices.
4. **Execution is the same ladder everywhere:** local quote → gas-aware
   floor → probe → broadcast; private venues where available.

## Repo impact (the gap found)

`feed_lane.rs` sorted each ≥2-member pair-group on the **feed-reported**
`price_native` — violation of finding #1. Consequences measured on the
live fleet: phantom candidates that die at `fresh_sim_fail`, and real
on-chain divergences rejected as `below_spread`. Every other stage
already matched the industry shape (MC3 batched refresh, two-pass
verify, chain-truth probe, bait convictions).

## Decision

Restructured the gate to the canonical pattern: register + batch-refresh
all ≥2-member pair-group pools FIRST, then compute each pool's price from
`PoolStore` state — V2/AeroV2 by reserve ratio, V3 by sqrtP² with
token-order orientation — then sort, spread, and `verify_and_submit`
unchanged. No new dependencies, no new tools: it uses the refresher/MC3
pipeline we already have.

## Verification

- `onchain_price_orientation_v2_and_v3` regression test (V2 ratio both
  directions, V3 sqrtP² both directions, unknown-pool exclusion).
- Watch `feed_candidates`/`fresh_sim_fail` mix after restart: phantom
  candidates should drop and real on-chain spreads should surface as
  gate accepts.
