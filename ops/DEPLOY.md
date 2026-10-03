# Executor redeploy runbook

Activates the Balancer (0% fee) + Aave V3 flash routes already in contract
source. Deployed bytecode is immutable — a redeploy is the only activation
path. Everything stays dry-run until the Commander flips the live gates.

## Prereqs

```bash
export PATH="$HOME/.foundry/bin:$PATH"
export DEPLOYER_KEY=<funded-deployer-private-key>   # pays deploy gas only
export BSC_RPC_URL=https://bsc-rpc.publicnode.com
export BASE_RPC_URL=https://base-rpc.publicnode.com
```

## BSC

```bash
# Confirm the PancakeSwap Infinity (V4-style) PoolManager address on BSC
# against the protocol docs, then:
export POOL_MANAGER=<bsc-pool-manager>
cd contracts
forge script script/DeployBsc.s.sol \
    --rpc-url "$BSC_RPC_URL" --broadcast --verify -vvv
```

## Base

```bash
cd contracts
forge script script/DeployBase.s.sol \
    --rpc-url "$BASE_RPC_URL" --broadcast --verify -vvv
```

## Wire in

1. `.env`: `BSC_ARB_CONTRACT=<new BscFlashArb addr>`,
   `BASE_ARB_CONTRACT=<new BaseFlashArb addr>`,
   `BSC_STATE_READER=<reader>`, `BASE_STATE_READER=<reader>`
   (deployless Multicall3 mode works without a reader — V2/V3 only).
2. Authorize the executor owner chain (contract `OWNER` = deployer by
   default; `setExecutor`/`transferOwnership` per contract admin fns).
3. `pm2 restart all` — runners pick up the new `arb_contract` on boot.

## Pimlico sponsorship

Already wired: `sponsor_policy_id_env = "ALLBRIGHTA_SPONSOR_POLICY_ID"` in
both TOMLs. Create an `sp_…` policy in the Pimlico dashboard (allowlist
chains 56 + 8453, set a spend cap), set it in `.env`, restart.

**Sponsorship is mandatory in gasless mode — there is no funded-wallet
fallback.** If the paymaster policy is unavailable or rejects the
UserOperation, the operation is rejected and classified by reason
(`arb_sponsorship_rejects_total{reason}`): `no_policy`, `policy_invalid`,
`policy_rejected`, `quota_exhausted`, `paymaster_balance`, `transport`.
User wallet funding is never required; the operator's sponsorship budget
funds gas.

## Premium RPC keys (the 200+ node path)

```bash
python3 ops/gen_rpc_pool.py --write \
    --alchemy-key $ALCHEMY_KEY \
    --nodereal-key $NODEREAL_KEY \
    --infura-key $INFURA_KEY \
    --ankr-key $ANKR_KEY \
    --quicknode-url "https://<host>.base-mainnet.quiknode.pro/<key>/" \
    --quicknode-url "https://<host>.bsc.quiknode.pro/<key>/"
```

Every candidate — public or keyed — still passes the `eth_chainId`
handshake before entering the pool. Supply a premium WSS URL the same way
via `--url` then move it into `rpc_wss_pool` manually, or add it directly
to `rpc_wss_pool` in `config/*.toml` (the watcher verifies emitters live).

## Go-live checklist (all Commander actions)

- [ ] Fork-test the deployed contract: `BSC_RPC_URL=… BASE_RPC_URL=… forge test --fork-url …`
- [ ] `SIMULATION_VERIFIED=true` via `POST /api/simulation/verify` (governance gate)
- [ ] `.env`: `LIVE_COMMANDER_APPROVED=true`
- [ ] `config/*.toml`: `dry_run = false`
- [ ] `pm2 restart all` and watch the first bundles in PM2 logs
