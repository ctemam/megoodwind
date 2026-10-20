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
| Chainstack | `https://<chain>-mainnet.core.chainstack.com/<key>` | `wss://` same host+path | Developer free: 3M RU/mo, 25 RPS, 1 RU/req (archive 2 RU) | `mt_` = **multichain token** — one token across every attached Global Node; `401 "Access token missing or invalid"` = node not deployed/not attached to the multichain endpoint, NOT a bad key. Slugs DNS-verified (`bsc-mainnet`, not `bnb-*`). Nodes must exist AND be attached — console deploys Global Nodes instantly on free plan |
| 1RPC | `https://1rpc.io/<key>/<slug>` | none on free Starter | **1,000 req/day** keyed Starter (WSS + testnets = paid Personal+) | TEE-attested relay — metadata masked, genuine private lane. Key is FIRST path segment — `providerOf` special-cases the account extraction or every chain makes its own bucket. Day-quota modeled as sub-1 rps drip (~0.011 ≈ 930/day) — bucket floor 0.01 keeps it a reserve lane that can't be burst-drained |
| Blockscout | `https://api.blockscout.com/{chain_id}/json-rpc?apikey=<key>` | none | Free: 100k credits/day, 5 RPS (REST + gateway share ONE pool) | `proapi_` dual-surface key — gateway `eth_call` on eth/arb/op/scroll free (poly/base featured-paywalled, bsc/avax/linea/blast unsupported). REST side = explorer-enriched data (`is_scam`, `reputation`, decoded txs) — indexed endpoints beat RPC synthesis. `x-credits-remaining` = real-time quota. Skill installed: `.devin/skills/blockscout-web3-dev` (Bearer auth, named UA or CDN 403s, narrow projections) |
| Bitquery | `https://streaming.bitquery.io/graphql` (Bearer `ory_at_`) | streams = paid tier | ~10k dev points first month (~2k queries @ ~5pts); ~30 req/min free class | GraphQL indexer — `EVM.DEXTrades` = real trade history, behavioral evidence no RPC can fake. **Batch doctrine**: one `in: [50 addrs]` query ≈ cost of one addr — never per-pool queries. `dataset: realtime` only on free (no archive). Verified query shape: `DEXTrades(where:{Trade:{Dex:{Pair:{SmartContract:{in:[...]}}}}, Block:{Time:{since:iso}}})` |

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
5. Fleet totals (measured 2026-10-20): **~86 req/s safe across 4 live
   accounts, ~7.1M req/day, ~214M req/month** — request-level (+22 rps and
   ~3M RU/mo reserved on Chainstack once Global Nodes attach). On multicall paths the
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

## Flashbots private-rail protocol (`src/exec/flashbots.ts`)

Raw JSON-RPC to `relay.flashbots.net` — no bundle-provider dep. Auth:
`X-Flashbots-Signature: <addr>:<EIP-191 sig of raw body>` — the signing
key is a REPUTATION identity (use `FLASHBOOTS_AUTH_KEY`, not the exec key).

| Method | Use |
|---|---|
| `eth_sendBundle` | atomic bundle, ≤100 txs / ≤300kB; opts: `maxTimestamp`, `replacementUuid` (cancelable), `revertingTxHashes` |
| `eth_callBundle` | **shadow validator** — simulates signed bundle on real builder state; per-tx gasUsed/error/revert |
| `eth_sendPrivateTransaction` | single signed tx, private ≤25 blocks; `preferences.fast` = all builders |
| `eth_cancelBundle` | revoke by replacementUuid — no retroactive bid adjustment, cancel only future blocks |
| `flashbots_getFeeRefundTotalsByRecipient` | weekly refund telemetry (pending/received) |

Doctrine: bundles = raw signed txs only — a 4337 UserOp is not a raw tx;
the route arms when the exec path produces signed raw txs. mev_sendBundle
(MEV-Share) = different body format (inclusion/body/validity), one backrun
tx max as of 2025-10 — keep separate from eth_sendBundle.

## RPC routing config overlay (`rpc_pool_config.json` + `src/providers/rpcPoolConfig.ts`)

