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
| safeguards | `mayExecute`, kill file, caps, fail-closed | wired pre-submit at `executor.ts` | **closed** — landed reverts feed `revert_gas` breaker |
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

## Closed-form cycle sizing (R1 — WO-8.7 capability)

For a 2-hop constant-product cycle A→B→A with reserves (x1,y1),(x2,y2)
and per-leg phi = 1-fee:
  t* = argmax net input, computed from the composed (P,Q,R) —
  P = φ1·x2·y1, Q = φ1·y1·y2, R = φ1·φ2·x1·x2
  t* solves (P·t²)/(y1+φ1t)² = R·x1·y2/((y2)² + ...) — see the exact
  derivation in `src/math/sizing.ts`; verified p90 rel-err 3.5e-8 vs
  golden-section brute force (interior optima only; boundary/cap cases
  diverge by construction, not error).
Mixed/v3 paths stay on screening search + exec-probe validation —
V3 output is piecewise across ticks (`v3AmountOutInTick`), so the
closed form does not apply there.

## Liquidation math (WO-10 capability)

Aave V3: HF = Σ(collat_i · ltv_i) / debt. Liquidatable HF<1; seize up to
CLOSE_FACTOR (50%, 100% when HF<0.95) at LIQUIDATION_BONUS.
Morpho Blue: healthy iff borrowed ≤ collat·price·lltv/1e36 — bound
px < borrowed·1e36/(collat·lltv); repaidAssets pulled via transferFrom
after onMorphoLiquidate approve. Liquidate partial when
repaidAssets·incentive/px would exceed position collateral (Panic 0x11
guard — measured on fork).
Net = seized collat value − repaid − fees − gas − flash premium.

## Competitive-capability assessment framework (Commander spec, 2026-10-24)

A searcher is decomposed into 12 capability categories: information
advantage, opportunity intelligence, strategy portfolio, latency &
infrastructure, execution engineering, block-space access, competitive
intelligence, capital & inventory, risk & security, learning &
adaptation, operational resilience, operating economics. Each
sub-category is scored 0-10 on a defined evidence scale:
0 absent | 1-2 conceptual/incomplete | 3-4 implemented, weakly verified |
5-6 functionally verified (tests pass, ops unproven) | 7-8 operationally
validated (repeated tests or production observation) | 9 competitively
demonstrated vs baseline | 10 sustained independently-verified advantage.
A missing measurement is scored **unknown**, never zero — zero means
demonstrably absent. Score per-dimension: implementation, verification,
operational reliability, competitive effectiveness, evidence confidence.
Separate scorecards per strategy (liquidation / DEX-arb / backrun) —
their information, latency and execution requirements differ.
References: Daian et al. 2019 (Flash Boys 2.0 — VERIFIED-CONCEPT),
Paradigm Dark Forest 2020 (VERIFIED-CONCEPT), Flashbots MEV-Share docs
(VERIFIED-CONCEPT), Gupta/Pai/Resnick 2023 private-order-flow research
(UNVERIFIED — cited not read).

## Industry research — competitor intelligence & predictive performance (Commander standard, 2026-10-24)

**Objective:** improve the proportion of opportunities correctly identified,
independently validated, executable, and economically worthwhile after costs
— not the number of strategies, endpoints, alerts, or detections.

**Evidence levels — every claim carries one:**
Observed (chain data/provider telemetry/receipts) · Inferred (plausible
interpretation) · Hypothesized (needs test) · Verified (repeatable
measurement). Competitor profitability/architecture/private flow is NEVER
presented as fact unless independently established.

**Opportunity lifecycle to instrument** (a win at one stage must not hide
losses elsewhere): market observation → signal detection → prediction →
opportunity discovery → pricing → qualification → execution prep →
inclusion → settlement → economics → feedback.

