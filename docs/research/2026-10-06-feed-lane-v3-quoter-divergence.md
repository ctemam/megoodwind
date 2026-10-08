# Feed lane: V3 local quoter diverges from on-chain executable output — QuoterV2 verify gate

Date: 2026-10-06 · Engineer: FEED lane · Branch: devin/1791013932-backrun-projection

## Findings (all [verified] via live eth_call on free public RPC)

**Measured divergence, local `V3PoolState::quote` vs PCS QuoterV2
(`0xB048Bbc1…5997`) on BSC, $2k and $20k notionals:**

| pool | notional | local single-tick vs QuoterV2 | haircut vs QuoterV2 |
|---|---|---|---|
| BTCB/USDT 0.05% | $2k / $20k | +0.0 / +0.0 bps | +0.0 / +0.0 |
| USDT/USDC 0.01% | $2k / $20k | +0.0 / +0.0 | +0.0 / +0.0 |
| CAKE/USDT 0.25% | $2k / $20k | +0.0 / −0.0 | +0.0 / −0.0 |
| BTCB/WBNB 0.05% | $2k / $20k | +0.7 / **+196.3** | +0.7 / +196.3 (never fired) |
| ETH/WBNB 0.05% | $2k / $20k | −0.2 / **+7676.1** | −0.2 / +7676.1 (never fired) |
| BTCB/WBNB 0.25% | $2k / $20k | **+2736.1** / +23602.8 | +2486.5 / clamped at −50% |
| CAKE/WBNB 0.05% | $2k / $20k | **+13301.9** / +100445.3 | +13301.9 / clamped |

Matches the lead's measured case (feed sim +16.9bps vs QuoterV2 −23bps on
BTCB/WBNB). Two structural facts:

1. **Deep pools are exact** — when the swap stays inside the active tick's
   liquidity, constant-L math equals QuoterV2 to the wei.
2. **The haircut can't be calibrated into correctness** — divergence on
   thin pools is +196…+100000bps, non-monotone in utilization (it doesn't
   fire at all on some +196bps and +7676bps cases: the `reserve_in`
   proxy `L·Q96/√P` under-measures real tick-spread depth), and saturates
   at −50% while real error runs to −99%. No constant fixes this; the only
   correct local model needs the tick bitmap + per-tick liquidity —
   i.e. TickLens-class reads per pool per candidate.

## Feasibility under FREE-RPC constraint [verified]

- **TickLens/tick-bitmap local model**: technically possible (PopulatedTick
  reads are staticcall-able) but needs many calls per pool per amount and a
  full in-Rust tick-crossing simulator — a new wheel, rejected by mission
  rules.
- **QuoterV2 `quoteExactInputSingle` via eth_call**: deployed on every
  chain we run, free on public RPC, runs the real multi-tick swap in the
  real pool contract — the industry-standard lens every UniV3 bot uses.
  **Chosen.**

## Decision

New verify step in `verify_and_submit` (step 4b), after the gas-floor
check and before calldata/probe:

- For each hop that is `Protocol::UniswapV3`, re-quote the leg on-chain via
  QuoterV2 at the sim's *chained* amount (hop 2's input = hop 1's real
  output). V2/AeroV2 legs keep the local quote — constant-product is exact.
- If the on-chain round trip can't cover `min_net_usd` after gas → reject
  `v3_quoter_divergence`, metric `arb_feed_rejects{v3_quoter_divergence}`,
  **no pool strike** (the error is our model's, not the pool's).
- Fail-open: if any UniV3 leg's quoter can't be resolved, the check is
  skipped and the revm exec-probe remains the gate.

### Wrong-pool hazard eliminated [verified]

A QuoterV2 silently derives the pool from *its own* factory's create2 for
(tokenIn, tokenOut, fee). A same-tokens-same-fee pool under another factory
would get priced instead of the hop's pool — observed live: the
DS "uniswap"-tagged BSC pool `0x47a90a2d…` answered the PCS quoter before
the pin existed. `v3_quoters(chain)` now maps quoter → factory and
`factory.getPool(tin, tout, fee) == hop.pool` is confirmed before the
quoter's answer is trusted (one extra view call per pool, cached).

Factory truth verified on-chain via `quoter.factory()`:
- BSC: PCS QuoterV2 `0xB048Bbc1…` → factory `0x0BFbCF9f…1865`;
  UniV3 QuoterV2 `0x78D78E42…` → factory `0xdb1d1001…4461f7` (the community
  UniV3-BSC deployment DS tags "uniswap", *not* canonical `0xdB1d…Ba9745`).
- ETH/Polygon/Arbitrum/Optimism: canonical QuoterV2 `0x61fFE014…`
  → factory `0x1F98431c…F984`.

## Verification

`feed_probe` now prints `qv2=<on-chain net>(<div>bps)` per candidate using
the identical chain. Live BSC run (13 candidates): every V3 leg resolved —
PCS pools via PCS quoter, the `uniswap-bsc` pool via `0x78D7…` after the
factory pin — all `qv2=$0.00`, consistent with local sim (honest market).
Polygon: UniV3 legs resolve via `0x61fFE014…`; a `sushiswap`-tagged leg
fell back `qv2=n/a` (Sushi V3 factory unmapped) → probe backstop [verified].

## Residuals / honest limits

- Algebra/Slipstream/Sushi-V3 legs stay local (their quoter ABIs differ —
  Algebra Quoter returns a different tuple) → exec_probe covers them; add
  factory mappings only if such pools start passing the sim stage.
- QuoterV2 eth_call costs ≤2 free calls per candidate, only after the local
  sim+gas gates pass (~10-20 candidates/cycle worst case).

## Locks added

- `v3_quoters_pairs_each_deployment_with_its_factory` — deployment table.
- LOCKED_MODULES row: "Feed verify re-quotes UniV3 legs on-chain".
