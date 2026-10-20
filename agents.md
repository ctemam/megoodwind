# agents.md — AllBright multi-agent workflow (Item #18)

The Scout Agent coordinates the autonomous loop. Path priority:
targets assets heavily pooled inside the Balancer Vault first
(0% flash fee = primary capital engine), Aave V3 second.

## Agents

| Agent | Module | Loop |
|---|---|---|
| Scout | `src/scout/scoutListener.ts` | newHeads on all active chains; `newPendingTransactions` on predictive chains only (public mempool). Sequencer chains run same-block backrun — no pending feed exists. |
| Feed | `src/feed/dexscreener.ts` + `src/feed/refresh.ts` | DexScreener batched ingest (30 addrs/call), then ONE merged on-chain refresh per cycle. Never serialize per-item RPC. |
| Solver | `src/strategies/solver.ts` | CPU-eval ALL pools per cycle. TRACE = probe-gated settled-evidence lane; P01 = 2-hop cross-venue; P02 = 3-hop triangular. P09 dead, EV dead. |
| Predictive | `src/engine/predictiveEngine.ts` | 12-variant matrix; VariantScheduler rotates on latency anomalies and settled-evidence score. |
| Whale | `src/services/whaleTracker.ts` | >$500K single transfers; Whale Alert API if keyed, else on-chain Transfer-log scan. Pipes token addr → Scout targeted refresh. |
| Forensics | `src/forensics/baitPool.ts` | Pool-level convictions: gap>2% ceiling, exec-probe revert, >3x peer divergence, fee outside sane tiers. Persisted `data/leaders/<chain>/_bait_pools.json`. |
| Executor | `src/exec/*` | fresh-state re-sim at real size → baseFee breaker → exec-probe `eth_call` from SMART_ACCOUNT → Pimlico UserOp → receipt → settled accounting. Flashbots bundle (eth) when keyed. |
| Telemetry | `src/telemetry/*` + `apps/dashboard/*` | Express API :3001 + Banbot React cockpit :9205. Only `arb_settled_net_usd` on landed records is profit. |

## Invariants

- Atomicity law: the whole cycle lives in one flash callback; revert = zero loss.
- Strict 4337: submissions are sponsored UserOps; probes use the smart-account identity, never the EOA.
- STRICT_PROFIT_FLOOR_GUARD: no emission path bypasses `MIN_PROFIT_USD`.
- PRIVATE-RPC-ONLY: unkeyed endpoints are rejected at boot (`PUBLIC_RPC_FORBIDDEN`).
- Last-hop `minOut = flash_amount + premium` — decayed spread reverts.
- Transport faults (429/timeout) never convict; ErrorPayload reverts always convict.