**Economic measurement:** distinct opportunities observed, % surviving
validation, % profitable at real size, inclusion+settlement rates, gross
realized profit, flash fees, swap fees+impact, gas, builder payments,
failed-tx costs, infra spend, net realized profit, profit/attempt,
profit/infra-unit — by chain, variant, regime. Simulated ≠ realized;
borrowed principal ≠ revenue; reverts are not costless.

**Sources (tiered):**
- Tier 1 primary: protocol docs + chain receipts + contract events.
- Tier 2 MEV research: Flashbots docs/research, EigenPhi (profit calcs
  need independent reconciliation).
- Tier 3 historical: Dune, DefiLlama (research context, not live feeds).
- Tier 4 intelligence: Arkham alerts/address labels (intelligence claims,
  not proof), Chainlink streams (timestamps/freshness).
Adopt a source only for measurable information advantage, a verified
coverage gap, or a demonstrated error reduction — not popularity.

**Competitor analysis method:**
1. Identify by repeated DEX-router/pool interactions, multi-pool asset
   flows, flash-loan borrow+repay, recurring arbitrage-like activity —
   every address classification carries a confidence level.
2. Reconstruct tx economics: chain+block, txHash, address, protocols,
   asset flow, ordering, flash usage, gas, other payments, final
   balances, profit-assumptions, confidence.
3. Compare only on measurable dimensions: activity frequency, venue
   spread, flash usage, gas, inclusion outcomes, net-profit estimate,
   concentration, trend — same windows, same assumptions.
4. Missed-opportunity classification for each competitor trade:
   visibility gap | data-freshness gap | pool-coverage gap |
   strategy-coverage gap | pricing/simulation error |
   profitability-threshold rejection | execution/inclusion disadvantage |
   genuine non-opportunity | insufficient evidence.

**Strategy/regime discipline:** separate family (economic hypothesis)
vs variant (materially different method) vs regime (market conditions)
vs configuration (operating constraints) — parameter grids are NOT
independent strategies. Regime dimensions: volatility, liquidity,
depth imbalance, cross-venue dispersion, gas costs, block-space
competition, activity, stress, protocol state, data quality. No regime
auto-activates a strategy. Prevent overfitting: training/validation/
out-of-sample/shadow/live are distinct evaluation classes.

**Whale-alert quality:** every alert retains chain+tx ref, token, amount,
timestamps, source, label confidence, event type, market relevance,
follow-up observation, whether it produced a validated signal. Alert
streams are scored on precision + false-positive rate + latency +
coverage + downstream usefulness — not notification volume.

**Missed-opportunity → fix ordering:** fix the earliest stage with the
largest measurable loss of valid opportunities. Data sources are added
only for completeness/freshness/reliability/discovery gains that exceed
their cost.

**Research workflow (10 phases):** audit capabilities → baseline
pipeline performance → competitor sample set → tx reconstruction →
missed-opportunity classification → variant/regime evidence →
whale-alert quality → ranked bottlenecks → source cost-benefit →
validated changes vs baseline. Each phase yields an auditable result.

**Acceptance criteria:** no invented competitor strategy; every finding
traceable; third-party profit ≠ verified economics; family/variant/
regime/config kept separate; alerts evaluated on usefulness; failures
distinguished by data vs non-opportunity vs simulation vs execution;
improvements ranked by measurable value; history ≠ future guarantee;
no speculative code as part of research.

**Final principle:** competitor intelligence explains the market;
predictive analysis identifies opportunities; validation determines
whether they're real; settlement establishes the economic result.
Sources: Flashbots Research, EigenPhi, Dune, Arkham, Aave flash-loan
docs, Uniswap concentrated-liquidity docs, Chainlink Data Streams.

## Competitor analytics (Commander-ordered 2026-10-24)

**Purpose:** measure what other searchers actually capture on each chain, and find where our pipeline loses it. This is the real market size. It replaces every guess.

