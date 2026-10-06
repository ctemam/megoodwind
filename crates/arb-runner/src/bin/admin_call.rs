//! One-off sponsored admin call on the arb executor via ERC-4337.
//!
//! Submits a real UserOperation from the Pimlico smart account (the
//! executor's owner) calling an onlyOwner setter — e.g. registering a new
//! flash-borrow asset:
//!
//!   cargo run --release --bin admin_call -- config/bsc.toml setTokenSupport 0x<token> true
//!
//! Sponsored gas, same venue path the live lanes use.

use std::sync::Arc;

use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy::sol_types::SolCall;
use alloy_primitives::{Address, Bytes};
use anyhow::Result;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use arb_rpc::Endpoint;
use arb_submit::pimlico::{PimlicoConfig, PimlicoSubmitter};
use arb_submit::{Bundle, Submitter, UserOpCall};

sol! {
    function setTokenSupport(address token, bool supported) external;
}

#[path = "../config.rs"]
mod config;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .init();

    let mut args = std::env::args().skip(1);
    let config_path = args.next().unwrap_or_else(|| "config/bsc.toml".to_string());
    let method = args.next().unwrap_or_default();
    let token: Address = args
        .next()
        .unwrap_or_default()
        .parse()
        .map_err(|_| anyhow::anyhow!("usage: admin_call <cfg> setTokenSupport <token> <true|false>"))?;
    let supported = args.next().unwrap_or_default() == "true";
    anyhow::ensure!(method == "setTokenSupport", "unsupported method {method}");

    let cfg = config::load_config(&config_path)?;
    anyhow::ensure!(cfg.submission.pimlico_enabled, "pimlico_enabled is false");
    let url = cfg
        .submission
        .pimlico_bundler_url
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("pimlico_bundler_url is empty"))?;

    let private_key = std::env::var(&cfg.wallet.private_key_env)
        .map_err(|_| anyhow::anyhow!("missing env var {}", cfg.wallet.private_key_env))?;
    let signer: PrivateKeySigner = private_key.parse()?;

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
    info!(sponsored = pim_cfg.sponsor_policy_id.is_some(), "pimlico config parsed");
    let venue = PimlicoSubmitter::new(pim_cfg, endpoint, signer, cfg.chain.chain_id);

    let arb_contract: Address = cfg.chain.arb_contract.parse()?;
    let data = setTokenSupportCall {
        token,
        supported,
    }
    .abi_encode();
    info!(token = %token, supported, "submitting setTokenSupport UserOp");
    let bundle = Bundle {
        signed_txs: vec![],
        victim_tx: None,
        target_block: 0,
        chain_id: cfg.chain.chain_id,
        backrun_tx: None,
        call: Some(UserOpCall {
            to: arb_contract,
            data: Bytes::from(data),
        }),
    };

    match venue.submit(&bundle).await {
        Ok(res) => {
            info!(success = res.success, "setTokenSupport UserOp submitted");
            if !res.success {
                warn!(error = ?res.error, "venue rejected the op");
            }
            Ok(())
        }
        Err(e) => {
            warn!(error = %e, "submit failed");
            Err(e)
        }
    }
}
