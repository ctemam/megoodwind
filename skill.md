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
        - (gasUnits * (baseFee + priorityFee) + l1DataFeeWei) / 1e18 * native_usd
        #                  ^ EIP-1559 execution      ^ OP-Stack L1 data availability (dual-gas)
        - flashPremium_usd                             # Balancer/Morpho/Maker 0, Aave 0.09%
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
A candidate over the ceiling convicts **only the divergent legs** — pools
whose spot quote diverges >3x from same-pair peers (`peerDivergence`).
Honest co-leg pools are never blamed for routing through a liar; when no
leg can be attributed, nothing is convicted (exec-probe reverts remain
the deterministic fallback for solo fakes).

## Filtration gate counters (`src/telemetry/metrics.ts`)

Four persistent audit counters instrument the solver's hard gates —
`total_detected_opportunities`, `rejected_by_forensic_bait`,
`rejected_by_profit_margin`, `passed_to_simulation_probe`. Flushed to
`data/metrics_counters.json` every 5s, aggregated into `forensicGates`
on `/api/metrics`, rendered on the cockpit Strategy + Report pages.

## Performance analytics ledger (`src/telemetry/metrics.ts`)

`recordVariantOutcome(variantId, lane, {hit, netUsd, floorUsd})` — one
ledger row per `variant@lane`: hits, misses, `minProfitFloorUsd`,
`maxProfitUsd` (peak simulated yield), accrued `netUsd`. Lane profit
sums produce `profit_ratio_predictive` / `profit_ratio_whale` share
percentages and `peak_profit_usd` (session max). Persisted to
`data/variant_ledger.json` on the same 5s flush; surfaced as
`analytics` on `/api/metrics` and the cockpit ledger fold.