**Method (from published research):**
1. Per block, decode swaps and token transfers. Classify a transaction as an *arbitrage* when its swaps form a closed token cycle ending with a net gain in the start token; classify a *liquidation* from the lending protocol's liquidation event. (mev-inspect-py model: swaps → arbitrages, profit token + amount.)
2. Net profit per transaction = profit token gain (in USD at block price) − gas paid − any direct payment to the block builder (coinbase transfer). Gross profit without costs is not the competitor's profit.
3. Group by **bot address and its contract**. Report per chain: active bots, trades, total net, average net per trade, top-5 share. (Qin et al. profit-per-address method.)
4. Classify each trade's channel: public mempool, or private (a direct builder payment, or a top-of-block position with no public pending record). Private share is a lower bound, because some private trades look public after the fact. (Weintraub: most MEV runs through private pools.)
5. Record for each trade: block, index in block, route (pools), borrow source if any (flash loan venue), size, gas used, gas price, whether it used a private route.
6. Join with our pipeline: for each competitor trade, replay at its block and record *found / not found* and the stage where we lose it (depth, suspect-pool, no spread, size, profit floor, gas multiple, other).

**What it cannot see:** private bids that never landed, builder-side ordering data, and any trade made by a bot whose routes we can't decode. Report these as unknown.

**Sources:** Flashbots mev-inspect-py (archived; method only), Qin/Zhou/Gervais 2021 (arXiv 2101.05511), Weintraub et al. 2022 (arXiv 2206.04185), Flashbots historical MEV data. L2/other-chain behavior is UNVERIFIED.

## Competitive Intelligence Mode v2 (Principal spec, Commander-approved 2026-10-24)

**Purpose:** convert competitor observations + predictive signals + regime analysis + execution outcomes into evidence-backed performance improvements. Answer five questions: what's happening, what competitors do, which opportunities we could've executed, where/why we lose, which changes improve verified net outcomes.

**A detected swap cycle is NOT a guaranteed reproducible opportunity.** Reconstruct pre-trade state, executable economics, and the divergence point before classifying a miss.

**Eight dimensions:**
- A: competitor classification by behavioral evidence only; unclassified stays unclassified until sufficient evidence.
- B: tx/strategy reconstruction — block, position, pool sequence, token flow, flash usage, gas, builder payments, pre-state, net outcome (traces+receipts where supported).
- C: opportunity intelligence — for each competitor trade, classify the divergence: visibility | freshness | pool-coverage | strategy-coverage | route-discovery | pricing/sim error | filter rejection | inclusion disadvantage | market-changed | no-opportunity | insufficient-evidence.
- D: three profit figures kept separate — observed competitor economics, counterfactual AllBright economics, realized AllBright economics. Never combined. Gross asset changes ≠ profit (deduct gas, flash fees, builder payments). Unpriced tokens stay raw-labeled.
- E: latency split — event/publication/receipt/discovery/sim/decision/submit/competitor-first/inclusion/settle measured separately; no ms-precision claims on unsynced clocks. L2 sequenced ordering analyzed separately (Arbitrum sequencer docs — public pending view ≠ sequencer queue).
- F: per-variant record — family, signals, regimes, failure conditions, validation/out-of-sample/shadow/settled results. Parameter grids ≠ independent strategies.
- G: 9-dimension regime matrix (volatility, liquidity, dispersion, gas, competition, activity, protocol state, data quality, stress). Regimes never auto-activate strategies.
- H: whale alerts classified by observable behavior not size; scored on precision + downstream usefulness.

**Sample integrity:** report 4 distinct quantities — detected arbs, independently validated arbs, positive-net arbs, arbs inside AllBright capability. No extrapolation from 500 blocks without longer-window variance.

**Loss attribution table:** find earliest defensible divergence per competitor tx (not-observed → observed-no-candidate → rejected → replay-fail → unsubmitted → not-included → reverted → underperformed). Genuine-miss only on evidence; unavailable pending state recorded as uncertainty.

