//! Leader Wallet Intelligence — Phase 0/1: observation only.
//!
//! Watches the pending-swap stream for transactions sent by registered
//! "leader" wallets and persists every observation as JSONL under
//! `data/leaders/<chain>/<wallet>.jsonl`. NOTHING is copied or submitted —
//! this phase only measures what profitable wallets actually do.
//!
//! Safety rules (per directive): never copy recipient, approvals, nonce,
//! signatures, or raw calldata into any future submission path; the raw
//! bytes are stored here for offline replay measurement only.

use alloy_primitives::{Address, B256, U256};
use arb_mempool::watcher::PendingSwap;
use lazy_static::lazy_static;
use prometheus::{register_counter_vec, register_int_counter_vec, CounterVec, IntCounterVec};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use tracing::warn;

lazy_static! {
    /// Pending swaps observed per registered leader wallet.
    pub static ref LEADER_PENDING: IntCounterVec = register_int_counter_vec!(
        "arb_leader_pending_total",
        "Pending swaps observed from registered leader wallets",
        &["chain", "wallet"]
    )
    .unwrap();
    /// Per-wallet count of observations that hit a pool we track.
    pub static ref LEADER_POOL_TOUCH: IntCounterVec = register_int_counter_vec!(
        "arb_leader_pool_touch_total",
        "Leader observations touching at least one tracked pool",
        &["chain", "wallet"]
    )
    .unwrap();
    /// Leader observations attributed to each coarse strategy class.
    pub static ref LEADER_CLASS: IntCounterVec = register_int_counter_vec!(
        "arb_leader_class_total",
        "Leader observations by coarse strategy attribution class",
        &["chain", "wallet", "class"]
    )
    .unwrap();
    /// JSONL persistence failures (kept out of the hot path's error flow).
    pub static ref LEADER_WRITE_ERRORS: IntCounterVec = register_int_counter_vec!(
        "arb_leader_write_errors_total",
        "Failed JSONL writes for leader observations",
        &["chain"]
    )
    .unwrap();
    /// Observation→persist latency in microseconds.
    pub static ref LEADER_OBSERVE_US: CounterVec = register_counter_vec!(
        "arb_leader_observe_us_total",
        "Total microseconds spent persisting leader observations",
        &["chain"]
    )
    .unwrap();
}

/// One row of the `[leaders]` wallet table in a chain TOML.
#[derive(Debug, Clone, Deserialize)]
pub struct LeaderWallet {
    pub address: String,
    #[serde(default)]
    pub label: String,
    /// Free-text hypothesis, e.g. "sandwich", "atomic arb", "LP sniper".
    /// Filled in after observation data shows what the wallet does.
    #[serde(default)]
    pub strategy_hypothesis: String,
    /// "observe" (default) | "shadow" | "paper" | "live". Anything above
    /// observe is still recorded identically — execution gating is a
    /// later phase; the tier is carried so rollouts stay auditable.
    #[serde(default = "default_risk_tier")]
    pub risk_tier: String,
    /// Hard cap on copied notional for future phases. 0 = no copying.
    #[serde(default)]
    pub max_copied_notional_usd: f64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_risk_tier() -> String {
    "observe".to_string()
}
fn default_enabled() -> bool {
    true
}

/// `[leaders]` section of a chain config. Absent or empty = feature off.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct LeadersConfig {
    #[serde(default)]
    pub wallets: Vec<LeaderWallet>,
}

/// Parsed, enabled wallets keyed by checksummed-normalized address.
pub struct LeaderRegistry {
    wallets: HashMap<Address, LeaderWallet>,
}

impl LeaderRegistry {
    pub fn new(cfg: &LeadersConfig) -> Self {
        let mut wallets = HashMap::new();
        for w in &cfg.wallets {
            if !w.enabled {
                continue;
            }
            match w.address.parse::<Address>() {
                Ok(addr) => {
                    wallets.insert(addr, w.clone());
                }
                Err(_) => warn!(address = %w.address, "leader wallet address invalid — skipped"),
            }
        }
        Self { wallets }
    }

