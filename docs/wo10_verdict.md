# WO-10 — liquidation lane verdict

**Status: capability PROVEN on fork; settlement on live state gated (redeploy pending).**

## Evidence (all real, no mocks in the profit path)

- **Contract:** `liquidate(LiqPlan)` added to `AllBrightExecutor.sol` — flash debt asset (Balancer 0% / Morpho 0% / ERC3156 / Aave) → `liquidationCall` seizes collateral at on-chain bonus → `runHops` sells collateral → repay + `minProfit` floor → `LiquidationSettled` event. All four flash callbacks branch on the liquidation path; atomic revert preserved.
- **Fork proof (eth, real Aave V3 pool `0x8787…`):**
  - position: 150 WETH supplied, $269,864 USDC borrowed → HF 1.1069
  - oracle override −30% (MockAggregator over the real Chainlink feed slot — fork-local) → HF 0.7748
  - `liquidate()` execProbe **PASS**, tx settled: gas 498,853, `LiquidationSettled` profit **$61,802** USDC (cover 50% of debt, seized discounted collateral sold at real market).
- **Index lane:** `src/liquidation/lane.ts` — Borrow-event borrower indexer (`topics[3]=onBehalfOf`) + `getUserAccountData` batch over aggregate3 + R5 mechanics (50% close, 100% at HF<0.95, net bonus = (bonus−1)(1−protocolFee)).

## Measured reality check (not in the WO text — Commander should see)

- eth Aave V3: **7 borrowers in last 30k blocks (~4 days), zero with HF < 1.05**. Liquidatable positions on mainnet are rare, competed hard, and gone within a block. This lane is real but thin — it is an opportunity *detector* problem (HF-band watching + oracle-update triggers), not a capability problem.
- Profit exists only while positions exist: this lane earns in volatility crashes, not steady state.

## Honesty flags

- `syncBorrowers` chunks getLogs at 5k blocks — respects the Ankr-class archive limits; a production run should persist `lastScan` per chain (currently in-memory per process).
- `liquidate()` trusts the plan's `protocol`/`user`/`debtToCover` — safe because only `onlyOwner` encodes plans, but the lane planner must read close factor + bonus from chain state per candidate (done via `getUserAccountData` + reserve config, not hardcoded).
- Morpho Blue / Compound V3 deployments are **not yet wired** — WO-10 lists them; Aave V3 covers all 5 chains first. Morpho markets need per-market `Id` discovery (next iteration).

## Gate assessment

- Capability: **PASS** (fork settlement, atomic, fail-closed).
- Live deployment: **GATED** — requires executor redeploy (Commander decision, same gate as WO-9 step 6).
