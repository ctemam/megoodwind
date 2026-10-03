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

/// Canonical 65-byte dummy signature (permissionless.js) — satisfies
/// ECDSA signature-length checks when Pimlico simulates the op during
/// pm_sponsorUserOperation, before the real signature exists.
fn dummy_signature() -> Bytes {
    Bytes::from(
        hex::decode(
            "fffffffffffffffffffffffffffffff0000000000000000000000000000000007\
             aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c",
        )
        .expect("dummy signature is valid hex"),
    )
}

#[derive(Debug, Clone)]
pub struct PimlicoConfig {
    pub bundler_url: String,
    pub entry_point: Address,
    pub account_factory: Address,
    pub salt: U256,
    /// Optional Pimlico sponsorship policy id (sp_...) — scopes limits.
    /// Without one, ops are still sponsored within the account's Pimlico
    /// balance. Ops are never self-funded either way.
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

    /// Same as `parse_u256` but `null`/absent fields come back `None`
    /// instead of failing — Pimlico omits gas fields it doesn't adjust.
    fn parse_u256_opt(v: &serde_json::Value) -> Result<Option<U256>> {
        match v {
            serde_json::Value::Null => Ok(None),
            _ => Self::parse_u256(v).map(Some),
        }
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
    /// Errors come back classified as `SponsorReject` so callers can label
    /// metrics and distinguish transient transport faults from policy rejects.
    pub async fn sponsor(
        &self,
        op_json: &serde_json::Value,
        entry_point: Address,
        policy_id: Option<&str>,
    ) -> std::result::Result<(Bytes, UserOpGas), SponsorReject> {
        // Policy id is optional — without it the paymaster sponsors within
        // the account's Pimlico balance.
        let params = match policy_id {
            Some(id) => json!([op_json, format!("{:#x}", entry_point), { "sponsorshipPolicyId": id }]),
            None => json!([op_json, format!("{:#x}", entry_point)]),
        };
        let payload = json!({
            "jsonrpc": "2.0", "id": 1,
            "method": "pm_sponsorUserOperation",
            "params": params,
        });
        let resp = self
            .http
            .post(&self.url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| SponsorReject::transport(format!("paymaster unreachable: {e}")))?;
        if !resp.status().is_success() {
            return Err(SponsorReject::transport(format!("paymaster HTTP {}", resp.status())));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| SponsorReject::transport(format!("paymaster bad JSON: {e}")))?;
        if let Some(err) = body.get("error") {
            return Err(SponsorReject::classify(err.to_string()));
        }
        debug!(response = %body, "pm_sponsorUserOperation result");
        let res = body.get("result").cloned().unwrap_or(serde_json::Value::Null);
        let pmd_hex = res["paymasterAndData"].as_str().unwrap_or("0x").to_string();
        let parse = || -> Result<(Bytes, UserOpGas)> {
            let paymaster_and_data = Bytes::from_str(&pmd_hex).context("bad paymasterAndData")?;
            // Pimlico returns only the fields it adjusts. Fields it omits must
            // keep the values the op was submitted with — the paymaster
            // signature inside paymasterAndData covers exactly those values,
            // so substituting anything else fails bundler signature checks
            // (-32507).
            let gas = UserOpGas {
                call_gas_limit: Self::parse_u256_opt(&res["callGasLimit"])?
                    .unwrap_or(Self::parse_u256(&op_json["callGasLimit"])?),
                verification_gas_limit: Self::parse_u256_opt(&res["verificationGasLimit"])?
                    .unwrap_or(Self::parse_u256(&op_json["verificationGasLimit"])?),
                pre_verification_gas: Self::parse_u256_opt(&res["preVerificationGas"])?
                    .unwrap_or(Self::parse_u256(&op_json["preVerificationGas"])?),
                max_fee_per_gas: Self::parse_u256_opt(&res["maxFeePerGas"])?
                    .unwrap_or(Self::parse_u256(&op_json["maxFeePerGas"])?),
                max_priority_fee_per_gas: Self::parse_u256_opt(&res["maxPriorityFeePerGas"])?
                    .unwrap_or(Self::parse_u256(&op_json["maxPriorityFeePerGas"])?),
            };
            Ok((paymaster_and_data, gas))
        };
        parse().map_err(|e: anyhow::Error| {
            warn!(body = %body, "unexpected pm_sponsorUserOperation response");
            SponsorReject::permanent("bad_response", format!("{e}"))
        })
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

    /// `eth_getUserOperationReceipt` — null until the op is mined. The result
    /// carries `success`, `actualGasCost`/`actualGasUsed`, and a nested
    /// `receipt` (transactionHash, logs, gasUsed, ...).
    pub async fn user_operation_receipt(
        &self,
        user_op_hash: &str,
    ) -> Result<Option<serde_json::Value>> {
        let res = self
            .rpc("eth_getUserOperationReceipt", json!([user_op_hash]))
            .await?;
        if res.is_null() {
            Ok(None)
        } else {
            Ok(Some(res))
        }
    }
}

/// Classified sponsorship failure. `reason` is a stable label for metrics;
/// `transient` marks transport faults worth retrying next block.
#[derive(Debug)]
pub struct SponsorReject {
    pub reason: &'static str,
    pub transient: bool,
    pub detail: String,
}

impl SponsorReject {
    fn permanent(reason: &'static str, detail: String) -> Self {
        Self { reason, transient: false, detail }
    }
    fn transport(detail: String) -> Self {
        Self { reason: "transport", transient: true, detail }
    }
    /// Map a paymaster JSON-RPC error body to a stable reason label.
    fn classify(err: String) -> Self {
        let s = err.to_lowercase();
        let (reason, transient) = if s.contains("reverted during simulation")
            || s.contains("-32521") || s.contains("execution reverted")
        {
            // The bundler simulated the op and our call reverted — deterministic:
            // resubmitting the same op will fail the same way (e.g. an executor
            // whose OWNER check rejects the smart account). Non-transient.
            ("exec_revert", false)
        } else if s.contains("quota") || s.contains("spend")
            || s.contains("limit") || s.contains("exceeded") || s.contains("cap")
        {
            ("quota_exhausted", false)
        } else if s.contains("insufficient") || s.contains("balance") || s.contains("deposit") {
            ("paymaster_balance", false)
        } else if s.contains("not found") || s.contains("does not exist")
            || s.contains("unknown") || s.contains("invalid") || s.contains("disabled")
        {
            ("policy_invalid", false)
        } else if s.contains("allowlist") || s.contains("chain") || s.contains("sender")
            || s.contains("policy") || s.contains("denied") || s.contains("forbidden")
        {
            ("policy_rejected", false)
        } else if s.contains("timeout") || s.contains("rate limit") || s.contains("429")
            || s.contains("503") || s.contains("internal")
        {
            ("transport", true)
        } else {
            ("rejected", false)
        };
        Self { reason, transient, detail: err }
    }
}

impl std::fmt::Display for SponsorReject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sponsorship {}: {}", self.reason, self.detail)
    }
}
impl std::error::Error for SponsorReject {}

