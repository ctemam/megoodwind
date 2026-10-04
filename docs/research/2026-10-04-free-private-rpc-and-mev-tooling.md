# Research: free private RPC endpoints + Rust MEV tooling vs allbright

2026-10-04. Trigger: Commander's list of "free private RPC endpoints" and
recommended crates (alloy, alloy-mev, mev-share-rs, ethers-flashbots) with the
directive to check each and compare against the deployed system. The endpoint
table in the message rendered empty, so the endpoint set below was compiled
from vendor docs and verified live from the session box.

Method: every candidate endpoint was probed with `eth_chainId` /
`eth_blockNumber` and a real `eth_call` (`getPair`) over HTTPS from this VM.

## Verified free private RPC endpoints

| Endpoint | Chain | Free | Reads (`eth_call`) | Private submit | Verified latency (this box) |
|---|---|---|---|---|---|
| `https://rpc.flashbots.net` (+`/fast`) | ETH | yes | partial — `eth_chainId`/`blockNumber` ok, `eth_call` → 403 | yes (Protect, `eth_sendPrivateTransaction`; `/fast` broadcasts to all builders) | ~150ms |
| `https://rpc.mevblocker.io` (+variants) | ETH | yes | yes | yes (variants: `/noreverts` `/fullprivacy` `/maxbackruns` `/nochecks`) | ~180-260ms |
| `https://eth.blockrazor.xyz` | ETH | yes, no auth | yes | yes (`/fullprivacy`, `/maxbackrun`) | 104-118ms |
| `https://eth-protect.rpc.blxrbdn.com` | ETH | yes | yes | yes (bloXroute private relay) | ~187-250ms |
| `https://rpc.48.club` | BSC | yes, no auth | yes | yes — txs go to Puissant builder private mempool | ~104-200ms |
| `https://puissant-builder.48.club` | BSC | yes | **no** (tx API only) | yes (`eth_sendPrivateTransaction`, batch variants) | n/a reads |
| `https://bsc.blockrazor.xyz` | BSC | yes, no auth | yes | yes (`/fullprivacy`, `/maxbackrun?percent=`) | ~113-151ms |
| `https://bsc.rpc.blxrbdn.com` | BSC | yes | yes | yes (bloXroute) | ~270-300ms |
| Polygon Private Mempool | Polygon | free tier | **no** (submission-only by design) | yes, direct to elected block producers | gated — requires access request at info.polygon.technology/private-mempool |
| `api.merkle.io` | ETH/BSC/Polygon | freemium | n/a | yes | not verified (auth required) |

Submission-only endpoints (Puissant builder API, Polygon Private Mempool,
Flashbots Protect for `eth_call`) must NOT go in `rpc_https_pool` — they are
tx channels only.

## Crate recommendations vs repo

| Suggested | Verdict | Why |
|---|---|---|
| `alloy` | already used | workspace is alloy 1.8.3 throughout — correct choice |
| `alloy-mev` | useful for one gap | sends raw-tx bundles via `MevShareProviderExt`/`EthMevProviderExt`. Our gap it fills: **ETH has no bundle venue** (BSC venues exist: Puissant/BlockRazor/JetBldr/NodeReal via `is_bundle_venue`). Does NOT fit the copy lane — copies are 4337 UserOps through Pimlico, not raw-tx bundles. Would fit the backrun lane on ETH if that lane is ever re-enabled |
| `mev-share-rs` / `mev-share-sse` | useful, second-order | SSE stream of ETH MEV-Share orderflow — an additional wallet-signal source for leader discovery (private-orderflow txs never touch the public mempool our watcher sees). BSC/Polygon unaffected. `mev-share-sse` 0.5.1 (2025-05) is the maintained piece; the umbrella `mev-share` crate is stale (0.1.4, 2023) |
| `ethers` / `ethers-flashbots` | correctly absent | ethers-rs is in maintenance mode; alloy-mev supersedes ethers-flashbots for bundles. Do not add |

## What was wired from this research (this session)

- `config/ethereum.toml` `rpc_https_pool` += `eth.blockrazor.xyz` (104ms, fastest ETH endpoint measured), `eth-protect.rpc.blxrbdn.com`. `rpc.mevblocker.io` was already present. Pool 3→5.
- `config/bsc.toml` `rpc_https_pool` += `bsc.blockrazor.xyz`, `rpc.48.club` (both ~106-113ms, free, private-submit capable). Pool 19→21.
- No Polygon addition: the only real free private option (Polygon Private Mempool, launched 2026-04) is submission-only and gated behind an access request — needs a human to complete info.polygon.technology/private-mempool, then it belongs in a submit channel, not the read pool.