**Decision framework:** every finding → decision record (problem, evidence, frequency, econ significance, confidence, action, cost, risk, validation, acceptance criteria, result). Rank by verified net-econ impact — small fix recovering a repeated miss class can beat expensive latency infra.

**Sources (prioritized):** mev-inspect-py, EigenPhi, Flashbots research+MEV-Share, Dune, Ethereum JSON-RPC, Uniswap docs, Aave V3 docs, Arbitrum sequencer docs, DefiLlama, Arkham, Chainlink streams. Document coverage/latency/cost/limits before reliance.

**Acceptance:** detection ≠ validated opportunity ≠ supported capability — kept separate; duplicates checked; competitor econ reconciled; funnel joined where possible; unknowns labeled unknown; recommendations ranked by econ impact with measurable acceptance criteria; no speculative code as part of research.

**Immediate priorities:** P1 validate the 101-arb sample + profitRaw; P2 complete the opportunity-to-pipeline join; P3 strategy-by-regime baseline; P4 whale-alert usefulness; P5 highest-value verified bottleneck first.

## Competitive Intelligence Mode v2 — autonomous operation (Commander 2026-10-24)

**Objective:** continuously discover, classify, benchmark, rank competitors; measure AllBright's relative position; identify highest-value gaps; self-trigger improvement work. Goal is better decisions + verified net outcomes — not competitor counts.

**Discovery:** identify searcher entities by evidence (cycle txs, flash-loan patterns, multi-protocol execution, liquidations, repeated execution patterns, builder payments) — address ≠ operator; cluster behavior where identity unresolvable. Classes: high-performers, flash-loan-intensive, backrun, liquidation, multi-chain, strong-execution, emerging, specialized/uncertain.

**Ranking dimensions:** activity, opportunity diversity, econ performance (independent estimates), execution reliability, cost efficiency, consistency, regime resilience, chain specialization, information advantage, inclusion advantage, evidence confidence. Label: observable performance ≠ total business performance — incomplete econ data reported as uncertainty, not rankings.

**Benchmark (the join):** for each competitor tx answer — market visible? data captured? strategy covered? route discoverable? pricing valid? economically viable? submit-capable? ordering-plausible? outcome reconstructible? which capability explains the difference? End every case with classification + uncertainty + improvement opportunity.

**Gap register fields:** id, strategy+network, competitor evidence, AllBright capability, benchmark, magnitude+confidence, cause (technical/informational/infrastructural/strategic/economic), fixes, deps+cost, expected benefit, regression risk, validation criteria, status.

**Self-triggers (auto-start L1-L3 work only):** new competitor/behavior; material performance change; repeated misses; variant underperformance vs baseline; regime transition; whale-alert anomaly; source degradation; execution/settlement deterioration; new industry evidence; post-change validation. Every trigger has condition+evidence+severity+permitted response+closure; group related events, suppress duplicates.

**Autonomy boundaries:** L1 observe | L2 diagnose | L3 evaluate (historical/sim/shadow) — autonomous within limits. L4 change (live trading, signing, exposure, contract behavior, security controls) requires Commander/Architect authorization.

**Learning cycle:** observe→discover→classify→benchmark→identify gaps→hypothesize→prioritize→evaluate→validate→learn→reassess. One competitor tx never reallocates strategy weight.

**Success measures:** competitor-activity coverage, classification confidence, reconstruction accuracy, validated-miss count, attribution accuracy, time-to-identify problems, % improvements validated, delta in settle/revert/net, per-variant×regime performance, trigger reliability.

## Competitor verification & adversarial detection (Commander 2026-10-24)

**Core rule:** learn from verified competitive evidence — never appearances, promotional claims, tx counts, or fabricated frontrunner signals.

**Entity classes (separate from performance score):**
1 verified_active | 2 verified_successful (economics supported, limits stated) | 3 provisional | 4 unverified_frontrunner | 5 suspected_deceptive | 6 confirmed_malicious (corroborated evidence required) | 7 inactive/historical | 8 unclassifiable.