/// Extract the stable reason label from an error chain, if the failure was
/// a classified sponsorship rejection.
pub fn sponsorship_reject_reason(err: &anyhow::Error) -> Option<&'static str> {
    err.downcast_ref::<SponsorReject>().map(|r| r.reason)
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

    /// The UserOperation sender — the counterfactual smart account whose
    /// address the executor's OWNER check expects as msg.sender.
    /// RPC-backed (factory.getAddress); callers should cache the result.
    pub async fn account(&self) -> Result<Address> {
        self.assembler.sender(&self.endpoint).await
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
        // The sponsor call simulates validateUserOp, so the op must carry a
        // well-formed 65-byte dummy signature (canonical permissionless.js
        // dummy); the real signature is applied after sponsorship rewrites
        // paymasterAndData and gas.
        let mut unsigned = self
            .assembler
            .assemble_unsigned(&self.endpoint, call.to, call.data.clone(), gas, Bytes::new())
            .await?;
        unsigned.signature = dummy_signature();

        let mut paymaster_and_data = Bytes::new();
        // Sponsorship is always attempted — with a policy when set, or
        // within the account's Pimlico balance when not. A rejection
        // rejects the op; there is no funded-wallet fallback.
        match self
            .client
            .sponsor(
                &unsigned.to_json(),
                self.cfg.entry_point,
                self.cfg.sponsor_policy_id.as_deref(),
            )
            .await
        {
            Ok((pmd, sponsored_gas)) => {
                gas = sponsored_gas;
                paymaster_and_data = pmd;
            }
            Err(reject) => {
                if reject.transient {
                    warn!(reason = reject.reason, error = %reject, "sponsorship transiently unavailable — op rejected");
                } else {
                    warn!(reason = reject.reason, error = %reject, "sponsorship rejected — op rejected (fix policy/budget)");
                }
                return Err(anyhow::Error::new(reject));
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
                    gas.clone(),
                    paymaster_and_data,
                )
                .await?;
            // assemble_unsigned re-derives gas (e.g. +400k verification for
            // initCode deployment). The paymaster signature covers the sponsor
            // response's gas fields verbatim — any mutation fails the bundler
            // signature check (-32507). Restore them exactly.
            op.gas = gas;
        }

        self.assembler.sign(&op).await
    }

    /// Boot-time reachability probe — a paymaster that can't answer gas
    /// prices will fail every sponsorship request.
    pub async fn paymaster_reachable(&self) -> bool {
        self.client.gas_price().await.is_ok()
    }

    /// Whether a sponsorship policy is configured.
    pub fn sponsored(&self) -> bool {
        self.cfg.sponsor_policy_id.is_some()
    }

    /// Assemble + sign and return the wire JSON — no send. Used for dry runs.
    pub async fn preview(&self, bundle: &Bundle) -> Result<serde_json::Value> {
        let op = self.build_userop(bundle).await?;
        Ok(json!({
            "entryPoint": format!("{:#x}", self.cfg.entry_point),
            "chainId": self.assembler.chain_id,
            "sponsored": !op.paymaster_and_data.is_empty(),
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
        debug!(
            sig_v = ?op.signature.last(),
            pmd_len = op.paymaster_and_data.len(),
            op = %op_json,
            "sending UserOperation"
        );
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
