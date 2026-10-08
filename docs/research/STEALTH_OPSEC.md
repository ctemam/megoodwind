# Ghost / Stealth OPSEC — detection and attack surfaces, with defense layers

Research basis: salmonella/poison-token literature (mev.wiki), the June-2026
jaredfromsubway counter-MEV honeypot (~$7.5M drained via counterfeit tokens +
sham pools + standing-allowance sweep, Blockaid/OAK writeups), and standard
searcher-attribution heuristics (funding-graph clustering, behavioral
fingerprinting, bundle-structure analysis, bytecode matching — ChainScore
taxonomy).

Honest scope: on-chain actions are public. Perfect invisibility is
impossible. The goal is (a) raising the cost of attributing allbright's
wallets/contracts to one operator, and (b) making bait-based attacks
structurally unprofitable to run against us.

## How competitors find a bot like ours

| signal | what it leaks |
|---|---|
| Funding graph | EOAs funded from the same source cluster into one operator |
| Contract bytecode | redeployed executors match by initcode/opcode histogram |
| Bundle structure | recurring `[victim, ours]` position, tip split, target sets |
| Gas/timing fingerprint | same priority fee formula, same cadence |
| RPC probe patterns | bursts of `eth_call` on specific pools reveal what we watch |
| Profit flows | accumulation wallet links every tx back to us |

## How competitors attack

| attack | mechanism | our exposure |
|---|---|---|
| **Counterfeit pool/token bait** (jaredfromsubway pattern) | sham pools with fake tokens priced to look arb-able; bot's route leg touches them | HIGH via pool auto-import — any address in a leader route could be bait |
| **Salmonella token** | ERC20 returns ~10% to non-owner while emitting full-amount Transfer logs | medium — our path math is curve-based; only exec-sim of the route reveals it |
| **Standing-allowance drain** | route tricks bot into approve()ing attacker contracts | LOW — executor uses callback-pull/transfer-then-swap; only approvals are Aave premium (scoped, same tx) and owner-gated `approveToken`. Watch: PCS Stable/Wombat approve-pull paths — keep approvals exact-amount, never unlimited |
| **Griefing / revert farming** | spam victim txs engineered to make our bundle revert → we burn tip gas | medium — circuit breaker exists (per-path revert suppression) |
| **Builder/venue blacklisting** | fingerprinted bundles get deprioritized at builders | medium — bundle structure variance helps |
| **Counter-backrunning** | a second bot lands right after ours | unavoidable, symmetric game |

## Defense layers

### L0 — Identity separation (ops, config)
- Distinct EOAs per role: submitter ≠ profitsweep ≠ owner. Fund each from
  independent sources (separate CEX withdrawals), never EOA→EOA direct.
- Profit sweep address NOT embedded in tx data competitors can grep.

### L1 — Fingerprint rotation (code + ops)
- Rotate submitter EOAs on a schedule (registry support for N keys).
- Redeploy executor periodically with cosmetic bytecode changes
  (constructor args, dead-code ordering) to break initcode hashing.
- Vary bundle tip split and gas strategy slightly per epoch.

### L2 — Traffic hygiene (mostly built)
- Probe/sim calls spread across the 27-endpoint read pool (done —
  `pool_pick` round-robin + 5req/5s throttle).
- Provenance probe in `leader_scan` uses pool_pick, not the hot provider.
- Refresh batches via Multicall3 already — keep probe bursts inside
  existing refresh traffic where possible.

### L3 — Bait/poison defense (built this phase)
- **Provenance gate at import**: `leader_scan` now classifies each
  auto-imported pool as `deep`/`thin`/`suspect`:
  - V2: both `getReserves` legs > raw floor
  - V3: `liquidity()` > floor
  - both token0/token1 must hold >100 bytes of contract code
  - only `deep` pools are exported to `_pools.toml` — thin/suspect are
    logged (prov=) and skipped, so sham pools can never enter our graph
- **Divergent-state quarantine** (existing): >3× price divergence vs
  same-pair peers — catches manipulated/sham pricing live
- **victim_usd sanity bound** (existing): decode-garbage victim sizes
  dropped before evaluation
- Exec-probe before submit runs the actual route as eth_call —
  salmonella behavior (returning less to non-owner) surfaces as a
  simulated shortfall/revert, so the poison never reaches a bundle

### L4 — Attack telemetry (partially built)
- Circuit breaker: per-path consecutive-revert suppression (exists)
- Recommended next: alert on revert-rate spikes aggregated across paths
  (= griefing campaign), and on a pool that repeatedly produces
  gate-pass → revert sequences (bait signature)

## Residual risks (honest)
- An adversary seeding a *deep, well-funded* honeypot passes L3 — the
  remaining defense is exec-probe shortfall detection; keep it mandatory.
- Funding-graph clustering defeats signer rotation if funding isn't
  separated — L0 is ops discipline, not code.
- On-chain profit flows are forever public; assume eventual attribution
  and make baiting economically unrewarding instead of relying on secrecy.