**Lane floors** — effective floor per candidate =
`max(MIN_PROFIT_USD, lane floor)`: `PREDICTIVE_MIN_PROFIT_USD` ($2.50)
for scheduled variant lanes, `WHALE_MIN_PROFIT_USD` ($25) inside a
30s whale-alpha window (`whaleUntil` in arbRunner — a whale transfer
marks the chain's next solves as whale lane). STRICT_PROFIT_FLOOR_GUARD
governs both; floor misses count as ledger `misses`.

## On-chain decimals authority (`src/feed/refresh.ts`)

`resolveTokenDecimals(rpc, pools)` — ONE aggregate3 call resolves
`decimals()` for every unique token0/token1. Feed metadata (DexScreener)
omits decimals; wrong 10ᵏ scales corrupt spot prices and used to convict
legitimate pools. Incremental cache (`chain:token`) makes repeat calls
free; runs each solver cycle + fork window before refresh.

## L1 data-fee oracle (`src/providers/l1Fee.ts`)

OP-Stack predeploy `0x420000000000000000000000000000000000000F` —
`getL1Fee(calldata)` prices the L1 data-availability share of an L2 tx.
`OP_STACK = {base, op, blast}` gates it; `l1DataFeeWei(rpc, byteLen)`
assumes worst-case all-nonzero bytes; `l1FeeScalars(rpc)` reads
l1BaseFee / blobBaseFee / baseFeeScalar / blobBaseFeeScalar in ONE
aggregate3 for cockpit telemetry. Non-OP chains and transport faults
return 0 — the profit floor remains the gate.

## Dynamic slippage engine (`solver.ts` + `predictiveEngine.ts` + `profit.ts`)

- `priceImpactBps(pool, amountIn, tokenIn)` — constant-product impact per
  leg: `a_eff/(rIn+a_eff)` on real v2 reserves; v3 substitutes virtual
  reserves `L·2⁹⁶/√P` (x→y) / `L·√P/2⁹⁶` (y→x). Accumulated per path in
  `emit()` during the sim pass — no extra loop.
- `dynamicSlippageBps(variant, {regime, whale, volBps})` scales the static
  per-variant `slippageBps`: LOW_VOL_MEAN_REVERTING → `SLIPPAGE_LOW_VOL_BPS`
  (10 = 0.1%), whale window → ≥`WHALE_SLIPPAGE_BPS` (150), vol floor at
  1.25× observed move, absolute cap `SLIPPAGE_CEILING_BPS` (200).
- Rejects: `impactBps > bound` → `rejected_by_profit_margin{price_impact}`.
- On-chain binding: `Candidate.minProfitToken` = lane floor in borrow
  units → plan `minProfit`; whale lane also folds it into `minOut`.
- Telemetry: `metrics.slippage[chain]` → `/api/metrics.slippage` →
  cockpit "Dynamic Slippage" panels (Strategy + Configuration).

## Flash-loan venue ladder (`src/exec/flashVenues.ts`)

`enum FlashSource { BALANCER, AAVE, MORPHO, ERC3156 }` — fee ladder:

| Source | Fee | Venue | Notes |
|---|---|---|---|
| BALANCER | 0% | Balancer V2 Vault `0xBA12…F2C8` (canonical all chains) | primary; `receiveFlashLoan` callback |
| MORPHO | 0% | Morpho Blue `0xBBBB…FFCb` (eth/base/arb/op vanity) | pull-repay via allowance |
| ERC3156 | 0% | Maker DssFlash `0x6074…4d45` | DAI only, eth only, ~500M ceiling |
| AAVE | 0.09% | Aave V3 Pool | last resort — paid capital |

`pickFlashSource(chain, token)` prefers fee-free capital; `flashPremium`
returns 0 for all non-Aave sources. Selection is by chain availability —
a venue that can't cover the borrow fails deterministically inside
exec-probe (recorded, zero capital at risk). Whale-lane plans bind
`minOut = repay + premium + minProfit` so a thin-margin fill reverts.

## Deploy address registry (`scripts/deploy.ts`)

`VENUES = FLASH_VENUES` — the same table the executor picks from
(Balancer/Morpho/ERC3156/Aave per chain; `address(0)` = verified
boundary where a venue doesn't exist).
`DEX_ROUTERS` = documented router/quoter/factory coords (base + eth) —
ops reference only; the executor swaps directly on pool contracts.
All addresses pass EIP-55 checksum validation (sweep verified
2026-10-21: 28 unique addresses, 10 chains, zero failures).

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

### Strategy-layer skills (`src/engine/`)

**`classify_market_regime(chainKey)`** — `marketRegime.ts`

```
in : chainKey                    # one configured chain
out: RegimeSnapshot {
       regime: HIGH_VOL_TRENDING | LOW_VOL_MEAN_REVERTING | ILLIQUID_CRASH | BALANCED
       volBps: number            # median |Δprice bps| across pools
       trendScore: -1..1        # directional consistency
       illiquidFrac: 0..1       # stale/zero-state share
       poolsSampled, at }
```
Inputs are live registry state post-`refreshPools` — the same state the
solver quotes, sourced from the keyed fleet (dRPC/Ankr/Alchemy-lanes via
`rpc_pool_config.json`). Call once per solver cycle.

**`evaluate_predictive_variants(regimeSnapshot)`** — `strategyRouter.ts`

```
in : RegimeSnapshot
out: Variant[]                   # eligible subset of VARIANTS[12]
```
Gate matrix: HIGH_VOL_TRENDING suppresses MEAN_REVERSION;
LOW_VOL_MEAN_REVERTING suppresses MOMENTUM+CROSS_PAIR_VOL;
ILLIQUID_CRASH allows only STAT_ARB with minDepthUsd ≥ 250k;
BALANCED passes all. `nextVariant(scheduler, snap)` wraps the
settled-evidence rotation — a suppressed pick is skipped, never run.

**`route_whale_alpha_signal(chain, tokenAddr, usd)`** — `strategyRouter.ts`

```
in : chain, tokenAddr, usd       # from WhaleTracker (> $500k transfers)
out: { direct: PoolState[], correlation: PoolState[] }
```
Direct pools = every registry pool containing the token; correlation =
peer venues of the same pair (other DEX/fee tier) — refreshed as one
batch so the solver sees the cross-venue gap in the same state tick.
Emits `kind:whale_alpha` to the signal sink.

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

## Research framework — realized-profit doctrine (Commander-provided, 2026-10-23)

The objective is **realized, risk-adjusted net profit over time** — not
detected-opportunity count or simulator gross. Competing searchers bid
away most of any visible edge through transaction fees; private
submission reduces frontrun exposure but does not eliminate competition.

### The profit equation (mandatory accounting for every candidate)

net = realized_proceeds − input_costs − dex_fees − impact
      − borrow_fees − network+execution − other_attributable

An atomic revert returns contract state but **still loses gas**. A quoted
price difference is not profit — the settled receipt with its full cost
record is the only admissible evidence.

### Factor register (audit dimensions, in pipeline order)

1. **Opportunity quality** — separate lanes, not one count: DEX↔DEX gaps,
   pool-curve/depth differences (spot ≠ quote at size), lending/liquidation
   dislocations, ordering effects (arbitrage is legitimate; sandwiching is
   harmful MEV — out of scope).
2. **Execution economics** — per-opportunity record: quoted → simulated →
   settled → reconciled; failed-tx fees attributable and counted.
3. **Data quality** — freshness (which block), consistency (do sources
   agree), completeness, accuracy (decimals/reserves/fees/addresses),
   availability, provenance, stale/contradictory-data recovery. More
   endpoints ≠ better intelligence.
4. **Software correctness** — chain-id/block ref consistency, integer
   arithmetic, decimal conversions, rounding, fee units, stage-to-stage
   opportunity identity (path + block + assumptions + reject reason).
5. **Observability** — stage counts, reject reasons, latencies, sim
   results, receipts, reconciled outcomes.
6. **Safeguards** — authorization, secret handling, contract permissions,
   dependency integrity, no unintended live action.

### Evaluation without self-deception

Report denominators and observation windows — a failure rate without
attempt count/failure class/spend is meaningless. Simulated performance,
realized results, and unverified claims are three separate ledgers and are
never mixed.

### Source ledger additions

| Source | Use | Status |
|---|---|---|
| ethereum.org MEV docs | searcher/ordering/competition model | VERIFIED-CONCEPT (referenced, doctrine matches) |
| ethereum.org gas docs | fee mechanics incl. failed-tx cost | VERIFIED-CONCEPT |
| ethereum.org transactions docs | tx fields / nonce / gas semantics | VERIFIED-CONCEPT |
| Flashbots bundle-pricing | builder bid↔cost relationship | VERIFIED-CONCEPT |
| Flashbots searcher quick-start | bundle sim/submit model | VERIFIED-CONCEPT |

### AllBright audit mapping (WO-campaign status, evidence-linked)

| Factor | Module(s) | Evidence | Gap |
|---|---|---|---|
| net accounting | `src/math/profit.ts` (`netUsd` — gas+L1+premium+impact) | eth fork settle predicted $80.02 → settled $81.10 (0.9%) | — |
| quoted≠profit | atomic `minOut`/`minProfit`, execProbe | 0/3 replay — model edge nonexistent at real v3 | v3 screen over-pred ~0.5–1% (tick impact) — **open** |
| separate lanes | P01/P02 arb, WO-10 liquidation, WO-11 private flow | settle proofs | live measured edge = 0 |
| failed-tx cost | `ops/losses.jsonl` revert_gas rows | — | not yet populated by runtime |
| data freshness | block-anchored refresh + `updatedAt` | probe replay at emit-block | — |
| data consistency | peer divergence >3× conviction | 7 base pools convicted | — |
| decimals accuracy | on-chain `decimals()` authority | `resolveTokenDecimals` | — |
| observability | `diag_*` stage counters + funnel | WO-8.6 funnel 761k→148 | — |
| safeguards | `mayExecute`, kill file, caps, fail-closed | — | not yet wired into runner submit path — **open** |
| RPC spend trigger | `ops/rpcEconomics.ts` measured | recommendation: no spend | — |

## Strategy taxonomy (Commander research spec, 2026-10-23)

Distinguish: **family** (economic hypothesis), **variant** (materially
different formulation), **configuration** (guard settings), **regime**
(evaluation conditions), **rotation** (evidence-based reconsideration).
A variant is independent only when it carries a different hypothesis or
information source — a parameter grid is NOT a portfolio of strategies.
AllBright actual: 5 families × 12 variants × 6 regimes (CONGESTED + DEGRADED_INFO added post-audit; DEGRADED_INFO is fail-closed); the "missing"
classes are separate lanes (WO-10 liquidation, WO-11 private flow) and
two proposed regime classes (congestion, degraded-info) are unmapped.
See `docs/research_inventory.md`.

Sources added to ledger: Uniswap protocol docs (v2/v3/v4 mechanics —
VERIFIED-CONCEPT), Wiley 2025 price-discovery study (UNVERIFIED — cited
not read), Flashbots bundle docs (VERIFIED-CONCEPT), Aave flash-loan docs
(VERIFIED-CONCEPT).
