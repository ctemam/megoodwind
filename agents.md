# agents.md — AllBright multi-agent workflow (Item #18)

The Scout Agent coordinates the autonomous loop. Path priority:
targets assets heavily pooled inside the Balancer Vault first
(0% flash fee = primary capital engine), Aave V3 second.

## Agents

| Agent | Module | Loop |
|---|---|---|
| Scout | `src/scout/scoutListener.ts` | newHeads on all active chains; `newPendingTransactions` on predictive chains only (public mempool). Sequencer chains run same-block backrun — no pending feed exists. **Discovery Phase:** on boot, parses the Uniswap Token List JSON stream per chain ID, then runs the async factory matrix (`getPool`/`getPair` across every registered factory + fee tier) to build the pool universe from on-chain state — never from config. Steady-state `PoolCreated`/`PairCreated` log scans pull newly deployed pairs into the solver without a restart. |
| Discovery | `src/discovery/*` | `tokenLists.ts` = token-list streams + on-chain `decimals()` fallback. `factories.ts` = env-overridable factory registry (infrastructure, not pools). `discovery.ts` = boot matrix + creation-event watcher. |
| Feed | `src/feed/dexscreener.ts` + `src/feed/refresh.ts` | DexScreener batched ingest (30 addrs/call), then ONE merged on-chain refresh per cycle. Never serialize per-item RPC. |
| Solver | `src/strategies/solver.ts` + `src/strategies/graph.ts` | CPU-eval ALL pools per cycle. TRACE = probe-gated settled-evidence lane; P01 = 2-hop cross-venue; P02 = multi-hop cyclic. Bellman-Ford negative-cycle pathfinder discovers arbitrary n-hop cycles over every discovered pool. P09 dead, EV dead. |
| Predictive | `src/engine/predictiveEngine.ts` | 12-variant matrix; VariantScheduler rotates on latency anomalies and settled-evidence score. |
| Whale | `src/services/whaleTracker.ts` | >$500K single transfers; Whale Alert API if keyed, else on-chain Transfer-log scan. Pipes token addr → Scout targeted refresh. |
| Forensics | `src/forensics/baitPool.ts` + `src/providers/blockscout.ts` + `src/providers/bitquery.ts` | Pool-level convictions: gap>2% ceiling, exec-probe revert, >3x peer divergence, fee outside sane tiers, **explorer `is_scam` verdict** (Blockscout — async per discovered pool, cached), **zero-real-trades + divergent** (Bitquery DEXTrades — ONE batched GraphQL query per discovery chunk, `in: [...]` filter ≈ same cost as single addr; convicts pools quoting >3x divergent with ZERO real trades in 72h). Persisted `data/leaders/<chain>/_bait_pools.json`. |
| Executor | `src/exec/*` | fresh-state re-sim at real size → baseFee breaker → exec-probe `eth_call` from SMART_ACCOUNT → Pimlico UserOp → receipt → settled accounting. **Flashbots spec-complete** (eth only): raw JSON-RPC + `X-Flashbots-Signature` EIP-191 auth (dedicated `FLASHBOOTS_AUTH_KEY` carries reputation — not the execution key); `eth_sendBundle` (≤100 txs/300kB, maxTimestamp/replacementUuid/revertingTxHashes), `eth_callBundle` builder-state sim (shadow validator — real builder semantics, zero submission), `eth_sendPrivateTransaction` (25-block window), `eth_cancelBundle`, `flashbots_getFeeRefundTotalsByRecipient` telemetry. Route activates only when a signed raw-tx path exists — strict-4337 UserOps stay Pimlico. |
| Telemetry | `src/telemetry/*` + `apps/dashboard/*` | Express API :3001 + Banbot React cockpit :9205. Only `arb_settled_net_usd` on landed records is profit. |

## Automated Multi-Chain Expansion (master table addendum)

Protocol rule: **manual pool or token registration is strictly forbidden.**
Pools and tokens enter only via on-chain factory queries, creation-event
logs, or token-list streams + on-chain metadata.

