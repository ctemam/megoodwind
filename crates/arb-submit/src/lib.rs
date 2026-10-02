pub mod puissant;
pub mod blockrazor;
pub mod jetbldr;
pub mod nodereal;
pub mod blink;
pub mod warp;
pub mod direct;
pub mod builder;
pub mod presign;
pub mod userop;
pub mod pimlico;
pub mod router;

use alloy_primitives::{Address, B256, Bytes};
use anyhow::Result;
use async_trait::async_trait;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitTier {
    /// Free venues — always fire on every profitable path
    AlwaysOn,
    /// Paid venues ($0.15/call) — only fire if expected profit clears threshold
    HighEvOnly,
}

/// The raw `to`/`calldata` of the arbitrage call — retained alongside the
/// signed envelopes so ERC-4337 venues can wrap it in a UserOperation.
#[derive(Debug, Clone)]
pub struct UserOpCall {
    pub to: Address,
    pub data: Bytes,
}

#[derive(Debug, Clone)]
pub struct Bundle {
    pub signed_txs: Vec<Vec<u8>>,
    pub target_block: u64,
    pub chain_id: u64,
    pub backrun_tx: Option<B256>,
    pub call: Option<UserOpCall>,
}

#[derive(Debug, Clone)]
pub struct SubmitResult {
    pub venue: &'static str,
    pub success: bool,
    pub bundle_hash: Option<String>,
    pub error: Option<String>,
}

#[async_trait]
pub trait Submitter: Send + Sync {
    fn venue_name(&self) -> &'static str;
    fn tier(&self) -> SubmitTier;
    async fn submit(&self, bundle: &Bundle) -> Result<SubmitResult>;
}