    pub fn is_empty(&self) -> bool {
        self.wallets.is_empty()
    }

    pub fn lookup(&self, from: &Address) -> Option<&LeaderWallet> {
        self.wallets.get(from)
    }
}

/// One persisted observation — the replay unit for Phase 2 measurement.
#[derive(Debug, Serialize)]
pub struct LeaderObservation {
    pub chain: String,
    pub wallet: String,
    pub label: String,
    pub tx_hash: B256,
    /// Unix milliseconds when the watcher first saw the pending tx.
    pub seen_unix_ms: u64,
    pub to: Address,
    pub value: String,
    /// Router tag from the decoder ("uniswap_v2_router", "direct_pool", ...).
    pub router: String,
    pub token_in: Option<Address>,
    pub token_out: Option<Address>,
    pub amount_in: Option<String>,
    pub path: Vec<Address>,
    pub hop_fees: Vec<u32>,
    /// Pool address when the tx calls swap() directly on a pool.
    pub direct_pool: Option<Address>,
    pub pools_touched: Vec<Address>,
    /// Coarse strategy class assigned at observation time.
    pub class: String,
    /// Full signed tx bytes — kept ONLY for offline replay against
    /// historical state. Never resubmitted (nonce/signature are the
    /// leader's; copying them would be invalid and out of policy).
    pub raw_tx: String,
    pub raw_input: String,
}

/// Coarse attribution: enough to bucket a wallet's flow before replay
/// measurement assigns real per-trade P&L.
fn classify(swap: &PendingSwap, touched_tracked_pool: bool) -> &'static str {
    if swap.decoded.direct.is_some() {
        "direct_pool_swap"
    } else if touched_tracked_pool {
        "tracked_pool_trade"
    } else if swap.decoded.path.len() > 2 {
        "multi_hop_router"
    } else if !swap.decoded.path.is_empty() {
        "single_hop_router"
    } else {
        "opaque"
    }
}

/// Writes observations to `data/leaders/<chain>/<wallet>.jsonl`.
pub struct LeaderObserver {
    registry: LeaderRegistry,
    dir: PathBuf,
    chain: String,
}

impl LeaderObserver {
    pub fn new(registry: LeaderRegistry, data_dir: PathBuf, chain: String) -> Self {
        Self { registry, dir: data_dir, chain }
    }

    /// Returns Some(configured wallet count) when the feature is on.
    pub fn wallet_count(&self) -> usize {
        self.registry.wallets.len()
    }

    /// Hot-path call on every decoded pending swap. O(1) registry lookup;
    /// returns immediately when `from` is not a registered leader.
    pub fn observe(&self, pending: &PendingSwap) {
        let t0 = std::time::Instant::now();
        let Some(wallet) = self.registry.lookup(&pending.from) else {
            return;
        };

        let touched_tracked_pool = !pending.decoded.pools_touched.is_empty();
        let class = classify(pending, touched_tracked_pool);
        let wallet_hex = format!("{:#x}", pending.from);

        LEADER_PENDING.with_label_values(&[&self.chain, &wallet_hex]).inc();
        LEADER_CLASS.with_label_values(&[&self.chain, &wallet_hex, class]).inc();
        if touched_tracked_pool {
            LEADER_POOL_TOUCH.with_label_values(&[&self.chain, &wallet_hex]).inc();
        }

        let obs = LeaderObservation {
            chain: self.chain.clone(),
            wallet: wallet_hex.clone(),
            label: wallet.label.clone(),
            tx_hash: pending.tx_hash,
            seen_unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            to: pending.to,
            value: pending.value.to_string(),
            router: pending.decoded.router.to_string(),
            token_in: pending.decoded.token_in,
            token_out: pending.decoded.token_out,
            amount_in: pending.decoded.amount_in.map(|a: U256| a.to_string()),
            path: pending.decoded.path.clone(),
            hop_fees: pending.decoded.hop_fees.clone(),
            direct_pool: pending.decoded.direct.as_ref().map(|d| match d {
                arb_mempool::decoder::DirectSwap::V2 { pool, .. }
                | arb_mempool::decoder::DirectSwap::V3 { pool, .. } => *pool,
            }),
            pools_touched: pending.decoded.pools_touched.clone(),
            class: class.to_string(),
            raw_tx: format!("0x{}", hex::encode(&pending.raw_tx)),
            raw_input: format!("0x{}", hex::encode(&pending.raw_input)),
        };

        if let Err(e) = self.persist(&wallet_hex, &obs) {
            LEADER_WRITE_ERRORS.with_label_values(&[&self.chain]).inc();
            warn!(error = %e, wallet = %wallet_hex, "leader observation write failed");
        }
        LEADER_OBSERVE_US
            .with_label_values(&[&self.chain])
            .inc_by(t0.elapsed().as_micros() as f64);
    }

