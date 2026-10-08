# Flash-borrow liquidity matrix — measured on-chain 2026-10-06

Where `executeV4Arbitrage` can actually borrow, per chain. `take(asset)`
draws the token balance the chain's V4-style PoolManager custodies; a
zero balance means every borrow of that asset reverts at sim/probe.

| Chain | PoolManager | Asset | Held (units) | ~USD |
|---|---|---|---|---|
| BSC | `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df` (PCS V4) | USDT | 11,052,950 | $11.0M |
| BSC | same | ETH | 102.66 | $275k |
| BSC | same | BTCB | 10.47 | $886k |
| ETH | `0x000000000004444c5dc75cB358380D2e3dE08A90` (UniV4) | USDC | 68,055,630 | $68M (re-measured) |
| Polygon | `0x67366782805870060151383f4bbff9dab53e5cd6` | WETH | 333.58 | $890k |
| Polygon | same | USDT | 880,075 | $880k |
| Polygon | same | USDC | 2,593,856 | $2.6M |

## Consequences [verified]

- **BSC**: all configured flash_quotes (WBNB/USDT/USDC/FDUSD/BUSD/ETH/BTCB)
  borrowable. `supportedTokens(BTCB)=1` set via sponsored admin UserOp
  `0x387bba518f6de47150586dbbd48b1d50b7427edcd73eae43d82d4795ce8d1ea0`
  (`setTokenSupport`, `admin_call` bin).
- **ETH**: **CORRECTION — earlier "PM holds zero" measurement was wrong.**
  At block 26136059 the UniV4 PoolManager flashed 456,612,926 USDC to the
  executor for the first landed mainnet arb
  (tx `0xc673890c76700792d278231a04446e6b1528e726a69ccc286736450065a31105`),
  and it custodies ~$68M USDC now. `executeV4Arbitrage` borrow on ETH
  mainnet is PROVEN working end-to-end on-chain. (The zero reading is
  believed to have been a bad RPC response being trusted — asset/address
  were canonical; treat any "empty PM" reading as suspect until confirmed
  by a second RPC.)
- **Polygon**: borrow plane healthy across stables + WETH; WBTC
  `supportedTokens=0` on the Polygon executor — register via `admin_call`
  if token-token pairs there start producing candidates.

## Method
`eth_call balanceOf(<PoolManager>)` per asset on the chain's public RPC;
`supportedTokens(address)` reads on each executor; POOL_MANAGER() read on
each executor. No cost, read-only.
