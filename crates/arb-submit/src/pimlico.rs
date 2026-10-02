//! Pimlico bundler + paymaster client — the gasless ERC-4337 venue.
//!
//! Spec (docs/AGENTS_SPEC.md, Account Abstraction Rule): the transaction
//! pipeline must route through the Pimlico UserOperation assembler module;
//! the engine never needs native ETH/BNB to land a bundle. Gas is covered by
//! the configured sponsorship policy (`sponsor_policy_id`), falling back to a
//! self-funded smart account when no policy is set.
//!
//! Bundler endpoint shape: https://api.pimlico.io/v2/{chain}/rpc?apikey=KEY
//! Chain slugs: "base" (8453), "binance" (56). Verified against Pimlico docs.

use std::str::FromStr;
use std::sync::Arc;

use alloy_primitives::{Address, Bytes, U256};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::json;
use tracing::{debug, info, warn};

use arb_rpc::Endpoint;

use crate::userop::{PackedUserOp, UserOpAssembler, UserOpGas, ENTRY_POINT_V06, SIMPLE_ACCOUNT_FACTORY};
use crate::{Bundle, SubmitResult, SubmitTier, Submitter};

#[derive(Debug, Clone)]
pub struct PimlicoConfig {
    pub bundler_url: String,
    pub entry_point: Address,
    pub account_factory: Address,
    pub salt: U256,
    /// Pimlico sponsorship policy id (sp_...). None = self-funded smart account.
    pub sponsor_policy_id: Option<String>,
}

impl PimlicoConfig {
    pub fn from_parts(
        bundler_url: &str,
        entry_point: Option<&str>,
        account_factory: Option<&str>,
        salt: u64,
        sponsor_policy_id_env: Option<&str>,
    ) -> Result<Self> {
        let sponsor_policy_id = sponsor_policy_id_env
            .and_then(|env| std::env::var(env).ok())
            .filter(|v| !v.is_empty());
        Ok(Self {
            bundler_url: bundler_url.to_string(),
            entry_point: Address::from_str(entry_point.unwrap_or(ENTRY_POINT_V06))
                .context("invalid entry_point address")?,
            account_factory: Address::from_str(account_factory.unwrap_or(SIMPLE_ACCOUNT_FACTORY))
                .context("invalid account_factory address")?,
            salt: U256::from(salt),
            sponsor_policy_id,
        })
    }
}

/// Raw JSON-RPC client for the Pimlico bundler/paymaster API.
#[derive(Clone)]
pub struct PimlicoClient {
    url: String,
    http: reqwest::Client,
}

impl PimlicoClient {
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
            http: reqwest::Client::new(),
        }
    }

    async fn rpc(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let resp = self.http.post(&self.url).json(&payload).send().await?;
        let body: serde_json::Value = resp.json().await?;
        if let Some(err) = body.get("error") {
            anyhow::bail!("{method} rejected: {err}");
        }
        Ok(body.get("result").cloned().unwrap_or(serde_json::Value::Null))
    }

    fn parse_u256(v: &serde_json::Value) -> Result<U256> {
        let s = v.as_str().context("expected hex string")?;
        U256::from_str(s).map_err(|e| anyhow::anyhow!("bad U256 '{s}': {e}"))
    }

    /// `pimlico_getUserOperationGasPrice` → the "fast" tier fees.
    pub async fn gas_price(&self) -> Result<UserOpGas> {
        let res = self.rpc("pimlico_getUserOperationGasPrice", json!([])).await?;
        let fast = res.get("fast").cloned().unwrap_or(res);
        Ok(UserOpGas {
            call_gas_limit: U256::from(1_000_000u64),
            verification_gas_limit: U256::from(150_000u64),
            pre_verification_gas: U256::from(60_000u64),
            max_fee_per_gas: Self::parse_u256(&fast["maxFeePerGas"])?,
            max_priority_fee_per_gas: Self::parse_u256(&fast["maxPriorityFeePerGas"])?,
        })
    }

    /// `pm_sponsorUserOperation` (v0.6): returns paymasterAndData + gas fields.
    pub async fn sponsor(
        &self,
        op_json: &serde_json::Value,
        entry_point: Address,
        policy_id: &str,
    ) -> Result<(Bytes, UserOpGas)> {
        let res = self
            .rpc(
                "pm_sponsorUserOperation",
                json!([op_json, format!("{:#x}", entry_point), { "sponsorshipPolicyId": policy_id }]),
            )
            .await?;
        let pmd_hex = res["paymasterAndData"].as_str().unwrap_or("0x").to_string();
        let paymaster_and_data = Bytes::from_str(&pmd_hex).context("bad paymasterAndData")?;
        let gas = UserOpGas {
            call_gas_limit: Self::parse_u256(&res["callGasLimit"])?,
            verification_gas_limit: Self::parse_u256(&res["verificationGasLimit"])?,
            pre_verification_gas: Self::parse_u256(&res["preVerificationGas"])?,
            max_fee_per_gas: Self::parse_u256(&res["maxFeePerGas"])?,
            max_priority_fee_per_gas: Self::parse_u256(&res["maxPriorityFeePerGas"])?,
        };
        Ok((paymaster_and_data, gas))
    }

    /// `eth_sendUserOperation` → userOpHash.
    pub async fn send_user_operation(
        &self,
        op_json: &serde_json::Value,
        entry_point: Address,
    ) -> Result<String> {
        let res = self
            .rpc(
                "eth_sendUserOperation",
                json!([op_json, format!("{:#x}", entry_point)]),
            )
            .await?;
        res.as_str()
            .map(String::from)
            .context("eth_sendUserOperation returned no userOpHash")
    }
}