    fn persist(&self, wallet_hex: &str, obs: &LeaderObservation) -> std::io::Result<()> {
        let dir = self.dir.join(&self.chain);
        create_dir_all(&dir)?;
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("{wallet_hex}.jsonl")))?;
        let mut line = serde_json::to_vec(obs).unwrap_or_default();
        line.push(b'\n');
        f.write_all(&line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::address;
    use arb_mempool::decoder::DecodedSwap;

    fn cfg_one(addr: &str) -> LeadersConfig {
        toml::from_str(&format!(
            r#"wallets = [{{ address = "{addr}", label = "test", risk_tier = "observe" }}]"#
        ))
        .unwrap()
    }

    #[test]
    fn registry_filters_and_normalizes() {
        let cfg = cfg_one("0x1111111111111111111111111111111111111111");
        let reg = LeaderRegistry::new(&cfg);
        assert_eq!(reg.wallets.len(), 1);
        assert!(reg
            .lookup(&address!("1111111111111111111111111111111111111111"))
            .is_some());
        assert!(reg
            .lookup(&address!("2222222222222222222222222222222222222222"))
            .is_none());
    }

    #[test]
    fn disabled_and_bad_addresses_are_skipped() {
        let cfg: LeadersConfig = toml::from_str(
            r#"wallets = [
                { address = "not-an-address" },
                { address = "0x3333333333333333333333333333333333333333", enabled = false },
            ]"#,
        )
        .unwrap();
        assert!(LeaderRegistry::new(&cfg).is_empty());
    }

    #[test]
    fn observation_persists_jsonl() {
        let dir = std::env::temp_dir().join(format!("arb-leaders-test-{}", std::process::id()));
        let cfg = cfg_one("0x4444444444444444444444444444444444444444");
        let obs = LeaderObserver::new(LeaderRegistry::new(&cfg), dir.clone(), "BSC".into());
        let pending = PendingSwap {
            tx_hash: B256::ZERO,
            from: address!("4444444444444444444444444444444444444444"),
            to: address!("5555555555555555555555555555555555555555"),
            value: U256::ZERO,
            decoded: DecodedSwap {
                router: "uniswap_v2_router",
                token_in: None,
                token_out: None,
                amount_in: Some(U256::from(1000u64)),
                path: vec![address!("6666666666666666666666666666666666666666")],
                first_hop_fee: None,
                hop_fees: vec![],
                direct: None,
                pools_touched: vec![],
            },
            raw_input: vec![1, 2, 3],
            raw_tx: vec![4, 5],
            seen_at: std::time::Instant::now(),
        };
        obs.observe(&pending);
        let file = dir.join("BSC").join("0x4444444444444444444444444444444444444444.jsonl");
        let body = std::fs::read_to_string(&file).unwrap();
        assert!(body.contains("\"class\":\"single_hop_router\""));
        assert!(body.contains("\"raw_tx\":\"0x0405\""));
        // Non-leader sender is ignored.
        let mut other = pending;
        other.from = address!("7777777777777777777777777777777777777777");
        obs.observe(&other);
        assert_eq!(std::fs::read_to_string(&file).unwrap().lines().count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
