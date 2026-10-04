# Remaining-weakness fixes: UniV4 pools, private orderflow, premium RPC

Date: 2026-10-04. Commander order: "fix remaining 3 issues" — the three
infra-adjacent weaknesses left open by `2026-10-04-weakness-removal.md`:

1. resting-state arb is dead without a closer/co-located BSC RPC
2. UniV4 pools are not enumerable/readable/executable
3. private orderflow is invisible to public pending streams

Honest boundary restated: items (1) and (3) end in a provisioning decision
only the Commander can make (a paid endpoint / feed key cannot be
purchased from a session). This change ships everything that is code —
the moment a key lands in an env var the plumbing is live — and proves
item (2) end-to-end against the real chain.

## Decision

- V4: implement read+enumerate+execute support end-to-end, keyed off the
  deployed contract's already-verified `POOL_MANAGER()` singleton.
- Private orderflow: multi-source WSS watcher with per-source auth so a
  private tx-feed (Mempool Stream, mevshare-style, builder direct) plugs
  in via config; every source is labeled in logs with credentials
  stripped.
- RPC: no new code needed — the read pool already takes a prioritized
  `rpc_https_pool` list and `${VAR}` env expansion is in `load_config`.
  What was missing was procurement guidance; it is below.

## Repo impact — UniV4

A V4 pool is state inside the PoolManager singleton — there is no pool
contract to call, so `address` in a `[[pools]]` entry is reinterpreted as
the 32-byte poolId, and the last 20 bytes ("pseudo address") become the
PoolStore/hop key everywhere an `Address` is required.

- `arb-paths`: `V4Key` struct (`currency0/currency1/fee(pips)/tick_spacing/
  hooks`); enumerator no longer skips `Protocol::UniswapV4`.
- `arb-runner/config.rs`: `PoolEntry` gains `tick_spacing`, `hooks`,
  `fee_pips` (sub-bps fees can't be expressed in u32 bps — the BSC
  USDT/USDC main pool is 1 pip); `pseudo_address()`, `v4_key()`,
  `v4_pool_id()`; `resolve_v4()` produces `(V4PoolSpec[], keys, invalid)`
  and the runner drops invalid entries from the graph. Discovery merges
  can never yield V4 pools (no poolId) and are skipped explicitly.
- `arb-state`: `V4PoolSpec` + `StateRefresher::with_v4_pools`;
  `multicall_v4` reads `extsload([slot0, liquidity])` per pool through
  Multicall3 and merges results as `PoolState::V3` (identical CL math).
- `arb-submit`: `build_bundle`/`PresignPool::new_with_v4` populate the
  real `PoolKey` on V4 hops; a V4 hop with no key is a hard error, an
  unkeyed path is skipped at presign.
- `arb-rpc`: `ChainConfig.v4_pool_manager`.
- `config/bsc.toml`: `v4_pool_manager = 0x28e2ea09...9df` (the exact
  address the deployed contract was constructed with — [verified] via
  on-chain `POOL_MANAGER()` call) plus four live USDT/USDC pools.
- `ethereum.toml`/`base.toml`/`polygon.toml`: commented `v4_pool_manager`
  values with the per-chain UniV4 singletons.

## Repo impact — private orderflow

- `arb-mempool`: `WssSource { url, auth }`; `MempoolWatcher::with_sources`
  accepts mixed public + private feeds; `connect` builds
  `WsConnect::with_auth_opt(Authorization::Raw)` — alloy's connector
  already maps `wss://user:pass@` userinfo to a Basic header, and `Raw`
  carries bearer-style tokens. `sanitize_url` strips credentials from
  every log line.
- `arb-rpc`: `ChainConfig.private_mempool_wss: Vec<String>` +
  `private_mempool_auth: Option<String>`.
- `runner` + `profit_profile` merge `cfg.chain.private_mempool_wss` into
  the watcher source list.
- `bsc.toml` carries commented `${BSC_MEMPOOL_WSS}`/`${BSC_MEMPOOL_AUTH}`
  examples.

## Verification

[verified — live BSC mainnet, this session]

- `POOL_MANAGER()` on the deployed arb contract `0x279b...db1` returns
  `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df` — the official UniV4 BSC
  PoolManager (PCS Infinity's `0xa0Ff...` CLPoolManager is a different
  singleton with Vault-split settlement; documented incompatible).
- `getSlot0`/`getLiquidity` **revert** on UniV4's PoolManager — the PCS
  signatures do not exist there. Discovered by the probe, not assumed.
  The read path was rewritten to `extsload(bytes32[])` raw-slot reads:
  pool slot = `keccak256(poolId ++ 6)` (v4-core `Pool.POOLS_SLOT = 6`),
  slot0 packing `sqrtPriceX96|tick(i24)|protocolFee(u24)|lpFee(u24)` at
  +0, liquidity at +3. Verified against a live Initialize'd pool:
  sqrt=4.59e30, tick=-56962 (sign-extension correct), liquidity=1.16e19.
- Real poolIds confirmed by computing `keccak256(abi.encode(PoolKey))`
  and checking nonzero liquidity for USDT/USDC at fee={1,100,500,3000}
  pips: 0x8321c1f5...a08a (L=5.29e29), 0x89676efc...a727 (2.64e27),
  0x6bf623ac...075a (1.97e27), 0x50bb1635...fd91 (1.99e22). All four are
  active entries in `bsc.toml`.
- `validate-pools config/bsc.toml`: `State loaded pools=111`, 440/440
  checks pass; the four UNIV4 rows quote fee-consistent amounts
  (999,891/1,000,000 out on the 1-pip pool → ~0.9999 ratio).
- `cargo build --workspace` clean; all crate tests pass.

[assumption] `PoolState::V3` storage for V4 pools assumes identical
concentrated-liquidity math — true for UniV4 vs UniV3 at slot0/liquidity
granularity (tick-level detail is not read, same as every V3 pool here).

[unknown] V4 execution correctness beyond compile-time calldata shape —
the exec-probe `eth_call` will validate `executeV4Arbitrage` on the next
live run; no V4 arb candidate has settled yet.

## Premium RPC — procurement note (Commander action)

Measured earlier (`2026-10-04-rpc-latency-transports.md`): ~59ms p50
best public endpoint from this vantage; vantage dominates endpoint
choice. To take resting-state arb live:

1. **Co-located BSC archive node** (the industry-standard answer):
   a dedicated node in the same region/AZ as the fleet VM — sub-5ms
   reads. Vendors: NodeReal dedicated tier, Chainstack dedicated, or a
   self-hosted erigon-bsc on the fleet's own host.
2. **Drop-in interim**: move a premium endpoint (NodeReal/QuickNode/Ankr
   paid tier) to the front of `rpc_https_pool` — EWMA pick already
   prefers the fastest responder, no code change.
3. **Private orderflow feed**: set `BSC_MEMPOOL_WSS`/`BSC_MEMPOOL_AUTH`
   for the chosen provider (NodeReal mev-namespace, bloXroute BDN,
   48 Club partner feed) — the watcher consumes them as-is.

None of these require another code change; all are env/config-only.
