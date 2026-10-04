# RPC latency: transports, endpoints, and the measured floor

Date: 2026-10-04. Trigger: Commander order ("go and learn, then fix") after the
rejected "<10 ms unreachable on public RPC" claim. The claim was withdrawn in
`handoff.md` — ~140 ms was an observed endpoint RTT, not a bound. This file is
the researched + measured position.

Legend: [verified] = directly measured on this VM against live BSC endpoints
on 2026-10-04; [industry] = published industry practice/benchmarks; [inference].

## Findings

- [industry] Warm keep-alive public endpoints elsewhere bench p50 22–33 ms
  (e.g. blazed.sh 2025 ETH-RPC benchmark from a US vantage). Latency is a
  property of <client vantage, endpoint>, not of a transport class alone.
- [industry] Node-side `eth_call` execution for small batched reads is O(1 ms)
  or less; the wire dominates. IPC on the same host is sub-ms; localhost WS is
  single-digit ms. The only proven <10 ms path is a local or co-located node —
  this is why MEV searchers run their own nodes.
- [verified] This VM (unspecified hosting region) → BSC public endpoints, 10
  warm samples each via `latency_bench` (warm `eth_blockNumber` + a real
  `eth_call` of `IStateReader.readV2` on 8 live pools at 0xa5d75d…929):
  - bsc-dataseed2.binance.org: blockNumber p50 58.7 ms, readV2 p50 59.8 ms
  - bnbchain dataseeds + binance.org + nodereal + ankr + bnb48club-purge:
    ~60–77 ms
  - publicnode HTTPS: 71–85 ms; publicnode WSS: 82–98 ms (persistent socket —
    still network-bound, slightly higher header overhead)
  - blastapi / 48.club / 0.48.club / ninicoin / defibit: ~86–97 ms
  - dwellir full-node endpoint: p50 216 ms blockNumber and EVERY `eth_call`
    failed (403/timeout across all samples) — broken for our reads; dropped
    from `config/bsc.toml`.
- [verified] Previous box measured ~140 ms to the same class of endpoints —
  the two-VM delta (~80 ms) is pure vantage. Confirms RTT is client-side.
- [verified] From THIS vantage no endpoint achieved a <40 ms call p50;
  <10 ms was not approached by any of 27 tested endpoints/transports.
- [verified] Decode is noise: `readV2` 8-pool ABI decode measured in-code is
  on the order of 10–50 µs/call (sub-ms); the multicall result extraction is
  the same class. Network is 99%+ of observed wall time.

## Repo impact

What was making refresh wall time *worse than the endpoint floor*:

- `PoolState::pick` was strict round-robin across a mixed-quality pool —
  one 90 ms + one 216 ms endpoint inflates every refresh vs the 60 ms class.
  [repo evidence] endpoint.rs.
- `multicall_aggregate3` ran `aggregate3` batches sequentially — N batches =
  N serialized RTTs. Same for the four `_mc` fallback chunk loops.
  [repo evidence] refresher.rs.
- dwellir was in `rpc_https_pool` but fails every `eth_call` — every pick of
  it produced a breaker trip + retry, adding a full RTT of waste.
- There was no per-method/per-endpoint latency visibility — the 140 ms figure
  was a single HTTP probe with no method split, no decode split, no store
  split.

## Decision

1. Measure, then improve, in the same change:
   - `arb_reader_rpc_seconds{method,endpoint}` histogram per StateReader/
     aggregate3 call, `arb_reader_decode_seconds{method}` for client-side ABI
     decode, `arb_state_refresh_phase_seconds{phase}` splitting refresh into
     rpc|decode|store|wall; `arb_rpc_http_seconds{endpoint,method}` in the
     transport MetricsLayer for everything else.
   - `latency_bench` bin: per-endpoint cold/warm blockNumber + real
     `readV2`/`getReserves` call over HTTPS and WSS — reproduces any claim.
2. Cut wall time to endpoint floor:
   - EWMA latency-biased read-pool pick (fast_enough = within 1.5×+20 ms of
     best warm endpoint; unmeasured endpoints get probes to fill EWMA).
   - Parallel `aggregate3` batches + parallel fallback chunk loops
     (`futures::join_all`, order preserved).
   - Prune broken/slow endpoints from `config/bsc.toml` (dwellir, blastapi,
     both 48.club) — every remaining endpoint benched ≤ ~85 ms.
3. Reporting rule (standing): latency statements cite measured p50/p99 +
   vantage. No absolute "X is impossible" claims about remote endpoints —
   they are falsified by vantage changes.

## Plan / verification

- [verified] `cargo build --workspace` clean; `cargo test -p arb-state
  -p arb-rpc` 12/12 pass; `validate-pools config/bsc.toml` → 424/424 pool
  validations pass on live BSC state through the instrumented refresh path.
- [verified] Metrics fire on every call (histograms registered lazily; live
  output via `/metrics` in the runner, values in the refresh debug log).
- Remaining, needs Commander sign-off or infra:
  - <40 ms from a different vantage: plausible per industry benchmarks;
    test = rerun `latency_bench` from a closer region or against a paid
    endpoint (Chainstack/QuickNode grow tier with dedicated node).
  - <10 ms: requires local/co-located node (IPC/localhost WS). A paid
    dedicated BSC node next to the fleet VM is the honest path; a public
    endpoint cannot be guaranteed to hit it.
  - `spec::RPC_MAX_LATENCY_MS = 10` is a compile-time constant in
    `crates/arb-runner/src/config.rs`; today it is only a probe/test
    threshold, not a gating budget — flagged as a misleading constant.
