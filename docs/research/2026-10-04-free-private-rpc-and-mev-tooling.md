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

## Remaining gaps vs the recommendation's intent

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