| Vector | Standard tool | Module |
|---|---|---|
| All DEXs & pools | UniV3/V2 factory `getPool`/`getPair` + `PoolCreated`/`PairCreated` logs; DefiLlama/DexScreener enrichment | `src/discovery/factories.ts`, `src/discovery/discovery.ts`, `src/feed/dexscreener.ts` |
| All tokens & decimals | Uniswap Token List standard + `IERC20.decimals()` fallback | `src/discovery/tokenLists.ts` |
| All multi-hop paths | Bellman-Ford negative-cycle pathfinder (runtime edges) | `src/strategies/graph.ts` |
| All EVM chains | generic chain keys — `CHAIN_ID_<KEY>` + keyed `<KEY>_RPC_URLS` joins a chain with zero code edits; Chainlist-class metadata for IDs only (its public RPCs are forbidden) | `src/config/index.ts` |
| Cross-chain telemetry | metrics API + Banbot cockpit (subgraph feeds reserved) | `src/telemetry/*` |
| Multicall3 batching | `aggregate3` on canonical `0xcA11bde05977b3631167028862bE2a173976CA11` — N view calls collapse into ONE eth_call (~200× request-rate reduction on discovery + sim refresh). Contract-level aggregation — immune to JSON-RPC envelope batch caps (dRPC's 3-item limit does not apply). `MULTICALL3_ADDR` env override; auto-fallback to per-call if the aggregate errors | `src/providers/multicall.ts` |
| Private provider universe | keyed expansion per chain from `*_API_KEY` — dRPC, Alchemy, Ankr, NodeFlare, Chainstack (`mt_` multichain token = one key every chain), 1RPC (TEE relay reserve lane) templates verified against provider docs (2026-10-20); each account key is a distinct quota pool; explicit `<CHAIN>_RPC_URLS` keep precedence, deduped | `src/providers/providerCatalog.ts` + `src/config/index.ts` |
| Account budget scheduler | quota binds per ACCOUNT KEY not per URL — one token bucket per provider account sized `doc_rps × 0.9` (10% reserve never ordinary workload); pick = lowest EWMA among cooled-in + budget-live members; when all drained, wait earliest refill — never hot-loop | `src/providers/rpcPool.ts` |
| RPC inventory probe | bounded census (`test/rpc_inventory.ts`): chainId verify, p50 latency ×5, tiny burst — ~14 req/endpoint; prints per-account pool + documented budget table; never a load test | `test/rpc_inventory.ts` |
| Alchemy state & forking tier | Supernode-keyed endpoints drive Anvil mainnet forks — archive-depth live state, `--fork-block-number` pinning for repeatable simulations, node-level request caching (aggregate3 + registry EWMA). `anvil --compute-units-per-second` throttles the fork's upstream calls so a sim loop can't burn the free tier; `--fork-headers` passes provider-required headers where a plan demands them | `test/anvil/forkSim.ts` (`fork_live_chain_state`) |
| Rate-limit protection & resiliency | Request queue = per-account token buckets (the queueing layer — a request only flows when its account has a token); automated exponential backoff = member cooldowns `×3` on 429, `×5`-capped failure multiplier + adaptive discovery delay `×4`; rotational multi-app keys = `<P>_API_KEY` plus `<P>_API_KEY_2.._5`, each a distinct quota pool | `src/providers/rpcPool.ts`, `src/providers/providerCatalog.ts` |
| Persistent endpoint registry | `data/rpc_registry.json` — dead marks (60-min TTL, then auto re-qualify), verified chainIds, EWMA latency seeds; dead endpoints get ZERO boot handshakes; provider-side fixes self-heal on next boot | `src/discovery/rpcRegistry.ts` |
| WSS mempool union | one pinned lane per provider ACCOUNT per chain (same-account dupes subscribe the same view — no gain); rolling two-set tx-hash dedupe (200k cap, 120 s rotation); lanes retire on dead-lane instead of churning | `src/scout/scoutListener.ts`, `src/providers/wss.ts` |

### Measured provider inventory (probe 2026-10-20 — re-run before any capacity claim)

| Account | eth | bsc | poly | SAFE_RPS | Monthly budget | Measured facts |
|---|---|---|---|---|---|---|
| dRPC key | 179ms | 161ms | 167ms | 36 | 210M CU/30d | JSON-RPC batch ≤3; WSS live on all 3 (docs say paid-only — capability not guarantee) |
| Alchemy key | 201ms | **not-enabled** | **not-enabled** | 14 | 30M CU/mo | key verified valid on all 10 slugs — same key every chain; app has only `eth-mainnet` enabled (`403 <NET> is not enabled for this app` = operator toggle in Alchemy dashboard, not a defect) |
| Ankr key | 175ms | 192ms | 204ms | 27 | 200M credits/mo | HTTPS-only on Freemium — no WSS derived |
| NodeFlare key | 212ms | 252ms | 226ms | 9 | ~2M CU/mo | docs disagree 2M vs 3M — conservative bound used |
| Chainstack `mt_` token | **no-nodes** | **no-nodes** | **no-nodes** | 22 (25×0.9) | 3M RU/mo | multichain auth token verified — `401 Access token missing or invalid` on all 10 DNS-verified slugs = **zero Global Nodes attached**, NOT a bad key. Console task: deploy Global Node per chain (instant, free) → attach to the multichain endpoint. Auto-onboards via 60-min dead-lane TTL. MCP platform server: `mcp.chainstack.com/mcp` (keyless docs/pricing; console API key unlocks `create_node`) |
| 1RPC key | live | live | live | ~0.01 | 1k req/day (~30k/mo) | TEE-attested relay, 8/10 chains chainId-verified (`eth,bnb,matic,arb,op,base,linea,scroll`; avax/blast `unknown network` — excluded). Key in FIRST path segment `1rpc.io/<key>/<slug>`. **Reserve/failover lane only** — free Starter drip, no WSS at this tier; bucket floor 0.01 rps prevents drain |
| Blockscout `proapi_` | live (gw+rest) | unsupported | featured-paywalled | 4.5 | 100k credits/day | dual-surface key: `{chain_id}/json-rpc` gateway feeds the pool on **eth/arb/op/scroll** (verified); poly/base = "Featured chain" paid plans; bsc/avax/linea/blast unsupported. REST indexer live — `is_scam`/`reputation` verdicts wired into forensics; `x-credits-remaining` header = live quota telemetry |

Aggregate safe capacity: eth **~86 rps** / bsc,poly **~77 rps** across 4 live accounts
(+22 rps/chain on Chainstack once nodes attach) —
vs the single-account ~36 rps that saturated at shadow boot. Combined with
Multicall3 (~200× request reduction on bulk paths), boot discovery drops
from ~2,900 requests to ~15 aggregate3 calls.

### RPC capacity totals — per second / day / month (documented free tiers)

Uniform `eth_call` draw; `req/day = monthly_budget / 30 / cuCost`. Per-chain
figures — a request to ANY chain burns the same account pool.

| Account | SAFE_RPS | req/day (eth_call) | req/month | Notes |
|---|---|---|---|---|
| dRPC | 36 | ~350,000 | ~10.5M | 210M CU/30d ÷ 20 CU; min-floor under load ~40% |
| Alchemy | 14 | ~38,000 | ~1.15M | 30M CU/mo ÷ 26 CU; eth-only until app toggles |
| Ankr | 27 | ~6,670,000 | ~200M | 1 credit/req — largest raw pool |
| NodeFlare | 9 | ~67,000 | ~2M | conservative 2M CU bound |
| Chainstack | 22 | ~100,000 | ~3M | 1 RU/req (archive 2) — reserved until Global Nodes attached |
| 1RPC | ~0.01 | ~1,000 | ~30k | free Starter drip — reserve lane, bucket rate-limits to ~930/day |
| Blockscout | 4.5 | ~100,000 credits/day | ~3M | gateway+REST share ONE credit pool — eth/arb/op/scroll only on free |
| **TOTAL** | **~86 rps** | **~7.1M req/day** | **~214M req/mo** | across 4 live quota pools (+22 rps/~3M/mo pending Chainstack attach) |

Effective view-call capacity is ~200× higher on multicall paths
(aggregate3 = 1 request per ≤200 subcalls): discovery+refresh burn
requests, not subcalls — ~7.1M req/day ≈ **~1.4B subcall-equivalents/day**
headroom for bulk reads. WSS subscriptions are separate stream capacity
(dRPC live all chains, Alchemy where enabled, NodeFlare 6 chains, Ankr none).

## Invariants

- Atomicity law: the whole cycle lives in one flash callback; revert = zero loss.
- Strict 4337: submissions are sponsored UserOps; probes use the smart-account identity, never the EOA.
- STRICT_PROFIT_FLOOR_GUARD: no emission path bypasses `MIN_PROFIT_USD`.
- PRIVATE-RPC-ONLY: unkeyed endpoints are rejected at boot (`PUBLIC_RPC_FORBIDDEN`).
- Last-hop `minOut = flash_amount + premium` — decayed spread reverts.
- Transport faults (429/timeout) never convict; ErrorPayload reverts always convict.
- Manual pool or token registration is strictly forbidden — on-chain factory and token-list discovery only.
