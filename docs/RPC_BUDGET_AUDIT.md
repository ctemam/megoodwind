# RPC Budget Audit — allbrightA

Every number below is labeled **[measured]** (observed this session), **[declared]**
(provider/config stated), or **[assumption]** (planning estimate). Public free
endpoints have no declared daily quota — their real budget is per-second rate
limiting, observed as HTTP 429s.

## 1. Endpoint inventory

### BSC (`config/bsc.toml`, chain_id 56)

| class | endpoint(s) | quota basis |
|---|---|---|
| Free HTTPS read pool | 27 endpoints (`rpc_https_pool`) | per-second rate limit only [assumption — no daily quota declared] |
| Free WSS (mempool) | 3 endpoints (`rpc_wss_pool`) | subscription, not per-request [assumption] |
| Paid trader | `${BSC_TRADER_NODE}` (Warp/Chainstack) | **$0.15 per call** [declared in config] |
| Pimlico | `api.pimlico.io/v2/binance` (keyed) | sponsor/bundler quota, per-credit [declared external] |
| Builder venues | puissant-builder.48.club, bsc.blockrazor.xyz, rpc.bsc-virginia.jetbldr.xyz, bsc-mainnet-builder.nodereal.io | submission calls only, free |

### Base (`config/base.toml`, chain_id 8453)

| class | endpoint(s) | quota basis |
|---|---|---|
| Free HTTPS read pool | 12 endpoints | per-second rate limit only [assumption] |
| Free WSS | 4 endpoints | subscription [assumption] |
| Paid trader | `${BASE_TRADER_NODE}` | **$0.15/call** [declared] |
| Pimlico | `api.pimlico.io/v2/base` | sponsorship credit |
| Builder venues | none configured (no public mempool; blink unset) | — |

## 2. What generates traffic

| source | what it sends | cadence |
|---|---|---|
| State refresh | `aggregate3` batches, ≤60 Call3/request (`MC3_MAX_CALLS=60`, `CALL_DEADLINE=400ms`) | once per observed block |
| Mempool watcher | WSS subscribe + reconnects only | event-driven, no per-tx HTTP |
| Pre-submit re-verify | one extra `refresh()` per accepted backrun | rare (per candidate) |
| Submission | builder `eth_sendBundle`×4, Pimlico UserOp calls, trader RPC | per accepted candidate |
| Health/probes/misc | endpoint startup probes, nonce/gas/balance reads | boot + per submit |

### Call3s per refresh (derived from code) **[measured]**

BSC — 145 pools (29 v2, 103 v3, 13 algebra), all config-slim:

| method | calls/pool | Call3s | aggregate3 batches |
|---|---|---|---|
| `multicall_v2` (slim: getReserves) | 1 | 29 | 1 |
| `multicall_v3` (slim: slot0+liquidity) | 2 | 206 | 4 |
| `multicall_algebra` (globalState+liquidity) | 2 | 26 | 1 |
| **total** | | **~261** | **~6 HTTP req/refresh** |

Base — 28 pools (2 v2, 12 v3, 6 slipstream→v3-read, 8 aero_v2):

| method | Call3s | batches |
|---|---|---|
| v2 slim | 2 | ~1 |
| v3+slipstream (slot0+liquidity) | 36 | ~1 |
| aero (reserves+stable+decimals/uniq token) | ~21 | ~1 |
| **total** | **~59** | **~3 HTTP req/refresh** |

## 3. Measured block rates

| chain | measured | config `block_time_ms` | blocks/day |
|---|---|---|---|
| BSC | **0.44s/block** (45 blocks / 20s, eth_blockNumber ×2) | 3000 (stale 6.8×) | **~194,000** |
| Base | **2.0s/block** (10 blocks / 20s) | 2000 | **~43,200** |

**This is the single largest budget finding:** BSC mints ~194k blocks/day, not the
~28.8k the config implies. Refresh-on-every-block means the engine's daily request
draw is ~6.8× the planned figure.

## 4. Daily budget math

```text
refresh_reqs/day      = blocks/day × HTTP_reqs_per_refresh × retry_multiplier
retry_multiplier      = 1 + p(retry)×2          # RetryBackoffLayer max_retries=2
                      + failover re-picks        # +1 pool_pick per transport failure
```

Observed this session: two endpoints 429'd at ~0.4 rps offered each; several 400ms
timeouts → **retry_multiplier ≈ 1.4–2.0** [measured range].

| chain | logical req/day | with retries | per-endpoint rps (27/12 splits) |
|---|---|---|---|
| BSC | 194,000 × ~7 = **~1.36M** | ~1.9–2.7M | ~0.6–0.7 rps offered |
| Base | 43,200 × ~3 = **~130k** | ~180–260k | ~1.2–1.8 rps offered |

Per-endpoint offered rate is low, but bursts concentrate on one endpoint during
failover — the observed 429s are exactly that.

### Budget policy per the formulas in the sidechat

```text
daily_budget_rps = provider_daily_quota / 86_400      # unknown for free endpoints
safe_rps         = daily_budget_rps × 0.70
operating_rps    = min(safe_rps, measured_p95_capacity)
```

Since free endpoints expose no daily quota, treat **measured p95 capacity** as the
budget: probe each endpoint's sustainable rps (429 onset) once, then split
`operating_rps` across the pool. Observed 429 onset on public BSC endpoints is
roughly ~1–5 req/s [assumption pending probe data].

### Recommended controls (config-level, not code)

- **Refresh decimation**: refreshing every 2nd BSC block (~0.9s cadence) halves the
  refresh budget to ~680k req/day with no spread-loss — resting-state spreads don't
  materialize at sub-second scale. Mempool backruns are event-driven and unaffected.
