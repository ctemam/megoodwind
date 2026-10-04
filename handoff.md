# Allbright Handoff — 2026-10-04

## Objective
Generate real positive P&L while preserving net-after-gas and literal-route verification.

## Completed
- Removed phantom/dead pools across BSC, Ethereum, and Polygon (obs≤2 V3s,
  dust-TVL V2s, BUSD family; BSC 191→107, ETH 80→59, Polygon 104→86).
- Imported leader-route pools through provenance checks (+55 pools across chains).
- Wired settlement feedback loop (UserOp receipt → realized P&L → health demotion)
  and route_score() candidate ranking.
- Fixed V3 impact overflow, optimizer probe retention, legacy StateReader 5-field
  decoding, AeroV2 stable projection, and zero-tax tolerance.
- Deployed BSC StateReader: `0xa5d75d9941d3878eF5f64537eFad3Bf1fdB19929`
  (sponsored UserOp, zero gas, CREATE2 factory).
- Pushed latency work in commit `28c3cb9` (READER_CHUNK_SIZE=128 + pruned RPC pool).
- BSC refresh improved from ~710 ms mean to ~210 ms mean (p50 ~170 ms);
  zero timeouts/budget overruns since restart.
- All three runners and dashboard are online under PM2 (`pm2 resurrect` restores
  after box restarts; env persisted in `~/.pm2/dump.pm2`).

## Current live truth (post-resurrect, counters reset on restart)
- BSC :9100 — 107 pools / 7,116 paths; evaluating ~50k paths/min; 0 submits.
- Ethereum :9102 — 59 pools / 3,098 paths; 0 submits.
- Polygon :9103 — 86 pools / 3,686 paths; 0 submits.
- Every backrun candidate this session died honestly at re-verify/exec-probe on
  real post-victim state. No positive settled P&L has been proven. The engine
  correctly spends $0.

## Known correction
The previous statement that sub-10 ms or sub-40 ms refresh is impossible on
public RPC was unsupported and must not be repeated. The measured ~140 ms was
an observed endpoint RTT on the tested endpoints, not a proven lower bound.
The honest status: the fix reduced refresh latency substantially, but the
<40 ms target is "not achieved in the tested environment," not "impossible."

## Required next work
1. Add per-StateReader-method latency metrics (histograms, endpoint labels)
   rather than relying on aggregate `arb_state_refresh_seconds`.
2. Benchmark persistent HTTP/2, WebSocket reads, paid RPC, geographically local
   RPC, and local/dedicated node options.
3. Separate network RTT, StateReader execution, ABI decode, and PoolStore
   update timings.
4. Verify whether the <40 ms target is achievable with an appropriate provider.
5. Continue monitoring for the first exec-probe pass, UserOperation dispatch,
   and settlement.
6. Optional: StateReader deploys on ETH + Polygon via the same zero-gas
   sponsored-UserOp path (needs Commander approval per deploy4337 warning).
7. Structural: executor access-model change for same-block backruns — needs
   Commander sign-off (contract change + new addresses on 3 chains).

## Relevant code
- StateReader batching/failover: `crates/arb-state/src/refresher.rs`
- BSC RPC pool: `config/bsc.toml`
- PM2 environment: `ecosystem.config.json`
- Executor access model: `contracts/src/BaseFlashArb.sol` (onlyOwner →
  Pimlico smart account `0x18ED4911Eede0c7850db1c51690B6ed076d9d8d2`)

## Gotchas for the successor
- `pm2 restart` after resurrect does NOT pick up new ecosystem env —
  `pm2 delete <app> && pm2 start ecosystem.config.json --only <app> && pm2 save`.
- Public RPCs 403 the urllib default UA — use a real User-Agent header.
- `deploy4337 --calldata-file` rejects the `0x` prefix.
- PM2 logs are instance-suffixed: `~/.pm2/logs/allbrightA-<name>-out-<id>.log`.
- Secrets live in repo `.env` (PRIVATE_KEY, PIMLICO_API_KEY); env file CRLF
  must be stripped (`tr -d '\r'`) before `set -a; source`.

## Resignation
The outgoing lead has reported the work honestly and is handing ownership to
the replacement agent. No claim of positive P&L or fully solved latency should
be made without new measurements.
