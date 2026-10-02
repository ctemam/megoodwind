//! Preflight check for the ERC-4337 gasless venue (allbrightA).
//!
//! Exercises the full UserOperation pipeline against live infrastructure —
//! counterfactual smart-account address, nonce, gas quote, paymaster
//! sponsorship (when a policy is set) and owner signature — without
//! broadcasting anything. Safe to run any time; read-only + bundler quotes.
//!
//! Usage: cargo run --release --bin verify4337 -- config/bsc.toml

use std::sync::Arc;

use alloy::signers::local::PrivateKeySigner;
use alloy_primitives::{Address, Bytes};
use anyhow::Result;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use arb_rpc::Endpoint;
use arb_submit::pimlico::{PimlicoConfig, PimlicoSubmitter};
use arb_submit::{Bundle, UserOpCall};

#[path = "../config.rs"]
mod config;

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

    if !cfg.submission.pimlico_enabled {
        anyhow::bail!("pimlico_enabled is false in {config_path}");
    }
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
    info!(sponsored = pim_cfg.sponsor_policy_id.is_some(), "pimlico config parsed");

    let venue = PimlicoSubmitter::new(pim_cfg, endpoint, signer, cfg.chain.chain_id);

    // Stand-in call: a no-op transfer on the configured arb contract.
    let arb_contract: Address = cfg.chain.arb_contract.parse()?;
    let bundle = Bundle {
        signed_txs: vec![],
        target_block: 0,
        chain_id: cfg.chain.chain_id,
        backrun_tx: None,
        call: Some(UserOpCall {
            to: arb_contract,
            data: Bytes::from(vec![0xde, 0xad, 0xbe, 0xef]),
        }),
    };

    match venue.preview(&bundle).await {
        Ok(op) => {
            println!("\n===== ERC-4337 PREFLIGHT ({}) =====", cfg.chain.name);
            println!("{}", serde_json::to_string_pretty(&op)?);
            println!("==================================\n");
            info!("UserOperation assembled, sponsored-status logged, and signed — nothing broadcast");
            Ok(())
        }
        Err(e) => {
            warn!(error = %e, "4337 preflight failed");
            Err(e)
        }
    }
}