**Deception investigation signals (signals ≠ proof):** high tx count without verified econ value; success-looking txs with unproven net profit; reverts counted as wins; profit distorted by decimals/stale prices/illiquid tokens; duplicate txs/records/addresses counted as independent operators; artificially inflated consistency; unverifiable win-rate/speed claims; attribution errors (merged or split operators); patterns designed to poison competitor analytics.

**Evidence hierarchy:** Tier1 receipts/traces/verified amounts/defensible valuations/reproducible calcs > Tier2 multi-window consistency/multi-source agreement/verified contract code > Tier3 dashboards/labels/promotional statements. Tier3 NEVER overrides Tier1.

**Two rankings kept separate:** verified-performance ranking (verified success, net-econ estimates, reliability, consistency, confidence) vs threat/capability ranking (detection speed, coverage, inclusion effectiveness, infra access, regime operation, adversarial risk). No combined score that hides uncertainty.

**Learning poison defense:** quarantine suspicious observations from trusted data; preserve provenance + confidence + contradictions per observation; distinguish observed behavior from inferred intent and competitor success from AllBright suitability; auditable history of classification changes.

**Re-verification triggers:** new frontrunner, sharp performance change, profit-vs-receipt conflict, dup/attribution anomalies, source disagreement, behavior change, previously-trusted entity producing anomalies, stale/incomplete ranking inputs, new chain/protocol/regime verification gap. Workflow: detect→preserve→verify→cross-check→classify→re-rank→assess learning impact→update/quarantine→record→monitor.

**Boundaries:** auto = discover/verify/flag/rank/offline+shadow eval/propose. Suspicious activity never auto-triggers live changes; L4 always Commander-held.

**Gap declaration rule:** a competitor tx AllBright didn't make is not automatically a gap — may be unavailable, unprofitable after costs, mis-reconstructed, or unsuitable for our environment. Gaps need reproducible evidence.

## CI data-integrity layer (`src/ci/store.ts`) — WO-03, tests green 2026-10-24
Canonical eventId `chain:tx[:logIndex]`; content-hash dedupe (idempotent ingest survives replay/restart/reprocess); reconciliation fills missing fields + correction trail on conflict (no silent erase); provenance: evidence[] per record, versioned classHistory; quarantine excludes from trusted() until policy-satisfied release; quality counters (received/unique/dups/incomplete/quarantined/released/unpricedProfit/unresolvedIdentity/reconciled). Unknown stays undefined — never fabricated. Test: `npx tsx test/ci_store_test.ts` (12/12 adversarial cases).

## CI economics layer (`src/ci/economics.ts`) — WO-04, tests green 2026-10-24
Profit-truth contract: receipt-success ≠ profit; gross flow ≠ net USD; missing ≠ zero. Statuses: execution_failed / successful_unpriced / gross_value_estimated / net_profit_estimated / net_profit_verified / economics_incomplete. Costs: gas (gasUsed×effectiveGasPrice, priced via WETH), flash fee (Balancer/Aave-V3/ERC-3156 event detection), builder payment (tx.value, lower bound). `net_profit_verified` requires traceVerified — public logs alone cap at `net_profit_estimated`. Every unpriced/unobservable input lands in unknowns[]. Test: `npx tsx test/ci_econ_test.ts` (12/12).

## CI measurement contract (`src/ci/measure.ts`, mc-v1) — WO-05, tests green
Every rate publishes numerator/denominator/eligible/excluded/unresolved + unit + window {chain, fromBlock, toBlock, complete, schema, contract, ordering}. den=0 → rate undefined (never 0). Join outcomes enum: matched/partial/unmatched/unresolved/excluded — join denominator = receipt-verified events only. Ordering retained: eth_builder_mev vs l2_sequencer_fifo. `comparable()` rejects unit/contract/incomplete mismatches. Pre-mc-v1 join profiles are NON-COMPARABLE. Test: `npx tsx test/ci_measure_test.ts` (10/10).

