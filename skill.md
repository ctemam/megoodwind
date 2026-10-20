# skill.md — AllBright mathematical toolkit (Item #19)

## Price & quote math (`src/math/`)

- **V2 constant product** — `v2AmountOut(in, {reserveIn, reserveOut}, feeBps)`
  = `in*(10000-fee)*rOut / (rIn*10000 + in*(10000-fee))`. Reserve orientation
  by `token0` match, never by feed ordering.
- **V3 spot** — `v3SpotPrice(sqrtPriceX96, dec0, dec1)` = `(sqrt/2^96)^2 * 10^(dec0-dec1)`.
  Screening approximation multiplies by `(1 - fee)`; final arbiter is the exec-probe.
- **Tick-walk guard** — skip legs whose swap crosses >`MAX_TICK_DISTANCE` (200)
  ticks; beyond that the constant-liquidity approximation breaks (ToR §2).

## Profit constraint

```
net_usd = gross_token_usd
        - (gasUnits * (baseFee + priorityFee) / 1e18) * native_usd   # EIP-1559
        - flashPremium_usd                                          # Balancer 0, Aave 0.09%
        - auction_bribe_usd                                         # AUCTION_CHAINS only
```

- `auction_bribe = (gross - gas - premium) * COINBASE_BRIBE_PCT_MAX` — worst-case
  builder tip deducted BEFORE the floor (honest capturable-net).
- Floor: `net_usd >= MIN_PROFIT_USD` and `STRICT_PROFIT_FLOOR_GUARD` blocks any bypass.
- EIP-1559 circuit breaker: dormant above `MAX_BASE_FEE_GWEI` (300).

## Predictive drift (item #16)

Variants define `slippageBps / minDepthUsd / maxBlockDelay / sizeCapUsd`;
`effectiveGuards()` merges env floors — a variant may only tighten, never loosen.
Projected price is discounted by `slippageBps` before profit check.

## Credibility ceiling

Simulated spreads > ~2% on top-liquidity pairs are fake (`CREDIBILITY_CEILING_PCT`).
A candidate over the ceiling convicts every pool in the path.