Operational state lives in the JSON, templates/budgets live in the TS
catalog. Statuses: `LIVE`, `LIVE_RESTRICTED_L1_ONLY`, `RESERVE_LANE`,
`SUSPENDED_*`. Gates apply at ENDPOINT EMISSION (zero URLs emitted for
suspended providers or non-whitelisted chains) and again inside `RpcPool`
for explicit env URLs. Loader re-reads on mtime change (~30s) — the sync
script promotes without a restart.

```json
provider_catalog.<id>.status            // LIVE | RESERVE_LANE | SUSPENDED_*
provider_catalog.<id>.supported_chains  // ["all"] | explicit chain keys
provider_catalog.<id>.priority          // 1 = primary, lower wins ties
```

### `rpc_provider_fault_interception` skill

| Fault | Action | Surface |
|---|---|---|
| `status SUSPENDED*` | emit zero endpoints — never connect/probe/retry | catalog + pool |
| 401 / 403 / not-enabled | persistent dead-lane (`rpcRegistry` 60min+) — stronger than a timed blacklist | `isDeadEndpoint` |
| 429 / timeout / volume | escalating cooldown 20s→300s, wait-earliest-refill, no hot loop | `penalize` + buckets |
| account-bucket drain | wait earliest refill — budget binds per KEY not per URL | `AccountBucket` |
| RESERVE_LANE (1RPC) | hard-clamped ~0.01 rps ≈ 1 call/100s — drip cannot be burst-drained | bucket floor |

## Live-fork simulation skills (`test/anvil/`)

Simulation runs against REAL forked state — Alchemy/keyed upstream, never
hardcoded mocks. Verified live 2026-10-20 (eth pinned @26,235,817,
impersonated send PASS, 34,194 gas, 0% variance).

Fork upstream selection follows `rpc_pool_config.json` priority: **Ankr**
for high-volume multi-run sweeps (6.7M req/day headroom), **dRPC** for
burst/parallel fork matrices (36 safe rps), Alchemy only for chainId 1
while `LIVE_RESTRICTED_L1_ONLY`, suspended providers never offered as
upstream. `--compute-units-per-second` still caps whatever is chosen.

### `fork_live_chain_state` (`test/anvil/forkSim.ts`)

Start a local Anvil fork bound to a keyed endpoint with optional block pin:

```
FORK_CHAIN=<key> [PIN_BLOCK=<n>] npx tsx test/anvil/forkSim.ts
anvil --fork-url <keyed-rpc> --fork-block-number <pin> \
     --compute-units-per-second <cap> --port <port> --silent
```

- `--compute-units-per-second` is the upstream throttle — the fork's own
  RPC pool, so a sim loop can never burn the provider free tier.
- Upstream endpoint comes from the config overlay — resolve via
  `keyedEndpointsFor(chain)` which already excludes suspended providers
  and non-whitelisted chains; pick by priority then EWMA.
- Readiness loop on `eth_chainId` — never fixed sleeps; the provider must
  answer before the fork declares state ready.
- `--fork-headers` exists for providers demanding custom headers.
- Pinned blocks make runs repeatable: same state root → same sim outcome.

### `execute_fork_dry_run` (`test/anvil/forkSim.ts`)

Push payloads to the pinned fork; assert zero reverts / zero OOG:

1. `anvil_impersonateAccount` grants execution permission to any target
   address — fork-local only, zero risk to live funds.
2. Send real tx payloads (e.g. ERC20 `transfer` from a whale) → receipt
   `status == 1` required; revert = FAIL with reason class.
3. Assert post-state delta (balance/allowance moved as computed).
4. Report `gasUsed` + variance vs provider `estimateGas` — quantifies
   fork-vs-remote gas drift for the executor's real-size checks.
5. Failure taxonomy: TRANSPORT / ERRORPAYLOAD / GAS / STATE — a 429 is
   upstream quota, an ErrorPayload revert is deterministic, keep them
   distinct or the risk ledger lies.

### Chainstack MCP platform server

`https://mcp.chainstack.com/mcp` — plain JSON-RPC over Streamable HTTP,
session via `initialize` + `Mcp-Session-Id` header. Keyless tools:
`search_docs`, `get_doc_page`, `get_platform_status`, `get_chainstack_pricing`.
Node/project ops (`list_nodes`, `create_node`, `get_deployment_options`)
need a console API key (console.chainstack.com → user settings → API keys)
as `Authorization: Bearer`. The `mt_` RPC token is NOT a console API key —
the two auth planes are separate.
