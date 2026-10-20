# skill.md — AllBright mathematical toolkit (Item #19)

## Price & quote math (`src/math/`)

- **V2 constant product** — `v2AmountOut(in, {reserveIn, reserveOut}, feeBps)`
  = `in*(10000-fee)*rOut / (rIn*10000 + in*(10000-fee))`. Reserve orientation
  by `token0` match, never by feed ordering.
- **V3 spot** — `v3SpotPrice(sqrtPriceX96, dec0, dec1)` = `(sqrt/2^96)^2 * 10^(dec0-dec1)`.
  Screening approximation multiplies by `(1 - fee)`; final arbiter is the exec-probe.
- **Tick-walk guard** — skip legs whose swap crosses >`MAX_TICK_DISTANCE` (200)
  ticks; beyond that the constant-liquidity approximation breaks (ToR §2).

## Profit constraint

```
net_usd = gross_token_usd
        - (gasUnits * (baseFee + priorityFee) / 1e18) * native_usd   # EIP-1559
        - flashPremium_usd                                          # Balancer 0, Aave 0.09%
        - auction_bribe_usd                                         # AUCTION_CHAINS only
```

- `auction_bribe = (gross - gas - premium) * COINBASE_BRIBE_PCT_MAX` — worst-case
  builder tip deducted BEFORE the floor (honest capturable-net).
- Floor: `net_usd >= MIN_PROFIT_USD` and `STRICT_PROFIT_FLOOR_GUARD` blocks any bypass.
- EIP-1559 circuit breaker: dormant above `MAX_BASE_FEE_GWEI` (300).

## Dynamic Graph Discovery — Bellman-Ford pathfinder (`src/strategies/graph.ts`)

The pathfinder matrix is constructed entirely at runtime: nodes are tokens
pulled from token-list streams / creation events, edge weights come from
live pool state. No token is ever hardcoded.

```
rate(u→v) = normalized_out_per_in * (1 - feeBps/10^4)
  v2: (rOut/10^decOut) / (rIn/10^decIn) * (1 - fee)
  v3: (sqrt/2^96)^2 adjusted for direction * (1 - fee)
weight(u→v) = -ln(rate)
negative cycle ⇒ Π rates > 1 ⇒ arbitrage cycle
```

- Edges are built from `registry` pools with fresh `reserve`/`sqrtPriceX96`
  state; decimals come from token lists or `IERC20.decimals()` — applied
  dynamically per token, never assumed.
- BF runs per top-degree anchor with `MAX_DEPTH = 4` — O(anchors·E), CPU-only.
- Cycle extraction via parent-chain revisit; signature dedupe by sorted
  pool addresses; closed-loop validation (`first.tokenIn == last.tokenOut`).
- Cycles map to strategy families: 2-hop → P01, ≥3-hop → P02.
- Borrow tokens without a USD reference are skipped — an unpriced leg
  produces dishonest net math.

## Predictive drift (item #16)

Variants define `slippageBps / minDepthUsd / maxBlockDelay / sizeCapUsd`;
`effectiveGuards()` merges env floors — a variant may only tighten, never loosen.
Projected price is discounted by `slippageBps` before profit check.

## Credibility ceiling

Simulated spreads > ~2% on top-liquidity pairs are fake (`CREDIBILITY_CEILING_PCT`).
A candidate over the ceiling convicts every pool in the path.

## Provider Key Expansion — one key, every chain (`src/providers/providerCatalog.ts`)

Doctrine (measured 2026-10-20): a provider API key is an ACCOUNT credential —
one key serves every chain that provider carries. Per-chain access is a
URL-slug transform, never a per-chain key. Expansion = `key + slug -> endpoint`.

