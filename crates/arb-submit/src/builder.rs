use arb_core::types::Protocol;
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use alloy_primitives::{Address, Bytes, U256};
use alloy_sol_types::SolCall;
use anyhow::Result;

use arb_paths::template::V4Key;
use arb_paths::PathTemplate;
use arb_rpc::Endpoint;

use crate::{Bundle, UserOpCall};

alloy::sol! {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapInstruction {
        uint8 protocol;
        address pool;
        PoolKey poolKey;
        address tokenIn;
        address tokenOut;
        uint256 minOut;
    }

    function executeV4Arbitrage(
        address asset,
        uint256 amount,
        SwapInstruction[] calldata swapInstructions,
        uint256 deadline
    ) external;
}

/// `v4_keys` maps each V4 hop's pseudo pool address to its PoolKey —
/// required for every UniswapV4 hop in the path (hop.pool is only a
/// bookkeeping key).
pub async fn build_bundle(
    path: &PathTemplate,
    endpoint: &Endpoint,
    arb_contract: Address,
    signer: &PrivateKeySigner,
    target_block: u64,
    chain_id: u64,
    v4_keys: &std::collections::HashMap<Address, V4Key>,
) -> Result<Bundle> {
    let mut swap_instructions = Vec::with_capacity(path.hops.len());
    for hop in &path.hops {
        let pool_key = if hop.protocol == Protocol::UniswapV4 {
            let Some(k) = v4_keys.get(&hop.pool) else {
                anyhow::bail!("V4 hop {:?} has no PoolKey configured", hop.pool);
            };
            PoolKey {
                currency0: k.currency0,
                currency1: k.currency1,
                fee: alloy_primitives::Uint::from(k.fee),
                tickSpacing: alloy_primitives::Signed::<24, 1>::try_from(k.tick_spacing)
                    .unwrap_or_default(),
                hooks: k.hooks,
            }
        } else {
            PoolKey {
                currency0: Address::ZERO,
                currency1: Address::ZERO,
                fee: alloy_primitives::Uint::from(0u32),
                tickSpacing: alloy_primitives::Signed::ZERO,
                hooks: Address::ZERO,
            }
        };
        swap_instructions.push(SwapInstruction {
            protocol: hop.protocol.to_contract_enum(chain_id),
            pool: hop.pool,
            poolKey: pool_key,
            tokenIn: hop.token_in,
            tokenOut: hop.token_out,
            minOut: U256::ZERO,
        });
    }

    let deadline = U256::from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 120,
    );

    let calldata = executeV4ArbitrageCall {
        asset: path.flash_token,
        amount: path.flash_amount,
        swapInstructions: swap_instructions,
        deadline,
    }
    .abi_encode();

    let nonce = endpoint.get_nonce(signer.address()).await?;
    let gas_price = endpoint.gas_price().await?;

    let buf = if chain_id == 8453 {
        let max_priority_fee: u128 = 1_000_000_000;
        let max_fee = gas_price.saturating_mul(2).saturating_add(max_priority_fee);
        let tx = alloy::consensus::TxEip1559 {
            chain_id,
            nonce,
            gas_limit: 500_000,
            max_fee_per_gas: max_fee,
            max_priority_fee_per_gas: max_priority_fee,
            to: arb_contract.into(),
            value: U256::ZERO,
            input: Bytes::from(calldata.clone()).into(),
            access_list: Default::default(),
        };
        let sig = signer
            .sign_hash(&alloy::consensus::SignableTransaction::signature_hash(&tx))
            .await?;
        let envelope = alloy::consensus::TxEnvelope::Eip1559(
            alloy::consensus::Signed::new_unchecked(tx, sig, Default::default()),
        );
        let mut b = Vec::new();
        alloy::eips::eip2718::Encodable2718::encode_2718(&envelope, &mut b);
        b
    } else {
        let tx = alloy::consensus::TxLegacy {
            chain_id: Some(chain_id),
            nonce,
            gas_price,
            gas_limit: 500_000,
            to: arb_contract.into(),
            value: U256::ZERO,
            input: Bytes::from(calldata.clone()).into(),
        };
        let sig = signer
            .sign_hash(&alloy::consensus::SignableTransaction::signature_hash(&tx))
            .await?;
        let envelope = alloy::consensus::TxEnvelope::Legacy(
            alloy::consensus::Signed::new_unchecked(tx, sig, Default::default()),
        );
        let mut b = Vec::new();
        alloy::eips::eip2718::Encodable2718::encode_2718(&envelope, &mut b);
        b
    };

    Ok(Bundle {
        signed_txs: vec![buf],
        victim_tx: None,
        target_block,
        chain_id,
        backrun_tx: None,
        call: Some(UserOpCall {
            to: arb_contract,
            data: Bytes::from(calldata),
        }),
    })
}
