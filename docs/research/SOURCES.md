# Authoritative Source Registry

Status labels per `docs/SKILLS_SPEC.md` governance:
`[verified]` = reviewed and applied in this repository;
`[recommended]` = queued for review. Never mark a source verified without
having read it.

## Standards

| source | url | status | reviewed |
|---|---|---|---|
| Ethereum Yellow Paper | https://ethereum.github.io/yellowpaper/paper.pdf | [recommended] | — |
| Ethereum JSON-RPC | https://ethereum.org/en/developers/docs/apis/json-rpc/ | [verified] | 2026-10-03 |
| EIP-1559 | https://eips.ethereum.org/EIPS/eip-1559 | [recommended] | — |
| EIP-4337 | https://eips.ethereum.org/EIPS/eip-4337 | [verified — gasless deploy + sponsored UserOps shipped] | 2026-10-03 |
| Solidity security considerations | https://docs.soliditylang.org/en/latest/security-considerations.html | [recommended] | — |

## Official protocol & engineering docs

| source | url | status | reviewed |
|---|---|---|---|
| Uniswap V2 protocol overview | https://docs.uniswap.org/contracts/v2/concepts/protocol-overview/how-uniswap-works | [verified — V2 quote kernel] | 2026-10-03 |
| Uniswap V3 concentrated liquidity | https://docs.uniswap.org/concepts/protocol/concentrated-liquidity | [verified — tick/liquidity kernel] | 2026-10-03 |
| Uniswap V3 pool state interface | https://docs.uniswap.org/contracts/v3/reference/core/interfaces/pool/IUniswapV3PoolState | [verified — slot0/liquidity probes] | 2026-10-03 |
| Balancer flash loans | https://docs-v2.balancer.fi/reference/contracts/flash-loans.html | [recommended] | — |
| DODO flash loans | https://docs.dodoex.io/dodo-academy/smart-contracts/dodo-v1/flash-loan | [recommended] | — |
| Alloy | https://alloy.rs/ | [verified — workspace dep] | 2026-10-03 |
| Tokio | https://tokio.rs/tokio/tutorial | [verified — async writer + bounded channels] | 2026-10-03 |
| Rust Performance Book | https://nnethercote.github.io/perf-book/ | [recommended] | — |
| Prometheus metric types | https://prometheus.io/docs/concepts/metric_types/ | [verified — counters/gauges/histograms shipped] | 2026-10-03 |
| Prometheus naming practices | https://prometheus.io/docs/practices/naming/ | [verified — arb_* naming] | 2026-10-03 |
| PM2 | https://pm2.keymetrics.io/docs/usage/quick-start/ | [recommended] | — |

## MEV and primary research

| source | url | status | reviewed |
|---|---|---|---|
| Flashbots documentation | https://docs.flashbots.net/ | [recommended] | — |
| Flashbots research | https://writings.flashbots.net/ | [recommended] | — |
| Flash Boys 2.0 | https://arxiv.org/abs/1904.05234 | [recommended] | — |