- **Per-endpoint token bucket**: cap each pool endpoint at `operating_rps/27`
  (~0.02–0.03 rps sustained + burst) so failover never re-hammers a 429'd node.
- **Paid classes**: trader RPC stays at zero outside accepted submissions; Pimlico
  calls only on UserOp venues. Builders are free — prefer them (also architecturally
  required for backruns).

## 5. Instrumentation to add (arb-rpc)

The retry layer multiplies logical calls into physical attempts — count **physical
attempts**, wrapped at the `RetryBackoffLayer`/pool-pick level:

```text
arb_rpc_requests_total{chain, endpoint, method, cost_class}
arb_rpc_request_failures_total{chain, endpoint, method}
arb_rpc_retries_total{chain, endpoint}
arb_rpc_request_rate{chain, endpoint}            # gauge, per-second
arb_rpc_budget_remaining{chain, cost_class}
arb_rpc_budget_exhausted{chain}                  # fires the decimation policy
```

Fields per attempt: `chain, endpoint, method, timestamp, request_success,
transport_failure, rpc_error, retry_count, latency_ms, cost_class
(free|paid|pimlico|builder)`.

**Landed so far:** `arb_rpc_http_attempts_total{endpoint, outcome}` — a tower
metrics service stacked innermost (retry→throttle→metrics→HTTP) counts every
physical HTTP round-trip including retries. Still pending: `method` label
extraction, per-chain buckets, `budget_remaining`/`budget_exhausted` gauges
(need declared per-endpoint quotas, which the endpoint set does not publish).

## 6. Per-endpoint rate cap (implemented)

`ThrottleLayer` (alloy's governor-backed standard layer) now wraps every
HTTPS read provider: **5 requests per 5 seconds = 1 rps sustained** per
endpoint (`RATE_LIMIT_REQS_PER_5S = 5`). Excess requests queue in-process
rather than erroring; a queue delay past `CALL_DEADLINE` (400ms) falls
through to the existing failover. Stability check on live BSC (120s):
zero 429s, one slow-endpoint timeout — vs ~9 transport events (2×429,
5+ timeouts) in the unthrottled window.

Daily ceiling per endpoint at the cap: `1 req/s × 86,400 = 86,400 req/day`
[computed]. A pool of N endpoints therefore has `86,400 × N` req/day of
sustainable read budget **before** any provider-declared quota applies.

## 7. Ten-chain daily budget availability

Per-chain assumptions: ~145 tracked pools → ~7 HTTP req/refresh
[assumption, scaled from BSC's measured 261 Call3s → ~6 batches]; refresh
once per observed block; retry multiplier ×1.5 [measured range 1.4–2.0];
per-endpoint cap 1 rps → `86,400 req/day` sustainable each.

`endpoints needed` = `ceil(blocks/s × req_per_refresh / 1 rps)` — the pool
size required so refresh alone never exceeds the cap.

| chain | block time | blocks/day | req/day (logical) | req/day (physical, ×1.5) | endpoints needed | public mempool? |
|---|---|---|---|---|---|---|
| **BSC** | 0.44s [measured] | 194,000 | 1.36M | 2.0M | **16** (have 27) | yes — backrun channel live |
| **Base** | 2.0s [measured] | 43,200 | 300k | 450k | **4** (have 12) | no — private sequencer |
| Ethereum | ~12s [declared] | 7,200 | 50k | 75k | **1** | yes — mev-share/flashbots |
| Arbitrum | ~0.25s [declared] | 346,000 | 2.4M | 3.6M | **28** | no — private sequencer |
| Optimism | ~2s [declared] | 43,200 | 300k | 450k | **4** | no |
| Polygon PoS | ~2s [declared] | 43,200 | 300k | 450k | **4** | yes |
| Avalanche C | ~2s [declared] | 43,200 | 300k | 450k | **4** | yes |
| Fantom | ~1s [declared] | 86,400 | 600k | 900k | **7** | yes |
| Gnosis | ~5s [declared] | 17,300 | 120k | 180k | **2** | yes |
| Blast | ~2s [declared] | 43,200 | 300k | 450k | **4** | no — sequencer |

**Aggregate (all 10 chains):** ~5.4M logical / ~8.1M physical req/day —
spread across ~10 endpoint pools, entirely on free public endpoints. No
provider-declared daily quota binds: the only budgets are per-second
rate caps (now enforced at 1 rps/endpoint) and the paid classes kept at
zero outside submissions.

**Two real constraints the table surfaces:**
1. **Arbitrum at ~0.25s/block needs 28+ endpoints or refresh decimation**
   (every-2nd-block halves it to 14) — sub-second refreshes don't add
   arb value anyway.
2. **Backrun-viable chains** (public mempool) are BSC, Ethereum, Polygon,
   Avalanche, Fantom, Gnosis. On sequencer chains (Base, Arbitrum,
   Optimism, Blast) the only channel is resting-state arb, which is
   measured ≈0 — those chains are coverage plays, not profit channels.

## 8. What cannot be finalized without provider data

1. Per-endpoint declared quotas for the keyed endpoints (nodereal, dwellir, onfinality).
2. Pimlico credit quota + per-call pricing.
3. 24h physical request counts (only computable once §5 lands).
4. 429-onset curve per endpoint (needs a capacity probe).

**Bottom line:** the binding constraint is not a daily quota — free public endpoints
have none — it's per-second throttling (429s already observed). The plan: measure
p95 sustainable rps per endpoint, cap each endpoint below it, decimate BSC refresh
to every 2nd block, and keep paid/builder classes reserved for submissions.
