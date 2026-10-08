//! The unit wallet intelligence produces and the engine trades:
//! one validated, executable, net-profitable opportunity.
//!
//! Commander directive: intelligence is not a wallet leaderboard. A record
//! is only actionable when our own simulator reproduces positive net profit
//! on live state. Only route geometry crosses from leader evidence into the
//! engine — never leader calldata, recipients, nonces, or signatures.

use alloy_primitives::Address;
use serde::{Deserialize, Serialize};
use std::io::BufRead;

fn serde_json_line<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_default()}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimulationStatus {
    /// Route decoded; not yet replayed through our simulator.
    Pending,
    /// find_optimal_amount returned positive net USD on live state.
    Pass,
    /// Simulator found no profitable amount.
    Fail,
    /// Could not be simulated (missing pools, stale state, quarantine).
    Unusable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    #[default]
    /// Evaluated only — no submission attempted.
    None,
    /// Passed the profit gate and exec probe; ready for a venue.
    Ready,
    Submitted,
    Landed,
    Reverted,
    Dropped,
    /// Settled on-chain; realized P&L in `settled_net_usd`.
    Settled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionableOpportunity {
    /// Stable id: "<chain>/<strategy_id>/<source_tx>".
    pub opportunity_id: String,
    pub chain: String,
    /// Wallet whose mined tx provided the route evidence.
    pub source_wallet: String,
    /// Leader's mined tx hash (evidence only — never replayed verbatim).
    pub source_tx: String,
    /// Orderflow the leader traded against (sibling tx in the same block).
    #[serde(default)]
    pub victim_tx: String,
    #[serde(default)]
    pub target_block: u64,
    /// Ordered pool counterparties of the leader's route.
    pub route_pools: Vec<String>,
    #[serde(default)]
    pub token_in: String,
    #[serde(default)]
    pub token_out: String,
    /// Leader's realized net P&L on the source tx, after gas, USD.
    #[serde(default)]
    pub leader_net_usd: f64,
    /// Our simulator's best profit through this route on live state, USD.
    #[serde(default)]
    pub allbright_net_usd: f64,
    #[serde(default)]
    pub flash_amount: String,
    #[serde(default)]
    pub gas_usd: f64,
    #[serde(default)]
    pub profit_bps: f64,
    /// Milliseconds between the state snapshot and evaluation.
    #[serde(default)]
    pub state_age_ms: u64,
    /// Block the opportunity must land in by (0 = unknown).
    #[serde(default)]
    pub inclusion_deadline: u64,
    pub simulation_status: SimulationStatus,
    #[serde(default)]
    pub execution_status: ExecutionStatus,
    /// Machine-readable rejection when not actionable
    /// (no_victim_context, route_untracked, state_stale,
    /// negative_net_after_gas, pool_quarantined, simulation_revert,
    /// builder_reject, venue_error, no_venue, bundle_build_failed,
    /// landed_revert, settlement_mismatch).
    #[serde(default)]
    pub rejection_reason: String,
    /// Realized P&L after settlement feedback, USD.
    #[serde(default)]
    pub settled_net_usd: f64,
    #[serde(default)]
    pub unix_ms: u64,
    // ---- Aggregated-feed context (DEXScreener-mirrored columns) ----------
    /// Pair label as the feed renders it, e.g. "CAKE / WBNB".
    #[serde(default)]
    pub feed_pair: String,
    /// Dex ids of the two legs, e.g. "pancakeswap-v3-bsc" → "pancakeswap_v2".
    #[serde(default)]
    pub feed_dex_in: String,
    #[serde(default)]
    pub feed_dex_out: String,
    /// Cheapest pool (where the borrow leg buys) and dearest pool.
    #[serde(default)]
    pub buy_pool: String,
    #[serde(default)]
    pub sell_pool: String,
    /// Price band across the pair's pools, quote-denominated.
    #[serde(default)]
    pub feed_price_lo: f64,
    #[serde(default)]
    pub feed_price_hi: f64,
    /// Shallower leg's liquidity, USD.
    #[serde(default)]
    pub feed_liquidity_usd: f64,
    /// h1 transaction count on the shallower leg.
    #[serde(default)]
    pub feed_h1_txns: u64,
}

impl ActionableOpportunity {
    pub fn new(
        chain: &str,
        strategy_id: &str,
        source_wallet: &str,
        source_tx: &str,
        route_pools: Vec<String>,
    ) -> Self {
        Self {
            opportunity_id: format!("{chain}/{strategy_id}/{source_tx}"),
            chain: chain.to_string(),
            source_wallet: source_wallet.to_string(),
            source_tx: source_tx.to_string(),
            victim_tx: String::new(),
            target_block: 0,
            route_pools,
            token_in: String::new(),
            token_out: String::new(),
            leader_net_usd: 0.0,
            allbright_net_usd: 0.0,
            flash_amount: String::new(),
            gas_usd: 0.0,
            profit_bps: 0.0,
            state_age_ms: 0,
            inclusion_deadline: 0,
            simulation_status: SimulationStatus::Pending,
            execution_status: ExecutionStatus::None,
            rejection_reason: String::new(),
            settled_net_usd: 0.0,
            feed_pair: String::new(),
            feed_dex_in: String::new(),
            feed_dex_out: String::new(),
            buy_pool: String::new(),
            sell_pool: String::new(),
            feed_price_lo: 0.0,
            feed_price_hi: 0.0,
            feed_liquidity_usd: 0.0,
            feed_h1_txns: 0,
            unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }
    }

    /// Actionable = our simulator reproduced positive net profit and no
    /// rejection is standing. This is the ONLY definition the engine and the
    /// dashboard may use — never "the leader made money".
    pub fn is_actionable(&self) -> bool {
        self.simulation_status == SimulationStatus::Pass
            && self.allbright_net_usd > 0.0
            && self.rejection_reason.is_empty()
    }

    /// Terminal update for a candidate that was logged while being evaluated
    /// but then died before/at submission (exec probe, bundle build, venue).
    /// Appending preserves the audit trail; `rejection_reason` removes it
    /// from the actionable set — a row may claim "ready to execute" only
    /// while every downstream gate still stands.
    pub fn mark_rejected(&mut self, reason: &str, dir: &str) {
        self.execution_status = ExecutionStatus::None;
        self.rejection_reason = reason.to_string();
        self.unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let _ = self.append_jsonl(dir);
    }

    /// Append one record to data/leaders/<chain>/_opportunities.jsonl.
    pub fn append_jsonl(&self, dir: &str) -> std::io::Result<()> {
        use std::io::Write;
        std::fs::create_dir_all(dir)?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(format!("{dir}/_opportunities.jsonl"))?;
        writeln!(f, "{}", serde_json_line(self))
    }
}

/// Route-ranking score — Commander directive: rank executable strategies,
/// not wallets. Wallet identity is supporting evidence only.
///
/// score = net × reproduction_precision × inclusion_probability
///         × freshness × route_confidence − gas_risk − revert_risk
pub fn route_score(
    net_profit_usd: f64,
    reproduction_precision: f64,
    inclusion_probability: f64,
    state_age_ms: u64,
    route_confidence: f64,
    gas_risk_usd: f64,
    revert_risk_usd: f64,
) -> f64 {
    // Freshness decays linearly to zero at 3s — a full block time on BSC.
    let freshness = (1.0 - state_age_ms as f64 / 3000.0).clamp(0.0, 1.0);
    net_profit_usd * reproduction_precision * inclusion_probability
        * freshness * route_confidence
        - gas_risk_usd
        - revert_risk_usd
}

/// Load the append-only opportunity log; latest record per opportunity_id.
pub fn load_opportunities(dir: &str) -> Vec<ActionableOpportunity> {
    let mut out: std::collections::HashMap<String, ActionableOpportunity> =
        std::collections::HashMap::new();
    let Ok(f) = std::fs::File::open(format!("{dir}/_opportunities.jsonl")) else {
        return Vec::new();
    };
    for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
        if let Ok(o) = serde_json::from_str::<ActionableOpportunity>(&line) {
            out.insert(o.opportunity_id.clone(), o);
        }
    }
    out.into_values().collect()
}

pub fn address_opt(s: &str) -> Option<Address> {
    s.parse().ok()
}