/// `Submitter` implementation: wraps each candidate call into a sponsored
/// UserOperation and hands it to the Pimlico bundler.
#[derive(Clone)]
pub struct PimlicoSubmitter {
    client: PimlicoClient,
    endpoint: Arc<Endpoint>,
    assembler: UserOpAssembler,
    cfg: PimlicoConfig,
}

impl PimlicoSubmitter {
    pub fn new(
        cfg: PimlicoConfig,
        endpoint: Arc<Endpoint>,
        signer: alloy::signers::local::PrivateKeySigner,
        chain_id: u64,
    ) -> Self {
        Self {
            client: PimlicoClient::new(&cfg.bundler_url),
            assembler: UserOpAssembler {
                owner: signer.address(),
                salt: cfg.salt,
                entry_point: cfg.entry_point,
                account_factory: cfg.account_factory,
                signer,
                chain_id,
            },
            endpoint,
            cfg,
        }
    }

    /// Assemble a full UserOperation for `bundle.call`, applying sponsorship
    /// when a policy is configured. `dry_run` stops before signing+send.
    async fn build_userop(&self, bundle: &Bundle) -> Result<PackedUserOp> {
        let call = bundle
            .call
            .as_ref()
            .context("bundle carries no call data for 4337 submission")?;

        let mut gas = self.client.gas_price().await?;

        // First pass: unsigned, unsponsored — needed for pm_sponsorUserOperation.
        let unsigned = self
            .assembler
            .assemble_unsigned(&self.endpoint, call.to, call.data.clone(), gas, Bytes::new())
            .await?;

        let mut paymaster_and_data = Bytes::new();
        if let Some(policy) = &self.cfg.sponsor_policy_id {
            match self
                .client
                .sponsor(&unsigned.to_json(), self.cfg.entry_point, policy)
                .await
            {
                Ok((pmd, sponsored_gas)) => {
                    gas = sponsored_gas;
                    paymaster_and_data = pmd;
                }
                Err(e) => {
                    warn!(error = %e, "pm_sponsorUserOperation failed — falling back to self-funded op");
                }
            }
        }

        let mut op = unsigned;
        if !paymaster_and_data.is_empty() {
            // Rebuild with sponsor-provided gas + paymaster fields.
            op = self
                .assembler
                .assemble_unsigned(
                    &self.endpoint,
                    call.to,
                    call.data.clone(),
                    gas,
                    paymaster_and_data,
                )
                .await?;
        }

        self.assembler.sign(&op).await
    }

    /// Assemble + sign and return the wire JSON — no send. Used for dry runs.
    pub async fn preview(&self, bundle: &Bundle) -> Result<serde_json::Value> {
        let op = self.build_userop(bundle).await?;
        Ok(json!({
            "entryPoint": format!("{:#x}", self.cfg.entry_point),
            "chainId": self.assembler.chain_id,
            "sponsored": self.cfg.sponsor_policy_id.is_some()
                && !op.paymaster_and_data.is_empty(),
            "userOperation": op.to_json(),
        }))
    }
}

#[async_trait]
impl Submitter for PimlicoSubmitter {
    fn venue_name(&self) -> &'static str {
        "Pimlico_ERC4337"
    }

    fn tier(&self) -> SubmitTier {
        SubmitTier::AlwaysOn
    }

    async fn submit(&self, bundle: &Bundle) -> Result<SubmitResult> {
        let op = self.build_userop(bundle).await?;
        let op_json = op.to_json();
        match self
            .client
            .send_user_operation(&op_json, self.cfg.entry_point)
            .await
        {
            Ok(hash) => {
                info!(userop_hash = %hash, "UserOperation dispatched to Pimlico bundler");
                Ok(SubmitResult {
                    venue: self.venue_name(),
                    success: true,
                    bundle_hash: Some(hash),
                    error: None,
                })
            }
            Err(e) => {
                debug!(error = %e, "Bundler rejected UserOperation");
                Ok(SubmitResult {
                    venue: self.venue_name(),
                    success: false,
                    bundle_hash: None,
                    error: Some(e.to_string()),
                })
            }
        }
    }
}