| Provider | HTTP template | WSS | Free budget (docs) | Verified traps |
|---|---|---|---|---|
| dRPC | `https://lb.drpc.org/ogrpc?network=<slug>&dkey=<key>` | ogws variant, live on all 10 | 210M CU/30d, ~100 eth_call/s nominal (min ~40 under load), batch ≤3 | free plan = public-node class; code-15 quota errors nest inside ethers `could not coalesce` — scan the whole error tree |
| Alchemy | `https://<slug>.g.alchemy.com/v2/<key>` | wss same path | 30M CU/mo, 300 CU/s (~15 rps), 10s token bucket, account-wide | `403 "<NET> is not enabled for this app"` = per-app network toggle OFF in the Alchemy dashboard — operator fix, NOT a key/template defect. Same key serves all chains once enabled |
| Ankr | `https://rpc.ankr.com/<slug>/<key>` | none on Freemium | 30 req/s, 200M credits/mo | do NOT derive wss URLs — HTTPS-only on free |
| NodeFlare | `https://rpc.nodeflare.app/<slug>/v1/<key>` | `/ws/v1/` on eth/base/bnb/arb/op/avax only | ~2–3M CU/mo (docs disagree — use min), 10 req/s | poly WSS 404s at this tier; slug `bnb` not `bsc` |

Slug tables live in `PRIVATE_PROVIDERS[].slugs` — the catalog, not memory.
A chain absent from the map = provider does not serve it at this tier —
excluded, never guessed.

### Expansion rules

1. `ALCHEMY_API_KEY=<k>` alone provisions all 10 chains — the loader calls
   `keyedEndpointsFor(chain)` and dedupes against explicit `<CHAIN>_RPC_URLS`.
2. Probe `eth_chainId` per generated URL before counting capacity — a
   `403 not enabled` is a config flag on the provider side, a chainId
   mismatch is a wrong slug, a 401/404 is a dead key. Classify, don't guess.
3. Rate limits bind per ACCOUNT KEY. Two same-key URLs = zero headroom —
   the pool groups members by account (`providerOf()`) and gives each group
   ONE token bucket at `doc_rps × 0.9`. Cross-provider diversity is the only
   real capacity lever; same-account failover is self-amplifying churn.
4. Daily budget (uniform draw): `cuPerMonth / 30 / cuCost[method]` — e.g.
   Alchemy free ≈ 38k eth_call/day, dRPC ≈ 350k, Ankr ≈ 6.6M, NodeFlare ≈ 66k.
   `eth_getLogs` and trace/debug cost 3–8× simple calls — reserve them.
5. Fleet totals (measured 2026-10-20): **~86 req/s safe across 4 accounts,
   ~7.1M req/day, ~214M req/month** — request-level. On multicall paths the
   view-call effective capacity is ~200× (aggregate3 = 1 request per ≤200
   subcalls ≈ ~1.4B subcall-equivalents/day). Quota arithmetic is per
   REQUEST to the provider — subcalls inside one aggregate3 don't hit the
   HTTP rate limiter, only the node's eth_call gas cap.

## Multicall3 request algebra (`src/providers/multicall.ts`)

Canonical `0xcA11bde05977b3631167028862bE2a173976CA11` on all 10 chains.

```
N view calls -> 1 aggregate3 eth_call   (request-count saving = N - 1)
allowFailure=true per subcall -> Promise.allSettled semantics on-chain
RPC-request cost: ceil(N / MULTICALL3_batch) requests vs N
```

- Contract-level aggregation — provider JSON-RPC envelope caps (dRPC ≤3)
  do NOT apply; each aggregate3 is a single eth_call.
- Applied to: factory matrix (`getPool`/`getPair`), decimals resolution,
  `learnToken`, and the sim hot path (`refreshPools` slot0/reserves).
  Boot discovery: ~2,900 requests -> ~15 aggregate3 calls (~200x).
- eth_call gas caps vary by node — keep chunks ≤ `DISCOVERY_BATCH_SIZE`
  (200); on aggregate transport failure degrade to per-call, never wedge.
- Node-side gas: each subcall pays its own gas inside one call context —
  total ≤ the node's eth_call gas cap (~50–100M typical). 200 cheap views
  ≈ 10M — safe headroom.