## Private vs public — detection quality vs rejection quality (Commander 2026-10-04)

These are two different channels in this bot:

**Detection** = the mempool **WSS feed** (`eth_subscribe newPendingTransactions`).
The read RPCs play no role in detection at all. Current feeds are all public:
`bsc-rpc.publicnode.com`, `eth.drpc.org`, `polygon-bor-rpc.publicnode.com` pools.

**Rejection** = the decisions after a signal: pool-state freshness at sim,
GoPlus check, slippage bound. These DO depend on read RPCs — stale/mispriced
reserves are the main false-reject/false-accept source on free endpoints.

Where the two meet: **leaders who submit through private RPCs never reach the
public mempool** — the public watcher cannot see them at all. The two promoted
BSC wallets were caught on public flow, but every wallet using 48Club/Puissant,
Flashbots Protect, or MEV Blocker fullprivacy is invisible to detection. That
is the real detection-quality gap, and it can only be closed by orderflow
feeds, not read RPCs.

Free private-orderflow options (checked live from this box):

| Feed | Chain | Reaches | Cost/gate | Wireable today? |
|---|---|---|---|---|
| MEV-Share SSE `mev-share.flashbots.net` | ETH | HTTP 200 | free, no auth | yes — SSE JSON stream; needs a client (mev-share-sse crate or ~80 lines of SSE) feeding the discoverer. The repo's `private_mempool_wss`/`auth` hooks expect a WSS pending-tx API — MEV-Share is a different protocol (SSE event stream of tx hints), so it needs its own adapter, not the existing hook |
| Puissant WSS `wss://puissant-builder.48.club` | BSC | WSS 101 upgrade | conditional — 48SoulPoint member benefit (free tier exists, needs sign-up) | partially — upgrade succeeds; whether it serves unauthenticated feeds needs member credentials. If obtainable free, it plugs straight into `private_mempool_wss` |
| bloXroute BDN pending-tx stream | BSC/ETH | n/a | paid | no (free-RPC constraint) |
| Polygon Private Mempool | Polygon | submission-only by design | gated access request | no — it publishes no orderflow feed at all; Polygon private flow is undetectable to anyone by design |

**Rejection quality** (what the read-pool additions just changed): on this box
the new private reads measured ~104-118ms (blockrazor) / ~106-200ms (48club)
vs ~250-300ms+ with high variance on the busy public endpoints. Under the
fleet's sustained multicall load, public endpoints also hit the 429/slowtail
that caused the earlier chunk-timeout churn — fresher state at sim time =
fewer rejections from stale reserves and less wasted UserOp submission.

**Bottom line**: private read RPCs already improved the rejection side. To
improve detection coverage past the public mempool, the only free path today
is the ETH MEV-Share SSE adapter; BSC needs a 48SoulPoint sign-up (free) to
confirm Puissant feed access; Polygon offers nothing free.

1. **Private tx submission for copies**: copy lane lands via Pimlico bundler
   (its tx is public when broadcast). Private-submit RPCs (48Club/BlockRazor/
   Flashbots Protect) would only help if the bundler tx or a raw-tx copy path
   used them — not wired; also not urgent since copies are next-block and
   cannot be front-run meaningfully (they don't displace the leader).
2. **ETH bundle venue** for the (disabled) backrun lane — `alloy-mev` +
   Flashbots relay (`FLASHBOOTS_RELAY`/`FLASHBOOTS_AUTH_KEY` already in .env,
   unused) is the natural fit if backrun is ever re-enabled.
3. **Private orderflow as signal**: MEV-Share SSE (`mev-share-sse`) would let
   discovery see private ETH flow — wallets whose txs never hit the public
   mempool. Optional; the watcher currently sees public flow only.
4. **bloXroute BDN** (paid) — out of scope per free-RPC constraint.

Labels: endpoint URLs/behaviours [verified] live from this box 2026-10-04;
crate maintenance status [verified] via crates.io/docs.rs; Polygon Private
Mempool pricing tier [vendor docs — unverified live]; "private" claims are
vendor claims (tx excluded from public mempool until mined).
