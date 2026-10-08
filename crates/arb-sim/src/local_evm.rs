//! Local EVM exec probe via Foundry's fork backend — the industry
//! stack for chain-truth simulation (foundry-fork-db SharedBackend +
//! revm), replacing per-candidate `eth_call` network probes. The
//! backend dedups/caches state fetches against the RPC; repeated probes
//! in a cycle hit the cache instead of paying a round trip each.
//!
//! `pin_block = None` fetches at `latest` per request — identical
//! semantics to `provider().call(req)` at head, minus the per-call
//! RPC for state the cache already holds.

use alloy::network::Ethereum;
use alloy::primitives::{Address, Bytes, TxKind, U256};
use alloy::providers::Provider;
use alloy::rpc::types::Block;
use alloy_evm::{eth::EthEvmContext, EthEvm, Evm};
use foundry_fork_db::{cache::BlockchainDbMeta, BlockchainDb, SharedBackend};
use revm::context::{BlockEnv, Evm as RevmEvm, TxEnv};
use revm::context_interface::block::BlobExcessGasAndPrice;
use revm::database::WrapDatabaseRef;
use revm::handler::{instructions::EthInstructions, EthPrecompiles};
use revm::inspector::NoOpInspector;
use revm::primitives::hardfork::SpecId;
use revm::context_interface::result::ExecutionResult;

/// Outcome of a local exec probe — mirrors the eth_call classification:
/// Ok = would land, Reverted = chain truth says no, Transport = the
/// backend couldn't answer (fall back to the RPC probe, don't penalize).
#[derive(Debug)]
pub enum ProbeOutcome {
    Success,
    /// Revert output as `0x`-hex + decoded Error(string) when present —
    /// feeds `classify_exec_probe_revert` unchanged.
    Reverted(String),
    Transport(String),
}

/// Cloneable handle: the SharedBackend is an Arc'd channel to the
/// fork-backend thread; clones share the state cache.
#[derive(Clone)]
pub struct LocalFork {
    backend: SharedBackend<Ethereum>,
    block_env: BlockEnv,
}

impl LocalFork {
    /// Spawn the fork backend on its own thread/runtime (never call the
    /// sync `DatabaseRef` methods from a tokio worker — drive them from
    /// `tokio::task::spawn_blocking`).
    pub fn spawn<P: Provider<Ethereum> + 'static>(provider: P, block: &Block) -> Self {
        let meta = BlockchainDbMeta::default();
        let db = BlockchainDb::new(meta, None);
        let backend = SharedBackend::spawn_backend_thread(provider, db, None);
        let block_env = BlockEnv {
            number: U256::from(block.header.number),
            beneficiary: block.header.beneficiary,
            timestamp: U256::from(block.header.timestamp),
            gas_limit: block.header.gas_limit,
            basefee: block.header.base_fee_per_gas.unwrap_or(0),
            prevrandao: Some(block.header.mix_hash),
            difficulty: block.header.difficulty,
            blob_excess_gas_and_price: Some(BlobExcessGasAndPrice::new_with_spec(
                block.header.excess_blob_gas.unwrap_or_default(),
                SpecId::PRAGUE,
            )),
        };
        Self { backend, block_env }
    }

    /// Simulate `from -> to(data)` on latest chain state. SYNCHRONOUS —
    /// run inside spawn_blocking; the backend's fetch thread does the
    /// RPC work behind a channel.
    pub fn simulate(&self, from: Address, to: Address, data: Bytes) -> ProbeOutcome {
        let context = EthEvmContext::new(
            WrapDatabaseRef(self.backend.clone()),
            SpecId::PRAGUE,
        )
        .with_block(self.block_env.clone());
        let evm = RevmEvm::new(
            context,
            EthInstructions::new_mainnet_with_spec(SpecId::PRAGUE),
            EthPrecompiles::new(SpecId::PRAGUE),
        )
        .with_inspector(NoOpInspector);
        let mut evm = EthEvm::new(evm, false);
        let tx = TxEnv {
            caller: from,
            kind: TxKind::Call(to),
            data,
            value: U256::ZERO,
            gas_limit: 30_000_000,
            gas_price: 0u128,
            ..Default::default()
        };
        match evm.transact(tx) {
            Ok(res) => match res.result {
                ExecutionResult::Success { output, .. } => {
                    let _ = output;
                    ProbeOutcome::Success
                }
                ExecutionResult::Revert { output, .. } => {
                    ProbeOutcome::Reverted(revert_detail(&output))
                }
                ExecutionResult::Halt { reason, .. } => {
                    ProbeOutcome::Transport(format!("evm halt: {reason:?}"))
                }
            },
            Err(e) => ProbeOutcome::Transport(format!("{e:?}")),
        }
    }
}

/// Hex-encode revert bytes (so selector checks like `0x08c379a0` match)
/// and append the decoded Error(string) when present for logs.
fn revert_detail(output: &Bytes) -> String {
    let mut s = format!("0x{}", alloy::hex::encode(output));
    if output.len() >= 4 && output[..4] == [0x08, 0xc3, 0x79, 0xa0] {
        // Error(string): [4B sel][32B offset][32B len][bytes]
        if output.len() >= 68 {
            let len = U256::try_from_be_slice(&output[36..68])
                .map(|v| v.to::<usize>())
                .unwrap_or(0);
            let end = 68 + len;
            if len > 0 && output.len() >= end {
                if let Ok(reason) = std::str::from_utf8(&output[68..end]) {
                    s.push_str(&format!(" Error(string): {reason}"));
                }
            }
        }
    }
    s
}
