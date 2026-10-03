//! Gasless contract-call sender for allbrightA (allbrightA).
//!
//! Sends an arbitrary `to`/`data` call through the ERC-4337 gasless venue:
//! the call executes FROM the counterfactual smart account, gas sponsored by
//! Pimlico. Used to deploy a new executor via the Safe singleton CREATE2
//! factory with OWNER = smart account (the deployed executor's OWNER is an
//! immutable deployer EOA and can never authorize the account otherwise).
//!
//! Usage:
//!   deploy4337 config/bsc.toml --target 0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7 --calldata-hex 0x...
//!   deploy4337 config/bsc.toml --target 0x914d... --calldata-file /tmp/deploy.calldata
//!
//! Broadcasts a real UserOperation — only run with Commander approval.

use std::sync::Arc;

use alloy::signers::local::PrivateKeySigner;
use alloy_primitives::{Address, Bytes};
use anyhow::Result;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use arb_rpc::Endpoint;
use arb_submit::pimlico::{PimlicoConfig, PimlicoSubmitter};
use arb_submit::{Bundle, Submitter, UserOpCall};

#[path = "../config.rs"]
mod config;

fn arg(flag: &str) -> Option<String> {
    let mut it = std::env::args();
    while let Some(a) = it.next() {
        if a == flag {
            return it.next();
        }
    }
    None
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .init();

    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config/bsc.toml".to_string());
    let cfg = config::load_config(&config_path)?;

    let target: Address = arg("--target")
        .ok_or_else(|| anyhow::anyhow!("missing --target <address>"))?
        .parse()?;
    let data_hex = match arg("--calldata-file") {
        Some(f) => std::fs::read_to_string(&f)?.trim().to_string(),
        None => arg("--calldata-hex").ok_or_else(|| anyhow::anyhow!("missing --calldata-hex 0x.. or --calldata-file <path>"))?,
    };
    let data = Bytes::from(
        hex::decode(data_hex.trim().trim_start_matches("0x")).map_err(|e| anyhow::anyhow!("bad calldata hex: {e}"))?,
    );

    let url = cfg
        .submission
        .pimlico_bundler_url
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("pimlico_bundler_url is empty"))?;
    let private_key = std::env::var(&cfg.wallet.private_key_env)
        .map_err(|_| anyhow::anyhow!("missing env var {}", cfg.wallet.private_key_env))?;
    let signer: PrivateKeySigner = private_key.parse()?;
    info!(owner = %signer.address(), "wallet loaded");

    let mut read_urls: Vec<&str> = cfg.chain.rpc_https_pool.iter().map(String::as_str).collect();
    if read_urls.is_empty() {
        read_urls.push(cfg.chain.rpc_https.as_str());
    }
    let endpoint = Arc::new(
        Endpoint::new_pooled(&read_urls, &cfg.chain.rpc_wss, None, cfg.chain.chain_id).await?,
    );

    let pim_cfg = PimlicoConfig::from_parts(
        url,
        cfg.submission.entry_point.as_deref(),
        cfg.submission.account_factory.as_deref(),
        cfg.submission.smart_account_salt.unwrap_or(0),
        cfg.submission.sponsor_policy_id_env.as_deref(),
    )?;

    let venue = PimlicoSubmitter::new(pim_cfg, endpoint, signer, cfg.chain.chain_id);
    info!(target = %target, bytes = data.len(), "submitting UserOp call");

    let bundle = Bundle {
        signed_txs: vec![],
        target_block: 0,
        chain_id: cfg.chain.chain_id,
        backrun_tx: None,
        call: Some(UserOpCall { to: target, data }),
    };

    match venue.submit(&bundle).await {
        Ok(res) if res.success => {
            println!("\nUSEROP HASH: {}", res.bundle_hash.unwrap_or_default());
            info!("dispatched — bundler will execute the call from the smart account");
            Ok(())
        }
        Ok(res) => {
            warn!(error = ?res.error, "bundler rejected the UserOperation");
            anyhow::bail!("bundler rejected: {:?}", res.error)
        }
        Err(e) => {
            warn!(error = %e, "UserOp build/sponsor failed");
            Err(e)
        }
    }
}
