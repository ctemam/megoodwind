# D2 — Executor redeploy readiness package

## Bytecode diff (measured live)

| Chain | Deployed `0x6614ecc…025a` | Current build | Delta |
|---|---|---|---|
| eth | 11,060 B | 15,047 B | **−3,987 B** — stale |
| base | 11,060 B | 15,047 B | −3,987 B |
| arb | 11,060 B | 15,047 B | −3,987 B |

Deployed code predates: `V3_POOL` direct-swap leg, `V2_SELFQUOTE` leg,
`liquidate()` path (Aave + Morpho), `onMorphoLiquidate`, self-quote
fee shave — the deployed build also has venue getters that revert
(WO-7S finding), meaning it cannot even answer discovery reads.

## Deploy cost

| Item | Estimate |
|---|---|
| deploy gas | ~1.8–2.0M gas (15,047B bytecode + initcode) |
| eth @ 30 gwei | ≈ 0.054 ETH ≈ $130 |
| base/arb/op @ ~0.1 gwei | < $1 each |

## Dry-run sequence (per chain, before arming)

1. `forge script` / ethers deploy with `BALANCER` + `AAVE_POOL` ctor args
   from `src/exec/flashVenues.ts` — the single venue truth.
2. `transferOwnership(SMART_ACCOUNT)` — only the smart account may exec.
3. **Getter verification** — `balancerVault()`, `aavePool()`, `owner()`
   must answer; the stale deployment fails here (WO-7S evidence).
4. **Fork replay against the NEW address** — rerun the eth canary +
   WO-9 replay harness pointed at the deployed address, not a fresh
   local deploy. `ArbSettled` must reproduce.
5. Arm **one chain in shadow** for ≥72h under Gate B (see
   `docs/wo9_gate_precommit.md`).
6. Only then: capital cap via `OPS_*` env, measured notional.

## Rollback plan

- Old executor `0x6614ecc…` stays deployed and owned; reverting = point
  `chain.executor` config back to it (env change, no redeploy).
- New executor is non-upgradeable — a defect means deploy-fixed +
  re-point, not in-place patch. Rollback cost = one config edit.
- `onlyOwner` + `DIAG_ONLY` hard stop remain in every build; a broken
  deploy can still only execute when armed by config.

## Gates (D4 pre-commitment — binding)

Replay must clear `docs/wo9_gate_precommit.md` Gate A (≥12 candidates,
≥20% settle, ≤5% model error) before the shadow window, and Gate B
(≥72h shadow, ≥1 settle, reverts ≤1% gross) before any capital.

## Commander decision requested

Approve redeploy → I execute steps 1–4 and report the fork-replay
result + gas receipt. Arming stays your call.
