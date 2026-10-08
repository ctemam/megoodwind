# BSC phantom-cluster diagnosis + live dislocation finding (2026-10-04)

Commander protocol: findings → repo impact → decision → plan → verification.

## Findings

### Phantom cluster root cause — RESOLVED [verified]

The ~26.8M bps / ~$5M simulated "profit" cluster (previously flagged as
suspect in the wallet-intel report) traces to **one degenerate real pool**:

| Pool | On-chain truth [verified via eth_call @ bsc-dataseed] |
|---|---|
| `0x83c38557a0576Ad38dEf24abaFA17c2C218cb9E4` (`V3_ETH_USDT`, fee 100) | Real PancakeSwap V3 contract (real PCS V3 factory `0x0bfbcf9f…`, real ETH `0x2170ed08` / USDT `0x55d39832` tokens, 45,926 B code). **Degenerate price**: slot0 tick=199 → ETH = **1.02 USDT**; liquidity 3.9e10 (vs healthy pool's 2.9e20). Drained/stuck at range extreme — real contract, dead price range. |
| `0x62Cf00528cB7aF872C1f9DD426E655C903F16770` (`V3_ETH_USDC`, fee 25) | Real PancakeSwap V3 ETH/USDC, tick=79,269 → ETH = **$2,769.73** (market-consistent), liquidity 2.9e20, internally consistent slot0. |

Paths pairing the dead 1.02-USDT quote with the honest $2,769 quote
fabricate 26.8M-bps candidates. The ProfitGate correctly rejected all of
them as `implausible` (603 rejects / 3 profile cycles) — no capital was
ever at risk — but each cycle burned eval + probe budget on them.

### Correction to earlier report

The prior governance report flagged `0x62Cf0052` as the suspect pool.
That attribution was wrong: it is correctly priced; `0x83c385` was the
degenerate leg. Apologies for the misattribution.

### New finding: real ~270–281 bps three-way dislocation [verified on-chain]

After removing `0x83c385`, `statecheck` shows the top surviving band
(250–281 bps, ~787 profitable paths pre-gate) is **not** corrupted state —
two venue clusters genuinely disagree on WBNB price *right now*:

| Venue cluster | WBNB implied price | Sources (live eth_call) |
|---|---|---|
| ETH/WBNB V3 pools × deep ETH/USDC | **≈ $810** | `0x62Fcb3C1`/`0xD0e226f6`/`0x0f338Ec1` all quote ETH = 3.417 WBNB (liq 5e21–8e22); × ETH $2,769.73 (`0x62Cf0052`) |
| USDC/WBNB pools | **≈ $787** | `0xf2688Fb5` (liq 4.2e23), `0x81A9b5F1` (liq 1.7e22), `0xd99c7F6C` (PCS V2 reserves) all quote ~787 USDC/WBNB |

Both clusters are internally consistent, liquid, and live. A ~2.9%
cross-venue spread on a flash-token loop (USDC→WBNB→ETH→USDC legs) is a
textbook exploitable dislocation — the largest *honest* edge the engine
has observed. Whether it clears net-after-gas at executable depth is the
exec-probe's job on a live runner; sim alone cannot adjudicate depth.

## Repo impact

- `config/bsc.toml`: removed `V3_ETH_USDT` (`0x83c385…`) — 195→194 pools.
- Path count 28,262→27,602; `evaluate_all` profitable 1,039→787 — every
  removed path contained the dead pool.
- The `implausible` gate verdict remains the correct backstop for
  degenerate pools that slip in via discovery merges; config hygiene now
  matches it.

## Decision

- Remove the degenerate pool from config (data hygiene; it only
  manufactures phantom work). Done — this commit.
- Do NOT hand-tune gates around the remaining 270 bps band: it is real
  state and the gate already accepts it.
- No shim/probe contract needed for diagnosis — direct eth_call
  slot0/liquidity against bsc-dataseed.bnbchain.org sufficed.

## Plan / next verification

- Relaunch runners (blocked on PRIVATE_KEY + PIMLICO_API_KEY,
  `list_secrets` still empty): the exec-probe + strict_4337 UserOps will
  test whether the ~270 bps band survives depth + gas. Settlement loop
  now resolves userOp receipts → realized P&L closes the loop.
- Watch for `0x83c385` re-import via discovery merge — provenance gate
  passes it (real factory + live liquidity >10k); consider adding a
  degenerate-price check (tick at range bound + liquidity below a
  floor) to the merge predicate if it recurs. [assumption: it recurs]

## Update 2026-10-04 07:15 UTC — cluster excised across all 3 chains

The 0x83c385 removal was one instance of a systemic class. Full on-chain audit
of every configured pool (slot0/observationCardinalityNext + reserve checks):

**Signature**: pools seeded with liquidity but never traded
(`observationCardinalityNext <= 2`, no oracle history). Their slot0 quote is
whatever the deployer seeded — decoupled from market — so every path through
them shows a phantom spread vs live partner pools. BSC-Peg ETH market price
verified ≈$2,693-2,696 across 6 independent venues (ETH/USDT V3 deep,
ETH/WBNB x3 V3 + V2, implied via WBNB/USDT $787.45); USDT/USDC 0.9998.

| chain | before | removed | after | paths | profitable(dust-flash) |
|-------|--------|---------|-------|-------|------------------------|
| BSC   | 194    | 94      | 107   | 7,478 | ~42→243 small-bps      |
| ETH   | 80     | 21      | 59    | 3,098 | 0                      |
| Poly  | 104    | 18      | 86    | 3,686 | 0                      |

BSC removals: ~60 obs<=2 V3s (incl. 0x62Cf0052 ETH/USDC @2769 vs 2695 real —
the source of the "verified" 270-280bps dislocation, $11M stale TVL,
obs=1; 0x35Af9EFAc price 3.4e38), 10 dust-TVL V2s ($2-$121 reserves),
all BUSD pools (deprecated token family). Kept 13 THE_* Algebra pools
(live contracts; algebra has no slot0() — not flaggable by this probe).

ETH removals: 21 obs<=2 V3s incl. USDT/WBTC pools quoting WBTC=$849.
Polygon removals: 18 obs<=2 V3s incl. USDC/DAI @1e12.

**Merge-predicate rule for discovery**: reject V3 pools with
`observationCardinalityNext <= 2` (never traded), reject V2 pools below a
USD-TVL floor, and reject pools whose same-pair quote deviates >3% from
the cross-venue median at merge time. This is the systematic version of
the per-pool whitelist review done here.
