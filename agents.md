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
| Forensics | `src/forensics/baitPool.ts` | Pool-level convictions: gap>2% ceiling, exec-probe revert, >3x peer divergence, fee outside sane tiers. Persisted `data/leaders/<chain>/_bait_pools.json`. |
| Executor | `src/exec/*` | fresh-state re-sim at real size → baseFee breaker → exec-probe `eth_call` from SMART_ACCOUNT → Pimlico UserOp → receipt → settled accounting. Flashbots bundle (eth) when keyed. |
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

## Invariants

- Atomicity law: the whole cycle lives in one flash callback; revert = zero loss.
- Strict 4337: submissions are sponsored UserOps; probes use the smart-account identity, never the EOA.
- STRICT_PROFIT_FLOOR_GUARD: no emission path bypasses `MIN_PROFIT_USD`.
- PRIVATE-RPC-ONLY: unkeyed endpoints are rejected at boot (`PUBLIC_RPC_FORBIDDEN`).
- Last-hop `minOut = flash_amount + premium` — decayed spread reverts.
- Transport faults (429/timeout) never convict; ErrorPayload reverts always convict.
- Manual pool or token registration is strictly forbidden — on-chain factory and token-list discovery only.