## CI rankings (`src/ci/rank.ts`) — WO-06, tests green
TWO leaderboards, never combined. Performance: verified-class entities only, ≥2 events, score = confidence-weighted net-USD (undefined when unpriced/insufficient — never ranked on gross). Threat/capability: observable volume+breadth+chains, explicitly labeled "not profit". Flags disclose limitations per row (below_min_sample, unpriced, provisional_evidence). Aggregates by cluster when shared executor. Test: `npx tsx test/ci_rank_test.ts` (9/9).

## Change control (`src/ci/changeControl.ts`) — WO-10, tests green
DNA vs Adaptive enforced at L2: classify() routes targets via DNA_PATTERNS (signing/mayExecute/kill/minProfit/budget/deploy/security → C_commander) or BOUNDED ranges (A_bounded in-range, else B_reviewed; unknown target → B). propose() applies only with the required gate: A=baseline validation, B=approval+validation, C=commander token+approval+validation. Every decision audit-logged (prev/proposed/why) for rollback; denials recorded not silent. Negative tests: `npx tsx test/ci_changecontrol_test.ts` (12/12). L4 caveat: gate covers callers through propose(); direct file edits remain outside it — operational assurance requires repo review.

## CI attribution (`src/ci/attribute.ts`) — WO-07, tests green
Six outcomes: confirmed_missed (replay-backed only) / visibility_failure (stage1 pools) / pipeline_rejection (stage2 convicted, stage3 token) / execution_failure / not_economically_viable (stage6 net≤0 or <floor) / indeterminate. Unmatched ≠ missed — replay counterfactual required before any "missed" claim; estimate-only stays indeterminate. Alternatives preserved per verdict (wrongful conviction, timing, registry gap). Live eth 80-blk: visibility_failure=26 indeterminate=8 confirmed_missed=0 (correctly zero — no replays run). Test: `npx tsx test/ci_attribute_test.ts` (12/12).

## CI trigger engine (`src/ci/triggers.ts`) — WO-09, tests green
Observations → investigations only (never auto-accept/integrate/execute). Gates in order: minSample → minCoverage → dedupe → hysteresis+persistence → cooldown → daily cap → kill. State persisted (streak survives restart). Actions: investigate(hypothesis)/request_replay/recommend_review/escalate_commander. DEFAULT_TRIGGERS wires visibility_failure_rate>0.5 (persist=2, recovery=0.35, n≥20, cov≥95%, 30min cooldown, 4/day)→H-001 and indeterminate_rate>0.1→H-002. Test: `npx tsx test/ci_triggers_test.ts` (13/13).

## CI report (`src/ci/report.ts` → `scripts/ci_report.ts`) — WO-11
One consolidated view: mc-v1 windows, entity classes, econ statuses, both rankings, trigger states with suppression reasons (suppressed≠no-problem labeled), hypothesis lifecycle, store counters. Generated: `npx tsx scripts/ci_report.ts eth` → docs/ci_report.md. Known artifact: 14 legacy `net_profit_verified` records predate the traceVerified gate — provenance preserves original classification; re-evaluation scheduled per correction-trail policy.

## CI stage diagnostics (`src/ci/diagnostics.ts` → `scripts/ci_diagnostics.ts`) — WO-14, tests green
Nine-stage read-only funnel: detection→observation→validation→projection→replay→candidate→qualification→readiness→settlement. Each record counted once at its loss stage; never-entered = n/a not 0%; unresolved (unverified receipt) separated from eligible. Live eth funnel (95 records, registry=207): stage-1 87.4% visibility loss, stages 2-4 clean, stage-5 100% indeterminate (replay corpus pending), stages 6-9 never entered. Command: `npx tsx scripts/ci_diagnostics.ts eth` → docs/ci_funnel_eth.md. Tests: `npx tsx test/ci_diagnostics_test.ts` (8/8).
