use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use alloy::providers::{Provider, ProviderBuilder, WsConnect};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol_types::SolCall;
use alloy_primitives::{Address, B256, U256};
use anyhow::Result;
use futures::StreamExt;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use arb_discovery::store::DiscoveryStore;
use arb_mempool::MempoolWatcher;
use arb_core::types::Protocol;
use arb_paths::enumerate::{PathEnumerator, PoolInfo};
use arb_paths::PathTemplate;
use arb_rpc::Endpoint;
use arb_sim::evaluate::evaluate_all;
use arb_sim::gate::ProfitGate;
use arb_sim::optimize::{find_optimal_amount, path_max_flash};
use arb_state::pool_store::PoolStore;
use arb_state::refresher::{PoolConfig, StateRefresher};
use arb_submit::blink::BlinkSubmitter;
use arb_submit::blockrazor::BlockRazorSubmitter;
use arb_submit::direct::DirectSubmitter;
use arb_submit::jetbldr::JetBldrSubmitter;
use arb_submit::nodereal::NodeRealSubmitter;
use arb_submit::puissant::PuissantSubmitter;
use arb_submit::warp::WarpSubmitter;
use arb_submit::pimlico::{PimlicoConfig, PimlicoSubmitter};
use arb_submit::presign::PresignPool;
use arb_submit::{SubmitTier, Submitter};

use crate::config::{spec, AppConfig};
use crate::metrics;

const CIRCUIT_BREAKER_MAX_REVERTS: u32 = 3;
const CIRCUIT_BREAKER_SUPPRESS_BLOCKS: u64 = 30;
const CIRCUIT_BREAKER_DECAY_BLOCKS: u64 = 100;
/// A pool whose last successful state read is older than this is stale —
/// candidate paths through it are suppressed before optimization.
const STALE_STATE_MAX_AGE_MS: u64 = 90_000;

mod quote_uni {
    alloy::sol! {
        function quoteExactInputSingle((address,address,uint256,uint24,uint160) calldata) external returns (uint256,uint160,uint32,uint256);
    }
}
mod quote_slip {
    alloy::sol! {
        function quoteExactInputSingle((address,address,uint256,int24,uint160) calldata) external returns (uint256,uint160,uint32,uint256);
    }
}

alloy::sol! {
    struct ProbeCall3 { address target; bool allowFailure; bytes callData; }
    struct ProbeResult3 { bool success; bytes returnData; }
    function aggregate3(ProbeCall3[] calldata calls) external payable returns (ProbeResult3[] memory);
    function tickSpacing() external view returns (int24);
}

/// Quoter deployments verified on-chain (quoter.factory() matches the
/// pool factory): PancakeSwap V3 QuoterV2 on BSC, Uniswap V3 QuoterV2 and
/// Aerodrome Slipstream QuoterV2 on Base.
const UNI_QUOTER_BSC: Address = alloy_primitives::address!("B048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997");
const UNI_QUOTER_BASE: Address = alloy_primitives::address!("3d4e44Eb1374240CE5F1B871ab261CD16335B76a");
/// Canonical Uniswap V3 QuoterV2 — deterministic CREATE2 deployment, same
/// address on Ethereum, Polygon and most UniV3 chains.
const UNI_QUOTER_UNI: Address = alloy_primitives::address!("61fFE014bA17989E743c5F6cB21bF9697530B21e");
const SLIP_QUOTER_BASE: Address = alloy_primitives::address!("254cF9E1E6e233aa1AC962CB9B05b2cfeAae15b0");

/// A concentrated-liquidity pool can report `liquidity() > 0` while its
/// stored price is abandoned — the active tick holds little or nothing on
/// one side, so the sim sees a fake spread vs healthy pools but on-chain
/// the swap yields dust (e.g. BSC pool 0x62Cf0052..c16770: 489 wei out on
/// a 0.001-token input). Probe each V3-family pool once at boot through
/// the real QuoterV2 in both directions and quarantine pools whose
/// executable output diverges from the slot0-implied price by >2x.
/// V2 reserves are always executable (x*y=k), so they never need this.
async fn probe_dead_v3_pools(
    endpoint: &Endpoint,
    store: &PoolStore,
    pools: &[PoolInfo],
    decimals: &HashMap<Address, u32>,
    chain_id: u64,
) -> HashSet<Address> {
    struct Probe {
        pool: Address,
        quoter: Address,
        zfo: bool,
        token_in: Address,
        token_out: Address,
        amount_in: U256,
        /// fee for UniV3-style quoters, tickSpacing for Slipstream.
        key_param: u32,
    }

    // Slipstream quoter keys pools by tickSpacing, not fee — fetch those first.
    let mut slip_ts: HashMap<Address, i32> = HashMap::new();
    let slip_pools: Vec<Address> = pools
        .iter()
        .filter(|p| p.protocol == Protocol::AerodromeSlipstream)
        .map(|p| p.address)
        .collect();
    if !slip_pools.is_empty() && chain_id == spec::BASE_CHAIN_ID {
        let calls: Vec<ProbeCall3> = slip_pools
            .iter()
            .map(|&p| ProbeCall3 {
                target: p,
                allowFailure: true,
                callData: tickSpacingCall::new(()).abi_encode().into(),
            })
            .collect();
        let cd = aggregate3Call { calls }.abi_encode().into();
        if let Ok((ret, _)) = endpoint
            .eth_call_timed(arb_state::refresher::MULTICALL3_ADDR, cd)
            .await
        {
            if let Ok(results) = aggregate3Call::abi_decode_returns(&ret) {
                for (p, r) in slip_pools.iter().zip(results.iter()) {
                    if r.success {
                        if let Ok(ts) = tickSpacingCall::abi_decode_returns(&r.returnData[..]) {
                            slip_ts.insert(*p, ts.as_i32());
                        }
                    }
                }
            }
        }
    }

    let mut probes: Vec<Probe> = Vec::new();
    let mut amount_for = |token: Address| -> U256 {
        let dec = decimals.get(&token).copied().unwrap_or(18).min(30);
        U256::from(10u128).pow(U256::from(dec.saturating_sub(2)))
    };
    for pi in pools {
        let Some(arb_core::types::PoolState::V3(v3)) = store.get(&pi.address) else {
            continue;
        };
        let (quoter, key_param) = match pi.protocol {
            Protocol::UniswapV3 => {
                let q = if chain_id == spec::BSC_CHAIN_ID {
                    UNI_QUOTER_BSC
                } else if chain_id == spec::BASE_CHAIN_ID {
                    UNI_QUOTER_BASE
                } else {
                    // Other UniV3 chains share the canonical QuoterV2 deploy.
                    UNI_QUOTER_UNI
                };
                (q, v3.fee)
            }
            Protocol::AerodromeSlipstream if chain_id == spec::BASE_CHAIN_ID => {
                let Some(&ts) = slip_ts.get(&pi.address) else { continue };
                (SLIP_QUOTER_BASE, ts as u32)
            }
            // Algebra and other CL families: no verified quoter — fail-open,
            // the per-submission exec probe still protects the pipeline.
            _ => continue,
        };
        let zfo_amt = amount_for(pi.token0);
        let ofz_amt = amount_for(pi.token1);
        probes.push(Probe {
            pool: pi.address, quoter, zfo: true,
            token_in: pi.token0, token_out: pi.token1,
            amount_in: zfo_amt, key_param,
        });
        probes.push(Probe {
            pool: pi.address, quoter, zfo: false,
            token_in: pi.token1, token_out: pi.token0,
            amount_in: ofz_amt, key_param,
        });
    }
    if probes.is_empty() {
        return HashSet::new();
    }

    let calls: Vec<ProbeCall3> = probes
        .iter()
        .map(|pr| {
            let data: alloy_primitives::Bytes = if pr.quoter == SLIP_QUOTER_BASE {
                quote_slip::quoteExactInputSingleCall::new((
                    (
                        pr.token_in,
                        pr.token_out,
                        pr.amount_in,
                        alloy_primitives::Signed::<24, 1>::try_from(pr.key_param as i32)
                            .unwrap_or_default(),
                        alloy_primitives::Uint::<160, 3>::ZERO,
                    ),
                ))
                .abi_encode()
                .into()
            } else {
                quote_uni::quoteExactInputSingleCall::new((
                    (
                        pr.token_in,
                        pr.token_out,
                        pr.amount_in,
                        alloy_primitives::Uint::<24, 1>::from(pr.key_param),
                        alloy_primitives::Uint::<160, 3>::ZERO,
                    ),
                ))
                .abi_encode()
                .into()
            };
            ProbeCall3 { target: pr.quoter, allowFailure: true, callData: data }
        })
        .collect();

    let cd = aggregate3Call { calls }.abi_encode().into();
    let Ok((ret, _)) = endpoint
        .eth_call_timed(arb_state::refresher::MULTICALL3_ADDR, cd)
        .await
    else {
        // Probe infrastructure unreachable — fail-open, don't blind-drop.
        warn!("V3 pool quarantine probe failed at transport level — keeping all pools");
        return HashSet::new();
    };
    let Ok(results) = aggregate3Call::abi_decode_returns(&ret) else {
        return HashSet::new();
    };

    let mut dead: HashSet<Address> = HashSet::new();
    let q96: f64 = 79_228_162_514_264_337_593_543_950_336.0; // 2^96
    for (pr, r) in probes.iter().zip(results.iter()) {
        let mut dead_dir = !r.success;
        if let Some(arb_core::types::PoolState::V3(v3)) = store.get(&pr.pool) {
            if !dead_dir {
                let amount_out: U256 = quote_uni::quoteExactInputSingleCall::abi_decode_returns(
                    &r.returnData[..],
                )
                .map(|d| d._0)
                .unwrap_or_default();
                // Predicted output from slot0 price in f64 — a >2x shortfall
                // means the executable depth isn't where the price says it is.
                let sqrt_f: f64 = v3.sqrt_price_x96.to_string().parse().unwrap_or(0.0);
                let price = (sqrt_f / q96) * (sqrt_f / q96); // token1_raw / token0_raw
                let fee_frac = v3.fee as f64 / 1e6;
                let in_f: f64 = pr.amount_in.to_string().parse().unwrap_or(0.0);
                let expected = if pr.zfo {
                    in_f * price * (1.0 - fee_frac)
                } else {
                    in_f / price * (1.0 - fee_frac)
                };
                let got: f64 = amount_out.to_string().parse().unwrap_or(0.0);
                if got < expected * 0.5 {
                    dead_dir = true;
                }
            }
        } else {
            dead_dir = true;
        }
        if dead_dir {
            dead.insert(pr.pool);
        }
    }
    for p in &dead {
        let dirs: Vec<&str> = probes
            .iter()
            .filter(|pr| &pr.pool == p)
            .map(|pr| if pr.zfo { "zfo" } else { "ofz" })
            .collect();
        debug!(pool = %p, ?dirs, "pool quarantined by quoter probe");
    }
    dead
}

/// Decode the executor's revert from an exec-probe error into a stable
/// label — keeps logs/metrics honest about WHY a path can't land.
fn classify_exec_probe_revert(detail: &str) -> &'static str {
    let s = detail.to_lowercase();
    if s.contains("0x4e88422a") {
        "insufficient_profit"
    } else if s.contains("0x82b42900") {
        "unauthorized"
    } else if s.contains("0x4ecb9b6d") {
        "swap_failed"
    } else if s.contains("0xab35696f") {
        "contract_paused"
    } else if s.contains("0x94118333") {
        "gas_price_too_high"
    } else if s.contains("0x0f359167") {
        "unsettled_delta"
    } else if s.contains("0xbf16aab6") {
        "unsupported_token"
    } else if s.contains("0x73402469") {
        "invalid_protocol"
    } else if s.contains("0x5274afe7") {
        "safe_erc20_failed"
    } else if s.contains("0x2c5211c6") {
        "invalid_amount"
    } else {
        "unknown_revert"
    }
}

struct PathCircuitBreaker {
    stats: HashMap<u32, PathStats>,
}

struct PathStats {
    consecutive_reverts: u32,
    last_revert_block: u64,
    suppressed_until_block: u64,
    total_submits: u64,
    total_reverts: u64,
    total_successes: u64,
}

impl PathCircuitBreaker {
    fn new() -> Self {
        Self { stats: HashMap::new() }
    }

    fn is_suppressed(&self, path_id: u32, current_block: u64) -> bool {
        if let Some(s) = self.stats.get(&path_id) {
            current_block < s.suppressed_until_block
        } else {
            false
        }
    }

    fn record_submit(&mut self, path_id: u32) {
        let s = self.stats.entry(path_id).or_insert(PathStats {
            consecutive_reverts: 0, last_revert_block: 0, suppressed_until_block: 0,
            total_submits: 0, total_reverts: 0, total_successes: 0,
        });
        s.total_submits += 1;
    }

    fn record_revert(&mut self, path_id: u32, block: u64) {
        let s = self.stats.entry(path_id).or_insert(PathStats {
            consecutive_reverts: 0, last_revert_block: 0, suppressed_until_block: 0,
            total_submits: 0, total_reverts: 0, total_successes: 0,
        });
        s.total_reverts += 1;
        if block > s.last_revert_block + CIRCUIT_BREAKER_DECAY_BLOCKS {
            s.consecutive_reverts = 0;
        }
        s.consecutive_reverts += 1;
        s.last_revert_block = block;
        if s.consecutive_reverts >= CIRCUIT_BREAKER_MAX_REVERTS {
            s.suppressed_until_block = block + CIRCUIT_BREAKER_SUPPRESS_BLOCKS;
            metrics::PATH_SUPPRESSED.inc();
            warn!(path_id, until_block = s.suppressed_until_block, "Path circuit-breaker tripped");
        }
    }

    fn record_success(&mut self, path_id: u32) {
        let s = self.stats.entry(path_id).or_insert(PathStats {
            consecutive_reverts: 0, last_revert_block: 0, suppressed_until_block: 0,
            total_submits: 0, total_reverts: 0, total_successes: 0,
        });
        s.consecutive_reverts = 0;
        s.suppressed_until_block = 0;
        s.total_successes += 1;
    }

    fn suppressed_count(&self, current_block: u64) -> usize {
        self.stats.values().filter(|s| current_block < s.suppressed_until_block).count()
    }

    /// Top-10 paths by total submissions (most active).
    fn top_active(&self) -> Vec<(u32, u64, u64, u64)> {
        let mut entries: Vec<_> = self.stats.iter()
            .filter(|(_, s)| s.total_submits > 0)
            .map(|(&pid, s)| (pid, s.total_submits, s.total_reverts, s.total_successes))
            .collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1));
        entries.truncate(10);
        entries
    }

    /// Bottom-10 paths by revert rate (highest revert %).
    fn worst_revert_rate(&self) -> Vec<(u32, u64, u64, f64)> {
        let mut entries: Vec<_> = self.stats.iter()
            .filter(|(_, s)| s.total_submits >= 3)
            .map(|(&pid, s)| {
                let rate = s.total_reverts as f64 / s.total_submits as f64;
                (pid, s.total_submits, s.total_reverts, rate)
            })
            .collect();
        entries.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));
        entries.truncate(10);
        entries
    }
}

struct TokenCircuitBreaker {
    stats: HashMap<Address, TokenBreakerStats>,
    revert_threshold: u32,
    suppression_blocks: u64,
    blacklist: HashSet<Address>,
    popular_intermediaries: HashSet<Address>,
    /// Bait telemetry (stealth L4): pools repeatedly present in paths that
    /// gate-pass then revert on exec-probe/submit are griefing or honeypot
    /// signatures — flagged pools suppress candidate paths like tokens.
    pool_stats: HashMap<Address, TokenBreakerStats>,
}

struct TokenBreakerStats {
    consecutive_reverts: u32,
    last_revert_block: u64,
    suppressed_until_block: u64,
}

impl TokenCircuitBreaker {
    fn new(revert_threshold: u32, suppression_blocks: u64) -> Self {
        Self {
            stats: HashMap::new(),
            revert_threshold,
            suppression_blocks,
            blacklist: HashSet::new(),
            popular_intermediaries: HashSet::new(),
            pool_stats: HashMap::new(),
        }
    }

    fn set_popular_intermediaries(&mut self, tokens: impl IntoIterator<Item = Address>) {
        self.popular_intermediaries = tokens.into_iter().collect();
    }

    fn load_blacklist(&mut self, path: &std::path::Path) {
        if let Ok(contents) = std::fs::read_to_string(path) {
            if let Ok(bl) = serde_json::from_str::<serde_json::Value>(&contents) {
                if let Some(addrs) = bl.get("addresses").and_then(|a| a.as_array()) {
                    for entry in addrs {
                        if let Some(addr_str) = entry.get("address").and_then(|a| a.as_str()) {
                            if let Ok(addr) = addr_str.parse::<Address>() {
                                self.blacklist.insert(addr);
                            }
                        }
                    }
                }
                info!(count = self.blacklist.len(), "Loaded token blacklist");
            }
        }
    }

    fn is_token_suppressed(&self, token: Address, current_block: u64) -> bool {
        if self.blacklist.contains(&token) {
            return true;
        }
        if let Some(s) = self.stats.get(&token) {
            current_block < s.suppressed_until_block
        } else {
            false
        }
    }

    fn is_pool_bait_flagged(&self, pool: Address, current_block: u64) -> bool {
        self.pool_stats
            .get(&pool)
            .map_or(false, |s| current_block < s.suppressed_until_block)
    }

    fn is_path_token_suppressed(&self, path: &PathTemplate, current_block: u64) -> bool {
        path.hops.iter().any(|hop| {
            self.is_token_suppressed(hop.token_in, current_block)
                || self.is_token_suppressed(hop.token_out, current_block)
                || self.is_pool_bait_flagged(hop.pool, current_block)
        })
    }

    fn record_revert_for_path(&mut self, path: &PathTemplate, block: u64) {
        for hop in &path.hops {
            // Pool-level bait accounting: same decay/threshold as tokens.
            {
                let s = self.pool_stats.entry(hop.pool).or_insert(TokenBreakerStats {
                    consecutive_reverts: 0,
                    last_revert_block: 0,
                    suppressed_until_block: 0,
                });
                if block > s.last_revert_block + 200 {
                    s.consecutive_reverts = 0;
                }
                s.consecutive_reverts += 1;
                s.last_revert_block = block;
                if s.consecutive_reverts >= self.revert_threshold {
                    s.suppressed_until_block = block + self.suppression_blocks;
                    metrics::BAIT_SUSPECT.inc();
                    warn!(pool = %hop.pool, until_block = s.suppressed_until_block,
                        "Bait-suspect pool suppressed — repeated gate-pass-then-revert signature");
                }
            }
            for &token in &[hop.token_in, hop.token_out] {
                if token == path.flash_token || self.popular_intermediaries.contains(&token) {
                    continue;
                }
                let s = self.stats.entry(token).or_insert(TokenBreakerStats {
                    consecutive_reverts: 0,
                    last_revert_block: 0,
                    suppressed_until_block: 0,
                });
                if block > s.last_revert_block + 200 {
                    s.consecutive_reverts = 0;
                }
                s.consecutive_reverts += 1;
                s.last_revert_block = block;
                if s.consecutive_reverts >= self.revert_threshold {
                    s.suppressed_until_block = block + self.suppression_blocks;
                    warn!(token = %token, until_block = s.suppressed_until_block,
                        "Token circuit-breaker tripped");
                }
            }
        }
    }

    fn record_success_for_path(&mut self, path: &PathTemplate) {
        for hop in &path.hops {
            if let Some(s) = self.pool_stats.get_mut(&hop.pool) {
                s.consecutive_reverts = 0;
                s.suppressed_until_block = 0;
            }
            for &token in &[hop.token_in, hop.token_out] {
                if let Some(s) = self.stats.get_mut(&token) {
                    s.consecutive_reverts = 0;
                    s.suppressed_until_block = 0;
                }
            }
        }
    }

    fn suppressed_token_count(&self, current_block: u64) -> usize {
        self.blacklist.len()
            + self.stats.values().filter(|s| current_block < s.suppressed_until_block).count()
    }
}

fn is_nonempty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|v| !v.is_empty())
}

enum TxOutcome { Success, Revert, Dropped }

/// Track a submitted tx hash — poll for receipt, update metrics.
/// Returns the outcome so the caller can feed the circuit breaker.
async fn track_tx(endpoint: Arc<Endpoint>, tx_hash: B256, deadline_blocks: u64) -> TxOutcome {
    let start_block = endpoint.block_number().await.unwrap_or(0);
    let max_polls = (deadline_blocks * 4).max(8);
    let poll_interval_ms = 750;

    for _ in 0..max_polls {
        match endpoint.get_receipt(tx_hash).await {
            Ok(Some(receipt)) => {
                let success = receipt.status();
                let label = if success { "success" } else { "revert" };
                metrics::SUBMIT_LANDED.with_label_values(&[label]).inc();
                let gas_cost = receipt.gas_used as f64 * receipt.effective_gas_price as f64;
                metrics::GAS_SPENT_WEI.inc_by(gas_cost);
                info!(
                    tx = %tx_hash,
                    status = label,
                    gas_used = receipt.gas_used,
                    "Tx landed on-chain"
                );
                return if success { TxOutcome::Success } else { TxOutcome::Revert };
            }
            Ok(None) => {}
            Err(e) => {
                debug!(tx = %tx_hash, error = %e, "Receipt fetch error");
            }
        }
        if endpoint.block_number().await.unwrap_or(0) > start_block + deadline_blocks {
            metrics::SUBMIT_LANDED.with_label_values(&["dropped"]).inc();
            debug!(tx = %tx_hash, "Tx dropped (not mined within deadline)");
            return TxOutcome::Dropped;
        }
        tokio::time::sleep(Duration::from_millis(poll_interval_ms)).await;
    }
    metrics::SUBMIT_LANDED.with_label_values(&["dropped"]).inc();
    TxOutcome::Dropped
}

/// Write status JSON snapshot for monitoring.
fn write_status_json(
    chain_name: &str,
    started: &chrono::DateTime<chrono::Utc>,
    block: u64,
    wallet_balance: &str,
    cb: &PathCircuitBreaker,
) {
    let now = chrono::Utc::now();
    let uptime = (now - *started).num_seconds();

    let landed_ok = metrics::SUBMIT_LANDED.with_label_values(&["success"]).get() as u64;
    let landed_revert = metrics::SUBMIT_LANDED.with_label_values(&["revert"]).get() as u64;
    let dropped = metrics::SUBMIT_LANDED.with_label_values(&["dropped"]).get() as u64;

    let top_active: Vec<_> = cb.top_active().iter().map(|(pid, sub, rev, suc)| {
        serde_json::json!({"path_id": pid, "submits": sub, "reverts": rev, "successes": suc})
    }).collect();

    let worst_revert: Vec<_> = cb.worst_revert_rate().iter().map(|(pid, sub, rev, rate)| {
        serde_json::json!({"path_id": pid, "submits": sub, "reverts": rev, "revert_pct": format!("{:.0}", rate * 100.0)})
    }).collect();

    let status = serde_json::json!({
        "chain": chain_name,
        "started": started.to_rfc3339(),
        "last_update": now.to_rfc3339(),
        "block": block,
        "uptime_seconds": uptime,
        "metrics": {
            "scans_total": metrics::PATHS_EVALUATED.get() as u64,
            "candidates_total": metrics::PROFITABLE_FOUND.get() as u64,
            "submitted_total": metrics::SUBMIT_ATTEMPTS.get() as u64,
            "landed_success": landed_ok,
            "landed_revert": landed_revert,
            "dropped": dropped,
            "paths_suppressed": cb.suppressed_count(block),
            "backrun_candidates": metrics::BACKRUN_CANDIDATES.get() as u64,
            "backrun_submitted": metrics::BACKRUN_SUBMITTED.get() as u64,
            "warp_spend_usd": format!("{:.2}", metrics::WARP_SPEND_USD.get()),
        },
        "wallet_balance_native": wallet_balance,
        "top_active_paths": top_active,
        "worst_revert_paths": worst_revert,
    });

    let dir = std::path::Path::new("status");
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(format!("{}.json", chain_name.to_lowercase()));
    let _ = std::fs::write(path, serde_json::to_string_pretty(&status).unwrap_or_default());
}

pub async fn run(cfg: AppConfig, smoke_test: bool) -> Result<()> {
    let started = chrono::Utc::now();
    let chain_name = cfg.chain.name.clone();

    let pk_env = &cfg.wallet.private_key_env;
    let private_key = std::env::var(pk_env)
        .map_err(|_| anyhow::anyhow!("Missing env var {pk_env}"))?;
    let mut signers: Vec<PrivateKeySigner> = vec![private_key.parse()?];
    if let Some(extra) = &cfg.wallet.private_key_envs {
        for env_name in extra {
            let Ok(pk) = std::env::var(env_name) else {
                warn!(env = %env_name, "signer rotation: env var unset — skipped");
                continue;
            };
            match pk.parse::<PrivateKeySigner>() {
                Ok(s) => signers.push(s),
                Err(e) => warn!(env = %env_name, error = %e, "signer rotation: bad key — skipped"),
            }
        }
    }
    let signer: PrivateKeySigner = signers[0].clone();
    let signer_rot = std::sync::atomic::AtomicUsize::new(0);
    if signers.len() > 1 {
        info!(n = signers.len(), "Signer rotation pool loaded — submit calls round-robin EOAs");
    } else {
        info!(address = %signer.address(), "Wallet loaded");
    }

    let trader_url = cfg.chain.trader_rpc.as_deref();
    let mut read_urls: Vec<&str> = cfg.chain.rpc_https_pool.iter().map(String::as_str).collect();
    if read_urls.is_empty() {
        read_urls.push(cfg.chain.rpc_https.as_str());
    }
    let endpoint = Arc::new(
        Endpoint::new_pooled(&read_urls, &cfg.chain.rpc_wss, trader_url, cfg.chain.chain_id).await?,
    );

    let tokens: HashMap<String, Address> = cfg
        .tokens
        .iter()
        .map(|(name, addr_str)| {
            let addr: Address = addr_str.parse().expect("Invalid token address");
            (name.clone(), addr)
        })
        .collect();

    let token_usd_prices: HashMap<Address, f64> = cfg
        .token_usd_prices
        .iter()
        .filter_map(|(name, &price)| tokens.get(name).map(|&addr| (addr, price)))
        .collect();

    let mut pool_configs: Vec<PoolConfig> = cfg
        .pools
        .iter()
        .map(|p| PoolConfig {
            address: p.address.parse().expect("Invalid pool address"),
            protocol: p.parse_protocol(),
            fee_bps: p.fee_bps,
            token0: tokens.get(&p.token0).copied(),
            token1: tokens.get(&p.token1).copied(),
        })
        .collect();

    let mut pool_infos: Vec<PoolInfo> = cfg
        .pools
        .iter()
        .map(|p| PoolInfo {
            address: p.address.parse().expect("Invalid pool address"),
            protocol: p.parse_protocol(),
            token0: tokens[&p.token0],
            token1: tokens[&p.token1],
        })
        .collect();

    let token_syms: HashMap<Address, String> = tokens
        .iter()
        .map(|(name, addr)| (*addr, name.clone()))
        .collect();
    let mut token_usd_prices = token_usd_prices;
    let mut token_decimals: HashMap<Address, u32> = HashMap::new();

    // Populate decimals for known tokens from config
    for (name, &addr) in &tokens {
        let dec = match name.as_str() {
            "USDT" | "USDC" | "USDbC" | "BUSD" => 6,
            _ => 18,
        };
        token_decimals.insert(addr, dec);
    }

    // Canonical token-list reconciliation (Uniswap Token Lists spec):
    // verify symbol→address bindings and correct decimals metadata.
    if let Some(registry) = crate::token_lists::fetch_registry(cfg.chain.chain_id).await {
        crate::token_lists::reconcile(&registry, &tokens, &mut token_decimals);
    }

    // Merge discovered pools/tokens from arb-discovery JSON files (async I/O)
    let discovery_store = DiscoveryStore::new(std::path::Path::new("discovery"));
    let chain_lower = chain_name.to_lowercase();
    let toml_pool_addrs: HashSet<Address> = pool_configs.iter().map(|p| p.address).collect();

    if let Ok(pool_universe) = discovery_store.load_pools_async(&chain_lower).await {
        let mut merged = 0u32;
        for dp in &pool_universe.pools {
            let addr: Address = match dp.address.parse() {
                Ok(a) => a,
                Err(_) => continue,
            };
            if toml_pool_addrs.contains(&addr) {
                continue;
            }
            let t0: Address = match dp.token0.parse() {
                Ok(a) => a,
                Err(_) => continue,
            };
            let t1: Address = match dp.token1.parse() {
                Ok(a) => a,
                Err(_) => continue,
            };
            let protocol = crate::config::PoolEntry {
                name: format!("DISC_{}", dp.exchange_name.replace(' ', "_")),
                address: dp.address.clone(),
                protocol: dp.protocol.clone(),
                token0: dp.token0.clone(),
                token1: dp.token1.clone(),
                fee_bps: dp.fee_bps,
            }
            .parse_protocol();

            pool_configs.push(PoolConfig {
                address: addr,
                protocol,
                fee_bps: dp.fee_bps,
                token0: Some(t0),
                token1: Some(t1),
            });
            pool_infos.push(PoolInfo {
                address: addr,
                protocol,
                token0: t0,
                token1: t1,
            });
            merged += 1;
        }
        if merged > 0 {
            info!(merged, total = pool_infos.len(), "Merged discovered pools");
        }
    }

    // Token-order normalization: on every Uniswap-family pool (V2, V3,
    // Algebra, Slipstream) the contract sorts token0 < token1 by address.
    // A config that declares them flipped maps reserves onto the wrong
    // tokens and fabricates inverted prices — phantom arbs. Sort here so
    // a bad TOML/draft entry can't reach the graph.
    {
        let mut normalized = 0u32;
        for pi in pool_infos.iter_mut() {
            let uni_family = matches!(
                pi.protocol,
                Protocol::UniswapV2
                    | Protocol::UniswapV3
                    | Protocol::UniswapV4
                    | Protocol::Algebra
                    | Protocol::AerodromeV2
                    | Protocol::AerodromeSlipstream
            );
            if uni_family && pi.token0 > pi.token1 {
                warn!(
                    pool = %pi.address,
                    "pool token order flipped vs config — normalized to on-chain ordering"
                );
                std::mem::swap(&mut pi.token0, &mut pi.token1);
                normalized += 1;
            }
        }
        for pc in pool_configs.iter_mut() {
            if let (Some(t0), Some(t1)) = (pc.token0, pc.token1) {
                if t0 > t1 {
                    pc.token0 = Some(t1);
                    pc.token1 = Some(t0);
                }
            }
        }
        if normalized > 0 {
            warn!(normalized, "Pool token order normalized — fix the declared token0/token1 order in config");
        }
    }

    // GoPlus token-safety gate: drop pools whose tokens are flagged
    // (honeypot, sell-blocked, heavy transfer tax) BEFORE they enter the
    // execution graph. Fail-open on API outage — metadata must never
    // kill the scanner.
    {
        let mut all_tokens: HashSet<Address> = HashSet::new();
        for pc in &pool_configs {
            all_tokens.extend(pc.token0.iter().copied());
            all_tokens.extend(pc.token1.iter().copied());
        }
        let blocked = crate::token_safety::screen_tokens(cfg.chain.chain_id, &all_tokens).await;
        if !blocked.is_empty() {
            let before = pool_configs.len();
            pool_configs.retain(|pc| {
                !pc.token0.is_some_and(|t| blocked.contains(&t))
                    && !pc.token1.is_some_and(|t| blocked.contains(&t))
            });
            pool_infos.retain(|pi| {
                !blocked.contains(&pi.token0) && !blocked.contains(&pi.token1)
            });
            info!(
                dropped = before - pool_configs.len(),
                remaining = pool_configs.len(),
                "GoPlus safety gate dropped pools"
            );
        }
    }

    if let Ok(token_universe) = discovery_store.load_tokens_async(&chain_lower).await {
        let mut price_merged = 0u32;
        for dt in &token_universe.tokens {
            let addr: Address = match dt.address.parse() {
                Ok(a) => a,
                Err(_) => continue,
            };
            // Only set price if not already known from TOML
            if !token_usd_prices.contains_key(&addr) && dt.price_usd > 0.0 {
                token_usd_prices.insert(addr, dt.price_usd);
                price_merged += 1;
            }
            token_decimals.insert(addr, dt.decimals);
        }
        if price_merged > 0 {
            info!(price_merged, "Merged discovered token prices");
        }
    }

    let pool_fee_bps: HashMap<Address, u32> =
        pool_configs.iter().map(|c| (c.address, c.fee_bps)).collect();
    let store = Arc::new(PoolStore::new());
    let state_reader: Address = cfg.chain.state_reader.parse()?;
    let refresher = StateRefresher::new(endpoint.clone(), state_reader, pool_configs, cfg.chain.chain_id);
    let refresher = match cfg.chain.call_deadline_ms {
        Some(ms) => refresher.with_call_deadline(ms),
        None => refresher,
    };

    let (count, elapsed) = refresher.refresh(&store).await?;
    info!(pools = count, elapsed_ms = elapsed.as_millis(), "Initial state refresh complete");
    metrics::POOL_COUNT.set(count as f64);

    // Quarantine dead concentrated-liquidity pools BEFORE enumeration:
    // abandoned pools report liquidity>0 at a stale price, fabricating
    // phantom spreads vs healthy pools that revert InsufficientProfit on
    // chain. One batched QuoterV2 probe drops them from the graph.
    {
        let quarantined = probe_dead_v3_pools(
            &endpoint,
            &store,
            &pool_infos,
            &token_decimals,
            cfg.chain.chain_id,
        )
        .await;
        if !quarantined.is_empty() {
            pool_infos.retain(|pi| !quarantined.contains(&pi.address));
            warn!(
                dropped = quarantined.len(),
                remaining = pool_infos.len(),
                "Quarantined dead V3 pools (on-chain quoter probe)"
            );
        }
    }

    let pricing_refresh_blocks: u64 = 100;
    let derived = crate::pricing::derive_prices(&store, &mut token_usd_prices, &token_decimals);
    info!(derived, total_priced = token_usd_prices.len(), "Initial price derivation complete");

    let flash_tokens: Vec<Address> = cfg.scanner.flash_tokens.iter().map(|name| tokens[name]).collect();
    let flash_amounts: HashMap<Address, U256> = cfg.scanner.flash_amounts.iter()
        .map(|(name, &amount)| (tokens[name], U256::from(amount))).collect();
    let flash_bounds: HashMap<Address, (U256, U256)> = cfg.scanner.flash_bounds.iter()
        .filter_map(|(name, bounds)| tokens.get(name).map(|&addr| (addr, (U256::from(bounds.min), U256::from(bounds.max)))))
        .collect();

    // Index: unordered token pair -> configured pools on that pair (with fee for
    // V3-tier disambiguation). Locates the pool(s) a pending swap will move.
    let mut pair_to_pools: HashMap<(Address, Address), Vec<(Address, u32)>> = HashMap::new();
    for p in &pool_infos {
        let key = if p.token0 < p.token1 { (p.token0, p.token1) } else { (p.token1, p.token0) };
        let fee_bps = pool_fee_bps.get(&p.address).copied().unwrap_or(0);
        pair_to_pools.entry(key).or_default().push((p.address, fee_bps));
    }
    let pool_tokens: HashMap<Address, (Address, Address)> = pool_infos
        .iter()
        .map(|p| (p.address, (p.token0, p.token1)))
        .collect();
    let mut quarantined: std::collections::HashSet<Address> =
        std::collections::HashSet::new();

    let enumerator = PathEnumerator::new(pool_infos, flash_tokens, flash_amounts)
        .with_limits(spec::MAX_PATH_HOPS, 25_000, 200);   // spec: 3-hop depth cap
    let paths = enumerator.enumerate();
    info!(total_paths = paths.len(), max_hops = spec::MAX_PATH_HOPS, "Path enumeration complete");

    let presign_pool = PresignPool::new(&paths, cfg.chain.chain_id);

    // Build index: pool address -> vec of path indices that traverse that pool.
    // Used for fast backrun lookups when a pending swap is detected.
    let mut pool_to_paths: HashMap<Address, Vec<usize>> = HashMap::new();
    for (idx, path) in paths.iter().enumerate() {
        for hop in &path.hops {
            pool_to_paths.entry(hop.pool).or_default().push(idx);
        }
    }

    // ===== Submitters =====
    let mut submitters: Vec<Box<dyn Submitter>> = Vec::new();
    let chain_label: &'static str = Box::leak(cfg.chain.name.clone().into_boxed_str());

    // Leader Wallet Intelligence (Phase 0/1): observation only — registered
    // wallets' pending swaps are recorded to data/leaders/<chain>/*.jsonl.
    // Empty/disabled registry = no-op. Nothing is ever copied or submitted.
    let leader_observer = {
        let enabled = !cfg.leaders.wallets.is_empty() || cfg.leaders.discover;
        enabled.then(|| {
            let registry = arb_leaders::LeaderRegistry::new(&cfg.leaders);
            let obs = arb_leaders::LeaderObserver::new(
                registry,
                std::path::PathBuf::from("data/leaders"),
                cfg.chain.name.clone(),
                &cfg.leaders,
            );
            info!(chain = chain_label, wallets = obs.wallet_count(), discover = cfg.leaders.discover, "leader wallet intelligence enabled");
            obs
        })
    };

    // Opportunity bridge (Commander directive): sim-verified leader route
    // templates feed live evaluation. Only route geometry crosses — never
    // leader calldata/recipients/nonces. A template is READY when our own
    // simulator reproduced positive net through its route pools.
    let ready_templates: Vec<(String, std::collections::HashSet<Address>)> = {
        let dir = format!("data/leaders/{chain_label}");
        arb_core::opportunity::load_opportunities(&dir)
            .into_iter()
            .filter(|o| o.is_actionable()
                || o.execution_status == arb_core::opportunity::ExecutionStatus::Ready)
            .map(|o| (
                o.opportunity_id.clone(),
                o.route_pools.iter().filter_map(|p| p.parse::<Address>().ok())
                    .collect::<std::collections::HashSet<Address>>(),
            ))
            .filter(|(_, s)| !s.is_empty())
            .collect()
    };
    if !ready_templates.is_empty() {
        info!(chain = chain_label, templates = ready_templates.len(),
            "opportunity bridge armed — verified leader routes feed live evaluation");
    }

    if cfg.chain.chain_id == spec::BSC_CHAIN_ID {
        if let Some(url) = is_nonempty(&cfg.submission.puissant_url) {
            submitters.push(Box::new(PuissantSubmitter::new(url)));
            info!("48Club Puissant v2 configured");
        }
        if let Some(url) = is_nonempty(&cfg.submission.blockrazor_url) {
            submitters.push(Box::new(BlockRazorSubmitter::new(url)));
            info!("BlockRazor configured");
        }
        if let Some(url) = is_nonempty(&cfg.submission.jetbldr_url) {
            submitters.push(Box::new(JetBldrSubmitter::new(url)));
            info!("JetBldr configured");
        }
        if let Some(url) = is_nonempty(&cfg.submission.nodereal_url) {
            submitters.push(Box::new(NodeRealSubmitter::new(url)));
            info!("NodeReal configured");
        }
    }
    if let Some(url) = is_nonempty(&cfg.submission.blink_url) {
        submitters.push(Box::new(BlinkSubmitter::new(url, chain_label)));
        info!(chain = chain_label, "Blink configured");
    }
    if endpoint.has_trader_endpoint() {
        submitters.push(Box::new(WarpSubmitter::new(endpoint.clone())));
        info!("Warp/Trader configured (HighEvOnly)");
    }
    if cfg.submission.direct_fallback {
        submitters.push(Box::new(DirectSubmitter::new(endpoint.clone())));
        info!("Direct RPC fallback configured");
    }

    // ERC-4337 gasless venue (Pimlico). Kept as a separate handle too so
    // dry-run mode can assemble+sign UserOperations without broadcasting.
    let mut pimlico_venue: Option<PimlicoSubmitter> = None;
    if cfg.submission.pimlico_enabled {
        match is_nonempty(&cfg.submission.pimlico_bundler_url) {
            Some(url) => {
                match PimlicoConfig::from_parts(
                    url,
                    cfg.submission.entry_point.as_deref(),
                    cfg.submission.account_factory.as_deref(),
                    cfg.submission.smart_account_salt.unwrap_or(0),
                    cfg.submission.sponsor_policy_id_env.as_deref(),
                ) {
                    Ok(pim_cfg) => {
                        let sponsored = pim_cfg.sponsor_policy_id.is_some();
                        let venue = PimlicoSubmitter::new(
                            pim_cfg,
                            endpoint.clone(),
                            signer.clone(),
                            cfg.chain.chain_id,
                        );
                        let reachable = venue.paymaster_reachable().await;
                        if reachable {
                            info!(sponsored, "Pimlico ERC-4337 gasless venue configured — paymaster reachable");
                        } else {
                            warn!("Pimlico paymaster UNREACHABLE at boot — sponsorship will fail; ops rejected, no fallback");
                        }
                        if !sponsored {
                            info!("No sponsor policy — ops sponsored within Pimlico account balance (set ALLBRIGHTA_SPONSOR_POLICY_ID for limits)");
                        }
                        pimlico_venue = Some(venue.clone());
                        submitters.push(Box::new(venue));
                    }
                    Err(e) => warn!(error = %e, "Pimlico venue misconfigured — disabled"),
                }
            }
            None => warn!("pimlico_enabled=true but pimlico_bundler_url is empty — disabled"),
        }
    }

    // Spec Account Abstraction Rule: strict mode drops every legacy venue so
    // all execution routes through the ERC-4337 UserOperation assembler.
    if cfg.submission.strict_4337 {
        if let Some(venue) = pimlico_venue.clone() {
            submitters.clear();
            submitters.push(Box::new(venue));
            warn!("strict_4337: legacy venues disabled — all execution via ERC-4337 UserOperations");
        } else {
            warn!("strict_4337 set but Pimlico venue unavailable — keeping legacy venues");
        }
    }

    let always_on = submitters.iter().filter(|s| s.tier() == SubmitTier::AlwaysOn).count();
    let high_ev = submitters.iter().filter(|s| s.tier() == SubmitTier::HighEvOnly).count();
    info!(always_on, high_ev, total = submitters.len(), "Submission layer initialized");

    // Submission routing switch: per-chain submit RTT budget + slot cutoff,
    // venue ordering by measured health, 60s bench on repeated misses.
    let (submit_budget_ms, slot_budget_ms) = if cfg.chain.chain_id == spec::BASE_CHAIN_ID {
        (spec::BASE_SUBMIT_TIMEOUT_MS, spec::BASE_SLOT_BUDGET_MS)
    } else if cfg.chain.chain_id == spec::BSC_CHAIN_ID {
        (spec::BSC_MEV_SUBMIT_TIMEOUT_MS, spec::BSC_SLOT_BUDGET_MS)
    } else {
        // Generic chains: scale budgets off the configured block cadence.
        let bt = cfg.chain.block_time_ms.max(500);
        ((bt / 6).clamp(50, 250), bt * 4 / 5)
    };
    let router = arb_submit::router::VenueRouter::new(submitters, submit_budget_ms, slot_budget_ms);
    info!(submit_budget_ms, slot_budget_ms, "Venue routing switch armed");

    let mut profit_gate = if smoke_test {
        ProfitGate::new(0, 0.0, 0, 0, token_usd_prices.clone(), token_decimals.clone())
    } else {
        ProfitGate::new(
            cfg.scanner.min_profit_bps, crate::config::min_profit_usd_floor(cfg.gate.min_profit_usd),
            cfg.gate.safety_margin_bps, cfg.gate.stable_pool_extra_margin_bps,
            token_usd_prices.clone(), token_decimals.clone(),
        )
    };
    info!(min_bps = cfg.scanner.min_profit_bps, min_usd = crate::config::min_profit_usd_floor(cfg.gate.min_profit_usd), "Profit gate initialized");

    let warp_threshold_usd = cfg.submission.warp_threshold_usd;
    let warp_budget_usd = cfg.submission.warp_budget_usd;
    let mut warp_spent_this_session: f64 = 0.0;
    // Deterministic bundler-sim reverts (e.g. executor Unauthorized) cannot
    // self-heal — after a streak, suppress all submissions until restart
    // instead of burning sponsor calls.
    let mut exec_revert_streak: u32 = 0;
    let mut executor_broken = false;
    // Cached once: the smart account is the executor's only authorized
    // caller — used for pre-submission execution probes.
    let mut smart_account: Option<Address> = None;
    info!(
        threshold_usd = warp_threshold_usd,
        budget_usd = warp_budget_usd,
        "Warp spending limits loaded"
    );
    let min_initial_bps = if smoke_test { 0 } else { cfg.scanner.min_initial_bps };
    let optimization_iterations = cfg.scanner.optimization_iterations;
    let wallet_addr = signer.address();
    let dry_run_override = if smoke_test { false } else { cfg.scanner.dry_run };

    let (mempool_tx, mut mempool_rx) = mpsc::channel(1000);
    let mut wss_urls = cfg.chain.rpc_wss_pool.clone();
    wss_urls.retain(|u| !u.trim().is_empty());
    if wss_urls.is_empty() {
        wss_urls.push(cfg.chain.rpc_wss.clone());
    }
    let mempool_chain_id = cfg.chain.chain_id;
    info!(providers = wss_urls.len(), "Mempool WSS provider pool");
    tokio::spawn(async move {
        let watcher = MempoolWatcher::new(&wss_urls, mempool_chain_id);
        if let Err(e) = watcher.start(mempool_tx).await {
            error!(error = %e, "Mempool watcher failed");
        }
    });

    info!("Subscribing to new block headers");
    let ws = WsConnect::new(&cfg.chain.rpc_wss);
    let ws_provider = ProviderBuilder::new().connect_ws(ws).await?;
    let sub = ws_provider.subscribe_blocks().await?;
    let mut block_stream = sub.into_stream();

    let arb_contract: Address = cfg.chain.arb_contract.parse().unwrap_or_else(|_| {
        warn!(chain = %cfg.chain.name, "arb_contract unset/invalid — executor calls will revert; scan-only mode");
        Address::ZERO
    });
    let dry_run = dry_run_override;

    info!(chain = %cfg.chain.name, contract = %arb_contract, pools = store.pool_count(),
        paths = paths.len(), dry_run, "Scanner loop starting");

    let mut circuit_breaker = PathCircuitBreaker::new();
    let mut token_breaker = TokenCircuitBreaker::new(5, 200);
    token_breaker.set_popular_intermediaries(tokens.values().copied());
    let blacklist_path = std::path::Path::new("discovery")
        .join(format!("blacklist.{}.json", chain_name.to_lowercase()));
    token_breaker.load_blacklist(&blacklist_path);
    let (cb_tx, mut cb_rx) = mpsc::channel::<(u32, TxOutcome, u64)>(256);

    // Per-minute summary tracking
    let mut last_summary = Instant::now();
    let mut last_scans: f64 = 0.0;
    let mut last_submitted: f64 = 0.0;
    let mut last_status_write = Instant::now();
    let mut last_pricing_block: u64 = 0;

    // Background balance task (Phase 7f: move RPC out of hot scan loop)
    let balance_addr = wallet_addr;
    let balance_ep = endpoint.clone();
    let (balance_tx, balance_rx) = tokio::sync::watch::channel("unknown".to_string());
    tokio::spawn(async move {
        loop {
            match balance_ep.get_balance(balance_addr).await {
                Ok(b) => { let _ = balance_tx.send(format!("{b}")); }
                Err(_) => { let _ = balance_tx.send("unknown".to_string()); }
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });

    while let Some(block) = block_stream.next().await {
        let block_number = block.inner.number;
        let scan_start = Instant::now();
        metrics::CURRENT_BLOCK.set(block_number as f64);

        // Drain async tx outcome feedback into circuit breaker
        while let Ok((path_id, outcome, blk)) = cb_rx.try_recv() {
            match outcome {
                TxOutcome::Success => circuit_breaker.record_success(path_id),
                TxOutcome::Revert => circuit_breaker.record_revert(path_id, blk),
                TxOutcome::Dropped => {}
            }
        }

        match refresher.refresh(&store).await {
            Ok((count, elapsed)) => {
                metrics::STATE_REFRESH_LATENCY.observe(elapsed.as_secs_f64());
                debug!(block = block_number, pools = count, refresh_ms = elapsed.as_millis(), "State refreshed");
                // Quarantine pools whose implied price diverges >3x from
                // same-pair peers — broken/exhausted state fabricates
                // phantom arb legs on otherwise-real pending swaps.
                quarantined = arb_mempool::impact::quarantine_outlier_pools(
                    &store, &pair_to_pools, &pool_tokens, 3.0);
            }
            Err(e) => {
                warn!(block = block_number, error = %e, "State refresh failed");
            }
        }

        if block_number >= last_pricing_block + pricing_refresh_blocks {
            let derived = crate::pricing::derive_prices(&store, &mut token_usd_prices, &token_decimals);
            if derived > 0 {
                profit_gate.token_usd_prices = token_usd_prices.clone();
                debug!(derived, block = block_number, "Periodic price derivation");
            }
            last_pricing_block = block_number;
        }

        // === Two-pass evaluate-then-optimize ===
        let initial_results = evaluate_all(&paths, &store);
        let pass1_count = initial_results.len();
        metrics::PATHS_EVALUATED.inc_by(paths.len() as f64);

        // Stale-state filter: pools whose refresh keeps failing (timeouts,
        // RPC blacklists) hold old ticks that fabricate spreads — paths
        // through them are phantom candidates that the exec probe then has
        // to reject on-chain. Skip them before optimization.
        let stale_filtered = initial_results.into_iter()
            .filter(|r| r.profit_bps >= min_initial_bps)
            .filter(|r| !circuit_breaker.is_suppressed(r.path_id, block_number))
            .filter(|r| !token_breaker.is_path_token_suppressed(&paths[r.path_id as usize], block_number))
            .collect::<Vec<_>>();
        let (stale_hit, candidates): (Vec<_>, Vec<_>) = stale_filtered
            .into_iter()
            .partition(|r| {
                paths[r.path_id as usize]
                    .hops
                    .iter()
                    .any(|h| store.is_stale(&h.pool, STALE_STATE_MAX_AGE_MS))
            });
        if !stale_hit.is_empty() {
            metrics::STALE_SUPPRESSED.inc_by(stale_hit.len() as f64);
            debug!(skipped = stale_hit.len(), "candidate paths skipped — stale pool state");
        }

        if !candidates.is_empty() {
            metrics::PROFITABLE_FOUND.inc_by(candidates.len() as f64);
            for c in &candidates {
                let sym = token_syms
                    .get(&paths[c.path_id as usize].flash_token)
                    .map(String::as_str)
                    .unwrap_or("?");
                metrics::PROFITABLE_BY_TOKEN.with_label_values(&[sym]).inc();
            }

            let mut best_result = None;
            let mut best_path_idx = 0usize;
            let mut optimized_count = 0u32;

            for candidate in &candidates {
                let path = &paths[candidate.path_id as usize];
                let (min_amt, token_max) = flash_bounds.get(&path.flash_token).copied()
                    .unwrap_or((path.flash_amount, path.flash_amount * U256::from(10u32)));
                let liquidity_max = path_max_flash(path, &store, 0.05, token_max);
                let max_amt = token_max.min(liquidity_max);

                // Try ternary optimization; fall back to the default amount if optimization fails
                let (final_amount, final_profit) =
                    if let Some((opt_amount, opt_profit)) =
                        find_optimal_amount(path, &store, min_amt, max_amt, optimization_iterations)
                    {
                        (opt_amount, opt_profit)
                    } else if candidate.gross_profit > U256::ZERO {
                        // Optimization found nothing, but cheap-pass DID find profit at default amount
                        metrics::GATE_REJECTS.with_label_values(&["optimizer_none"]).inc();
                        (candidate.flash_amount, candidate.gross_profit)
                    } else {
                        metrics::GATE_REJECTS.with_label_values(&["no_profit_default"]).inc();
                        continue;
                    };

                optimized_count += 1;
                let profit_bps: u32 = if !final_amount.is_zero() {
                    ((final_profit * U256::from(10000u32)) / final_amount).try_into().unwrap_or(u32::MAX)
                } else { 0 };

                let opt_result = arb_sim::SimResult {
                    path_id: candidate.path_id, flash_token: path.flash_token,
                    flash_amount: final_amount, final_amount: final_amount + final_profit,
                    gross_profit: final_profit, profit_bps,
                };

                let decision = profit_gate.should_submit(&opt_result, path);
                metrics::GATE_EFFECTIVE_USD.observe(decision.effective_profit_usd);
                if let Some(reason) = decision.reject_reason {
                    metrics::GATE_REJECTS.with_label_values(&[reason]).inc();
                }
                if decision.accept {
                    metrics::GROSS_PROFIT_USD.inc_by(decision.effective_profit_usd);
                    metrics::NET_PROFIT_USD.inc_by(decision.effective_profit_usd);
                    let sym = token_syms
                        .get(&path.flash_token)
                        .map(String::as_str)
                        .unwrap_or("?");
                    metrics::TOKEN_PROFIT_USD.with_label_values(&[sym]).inc_by(decision.effective_profit_usd);
                    if best_result.as_ref().map_or(true, |(_, d): &(arb_sim::SimResult, f64)| decision.effective_profit_usd > *d) {
                        best_path_idx = candidate.path_id as usize;
                        best_result = Some((opt_result, decision.effective_profit_usd));
                    }
                }
            }

            if let Some((best, effective_usd)) = best_result {
                let hop_pools: Vec<String> = paths[best_path_idx]
                    .hops
                    .iter()
                    .map(|h| format!("{}", h.pool))
                    .collect();
                info!(block = block_number, path_id = best.path_id, profit_bps = best.profit_bps,
                    gross_profit = %best.gross_profit, flash_amount = %best.flash_amount,
                    effective_usd = format!("{:.4}", effective_usd), pass1 = pass1_count,
                    candidates = candidates.len(), optimized = optimized_count,
                    hops = ?hop_pools, "Optimized path");

                if !dry_run && executor_broken {
                    // Skip — the executor reverts in simulation; nothing lands.
                } else if !dry_run {
                    let optimized_path = &paths[best_path_idx];

                    let target_block = block_number + 3;
                    let submit_signer = &signers[signer_rot
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                        % signers.len()];
                    match presign_pool.build_fast(
                        best.path_id, best.flash_amount, &endpoint, arb_contract, submit_signer, target_block,
                    ).await {
                        Ok(bundle) => {
                            // On-chain exec probe: simulate the exact
                            // executor call as the smart account before
                            // spending a sponsor call. Sim-vs-chain
                            // divergence (dead pools, tick-range
                            // exhaustion, protocol mismatches) reverts
                            // here instead of at the bundler — count it as
                            // a revert so the breaker suppresses the path.
                            if let Some(venue) = &pimlico_venue {
                                if smart_account.is_none() {
                                    smart_account = venue.account().await.ok();
                                    if let Some(a) = smart_account {
                                        info!(account = %a, "Smart account resolved for exec probes");
                                    }
                                }
                                if let (Some(account), Some(call)) =
                                    (smart_account, bundle.call.as_ref())
                                {
                                    // The tx sender depends on venue mix:
                                    // EOA-signed builder bundles are sent
                                    // FROM submit_signer (onlyOwner on the
                                    // executor contract), UserOps execute
                                    // as the smart account. Probe the
                                    // identity that will actually send —
                                    // probing the wrong sender always
                                    // reverts onlyOwner and suppresses
                                    // every candidate.
                                    let probe_from = if cfg.submission.strict_4337 {
                                        account
                                    } else {
                                        submit_signer.address()
                                    };
                                    let probe = alloy::rpc::types::TransactionRequest::default()
                                        .from(probe_from)
                                        .to(call.to)
                                        .input(call.data.clone().into());
                                    match endpoint.provider().call(probe).await {
                                        Ok(_) => {}
                                        Err(e) => {
                                            // ErrorPayload = the chain
                                            // executed the call and it
                                            // reverted — deterministic for
                                            // this state, count as a revert.
                                            // Transport failures (429,
                                            // timeout) prove nothing — skip
                                            // the submission but don't
                                            // penalize the path.
                                            if e.as_error_resp().is_some() {
                                                let reason = classify_exec_probe_revert(
                                                    &format!("{e:?}")
                                                );
                                                warn!(
                                                    path_id = best.path_id,
                                                    reason,
                                                    error = %e,
                                                    "exec probe reverted — path suppressed, no submission"
                                                );
                                                circuit_breaker.record_revert(
                                                    best.path_id,
                                                    block_number,
                                                );
                                            } else {
                                                warn!(
                                                    path_id = best.path_id,
                                                    error = %e,
                                                    "exec probe transport error — submission skipped"
                                                );
                                            }
                                            continue;
                                        }
                                    }
                                }
                            }
                            endpoint.bump_nonce();
                            circuit_breaker.record_submit(best.path_id);
                            let budget_ok = warp_spent_this_session < warp_budget_usd;
                            let use_high_ev = budget_ok && effective_usd >= warp_threshold_usd;
                            if !budget_ok {
                                error!(
                                    spent = format!("{:.2}", warp_spent_this_session),
                                    budget = warp_budget_usd,
                                    "WARP BUDGET EXCEEDED — shutting down to prevent further charges"
                                );
                                return Err(anyhow::anyhow!(
                                    "Warp session budget of ${:.2} exceeded (spent ${:.2}). \
                                     Restart the bot to reset. Increase [submission].warp_budget_usd if intentional.",
                                    warp_budget_usd, warp_spent_this_session
                                ));
                            }
                            let sub_results = router
                                .submit_all(&bundle, use_high_ev, scan_start.elapsed())
                                .await;
                            for r in &sub_results {
                                metrics::SUBMIT_ATTEMPTS.inc();
                                metrics::SUBMIT_BY_VENUE.with_label_values(
                                    &[r.venue, if r.tier == SubmitTier::AlwaysOn { "free" } else { "paid" }]
                                ).inc();
                                if r.tier == SubmitTier::HighEvOnly {
                                    metrics::WARP_SPEND_USD.inc_by(0.15);
                                }
                            }
                            let mut any_hash = None;
                            let mut builder_sim_rejected = false;
                            for arb_submit::router::RoutedSubmit { venue, tier, result, .. } in sub_results {
                                match result {
                                    Ok(r) if r.success => {
                                        info!(venue, tier = ?tier, hash = ?r.bundle_hash, "Submitted");
                                        if any_hash.is_none() {
                                            if let Some(h) = &r.bundle_hash {
                                                any_hash = h.parse::<B256>().ok();
                                            }
                                        }
                                    }
                                    Ok(r) => {
                                        let err_str = r.error.as_deref().unwrap_or("");
                                        let is_sim_reject = err_str.contains("non-reverting tx in bundle failed")
                                            || err_str.contains("bundle execution failed")
                                            || err_str.contains("transaction execution failed");
                                        if is_sim_reject {
                                            builder_sim_rejected = true;
                                            metrics::BUILDER_SIM_REJECT.inc();
                                        }
                                        debug!(venue, error = ?r.error, "Rejected");
                                    }
                                    Err(e) => {
                                        if let Some(reason) =
                                            arb_submit::pimlico::sponsorship_reject_reason(&e)
                                        {
                                            metrics::SPONSORSHIP_REJECTS
                                                .with_label_values(&[reason])
                                                .inc();
                                            warn!(venue, reason, error = %e,
                                                "Sponsorship blocked — op rejected, no funded-wallet fallback");
                                            if reason == "exec_revert" {
                                                exec_revert_streak += 1;
                                                if exec_revert_streak == 1 {
                                                    let hops: Vec<String> = optimized_path
                                                        .hops
                                                        .iter()
                                                        .map(|h| format!(
                                                            "{:?} {} {}->{}",
                                                            h.protocol, h.pool, h.token_in, h.token_out
                                                        ))
                                                        .collect();
                                                    warn!(
                                                        path_id = best.path_id,
                                                        flash_token = %best.flash_token,
                                                        flash_amount = %best.flash_amount,
                                                        sim_profit = %best.gross_profit,
                                                        ?hops,
                                                        "exec_revert path detail — reproduce with cast"
                                                    );
                                                }
                                                if exec_revert_streak >= 3 && !executor_broken {
                                                    executor_broken = true;
                                                    error!(
                                                        "Executor reverts deterministically in bundler simulation \
                                                         — submissions suppressed until restart"
                                                    );
                                                }
                                            }
                                        } else {
                                            warn!(venue, error = %e, "Error");
                                        }
                                    }
                                }
                            }

                            if builder_sim_rejected {
                                circuit_breaker.record_revert(best.path_id, block_number);
                            }

                            // Keep the session Warp spend in sync with the metric
                            if use_high_ev {
                                warp_spent_this_session += 0.15;
                                if warp_spent_this_session >= warp_budget_usd * 0.8 {
                                    warn!(
                                        spent = format!("{:.2}", warp_spent_this_session),
                                        budget = warp_budget_usd,
                                        "Warp spend at 80% of session budget"
                                    );
                                }
                            }

                            // Track receipt — sync in smoke test, async otherwise
                            if let Some(hash) = any_hash {
                                if smoke_test {
                                    info!("Waiting for receipt...");
                                    let outcome = track_tx(endpoint.clone(), hash, 10).await;
                                    match outcome {
                                        TxOutcome::Success => circuit_breaker.record_success(best.path_id),
                                        TxOutcome::Revert => circuit_breaker.record_revert(best.path_id, block_number),
                                        TxOutcome::Dropped => {}
                                    }
                                    let landed_ok = metrics::SUBMIT_LANDED.with_label_values(&["success"]).get() as u64;
                                    let landed_revert = metrics::SUBMIT_LANDED.with_label_values(&["revert"]).get() as u64;
                                    let status = if landed_ok > 0 { "SUCCESS" } else if landed_revert > 0 { "REVERT" } else { "DROPPED" };
                                    println!("\n===== PIPELINE TEST RESULT =====");
                                    println!("chain:            {}", cfg.chain.name);
                                    println!("path_id:          {}", best.path_id);
                                    println!("hops:");
                                    for (i, hop) in optimized_path.hops.iter().enumerate() {
                                        println!("  {}. {:?}  {:.8}..  {} -> {}", i + 1,
                                            hop.protocol, hop.pool, hop.token_in, hop.token_out);
                                    }
                                    println!("flash_amount:     {} ({} token units)", best.flash_amount, best.flash_token);
                                    println!("sim_profit:       {}", best.gross_profit);
                                    println!("sim_profit_bps:   {}", best.profit_bps);
                                    println!("effective_usd:    ${:.4}", effective_usd);
                                    println!("tx_hash:          {hash}");
                                    println!("on_chain_status:  {status}");
                                    println!("gas_spent_wei:    {:.0}", metrics::GAS_SPENT_WEI.get());
                                    println!("=================================\n");
                                    return Ok(());
                                } else {
                                    let ep = endpoint.clone();
                                    let cb_sender = cb_tx.clone();
                                    let pid = best.path_id;
                                    let blk = block_number;
                                    tokio::spawn(async move {
                                        let outcome = track_tx(ep, hash, 5).await;
                                        let _ = cb_sender.send((pid, outcome, blk)).await;
                                    });
                                }
                            }
                        }
                        Err(e) => error!(error = %e, "Failed to build bundle"),
                    }
                } else {
                    info!(path_id = best.path_id, effective_usd = format!("{:.4}", effective_usd),
                        flash_amount = %best.flash_amount, "DRY RUN: would submit");

                    // Exercise the full ERC-4337 assembly path without broadcasting:
                    // build the bundle, wrap the call in a UserOperation, sponsor it
                    // if a policy is set, sign it, and log the wire JSON.
                    if let Some(pimlico) = &pimlico_venue {
                        let target_block = block_number + 3;
                        let submit_signer = &signers[signer_rot
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                            % signers.len()];
                        match presign_pool
                            .build_fast(best.path_id, best.flash_amount, &endpoint,
                                arb_contract, submit_signer, target_block)
                            .await
                        {
                            Ok(bundle) => match pimlico.preview(&bundle).await {
                                Ok(op_json) => info!(
                                    userop = %serde_json::to_string(&op_json).unwrap_or_default(),
                                    "DRY RUN: ERC-4337 UserOperation assembled (not broadcast)"
                                ),
                                Err(e) => warn!(error = %e, "DRY RUN: 4337 assembly failed"),
                            },
                            Err(e) => warn!(error = %e, "DRY RUN: bundle build failed"),
                        }
                    }
                }
            }
        }

        // Process pending mempool swaps for backrun opportunities
        while let Ok(pending) = mempool_rx.try_recv() {
            if let Some(obs) = &leader_observer {
                obs.observe(&pending);
            }
            // Direct pool calls carry no input amount in calldata (it's
            // recovered inside projection); router decodes need one.
            let amount_in = match pending.decoded.amount_in {
                Some(a) => a,
                None if pending.decoded.direct.is_some() => U256::ZERO,
                None => continue,
            };

            // Project every hop of the pending swap's path onto the tracked
            // pools it touches: the resting state has no spread — the pending
            // swap creates one. Later hops of a multi-hop victim move our
            // pools too, not just the first.
            let Some((projected, hit_pools, victim_usd)) =
                arb_mempool::impact::project_pending_path(
                    &store, &pending.decoded, amount_in, &pair_to_pools,
                    &token_usd_prices, &token_decimals,
                )
            else { continue };

            let mut candidate_ids: Vec<usize> = Vec::new();
            for pool_addr in &hit_pools {
                if quarantined.contains(pool_addr) { continue; }
                if let Some(ids) = pool_to_paths.get(pool_addr) {
                    candidate_ids.extend_from_slice(ids);
                }
            }
            if candidate_ids.is_empty() { continue; }
            candidate_ids.sort_unstable();
            candidate_ids.dedup();
            candidate_ids
                .retain(|&i| !paths[i].hops.iter().any(|h| quarantined.contains(&h.pool)));
            let stale_n = candidate_ids.len();
            candidate_ids
                .retain(|&i| !paths[i].hops.iter().any(|h| store.is_stale(&h.pool, STALE_STATE_MAX_AGE_MS)));
            let dropped_stale = stale_n - candidate_ids.len();
            if dropped_stale > 0 {
                metrics::STALE_SUPPRESSED.inc_by(dropped_stale as f64);
                debug!(skipped = dropped_stale, "backrun candidates skipped — stale pool state");
            }
            if candidate_ids.is_empty() { continue; }
            metrics::BACKRUN_CANDIDATES.inc();
            // Phase-1 latency budget: how long from seeing the victim to
            // starting candidate evaluation — this is the race window.
            metrics::PENDING_TO_EVAL.observe(pending.seen_at.elapsed().as_secs_f64());

            {
                // Rank candidates by cheap single-point profit so the 20
                // full optimizations go to the most promising routes,
                // not the first 20 by path index.
                let mut screened: Vec<(usize, U256)> = candidate_ids
                    .iter()
                    .map(|&i| {
                        let p = &paths[i];
                        let min_a = flash_bounds
                            .get(&p.flash_token)
                            .map(|b| b.0)
                            .unwrap_or(p.flash_amount);
                        let hi_probe = (min_a * U256::from(10u32))
                            .min(flash_bounds.get(&p.flash_token).map(|b| b.1)
                                .unwrap_or(p.flash_amount * U256::from(10u32)));
                        let s = arb_sim::optimize::simulate_profit(p, min_a, &projected)
                            .max(arb_sim::optimize::simulate_profit(p, hi_probe, &projected));
                        (i, s)
                    })
                    .collect();
                screened.sort_by(|a, b| b.1.cmp(&a.1));

                // Opportunity bridge: a pending victim touching a sim-verified
                // leader route template gets template-overlapping paths
                // evaluated first — the leader's proven geometry takes the
                // limited optimization slots over generic enumeration.
                let matched: Vec<&(String, std::collections::HashSet<Address>)> =
                    ready_templates.iter()
                        .filter(|(_, pools)| hit_pools.iter().any(|p| pools.contains(p)))
                        .collect();
                if !matched.is_empty() {
                    arb_leaders::OPPORTUNITY_TOTAL
                        .with_label_values(&[chain_label, "matched_live"])
                        .inc();
                    // Template overlap first, sim-probe score breaks ties.
                    screened.sort_by(|a, b| {
                        let ov = |i: usize| paths[i].hops.iter()
                            .filter(|h| matched.iter().any(|(_, p)| p.contains(&h.pool)))
                            .count();
                        ov(b.0).cmp(&ov(a.0)).then(b.1.cmp(&a.1))
                    });
                    debug!(
                        victim = %pending.tx_hash,
                        templates = matched.len(),
                        "OPPORTUNITY_MATCH victim touches verified leader route"
                    );
                }
                for &(pidx, _) in screened.iter().take(20) {
                    let path = &paths[pidx];
                    if circuit_breaker.is_suppressed(path.id, block_number) { continue; }

                    // Evaluate against the projected post-swap state — that is
                    // the state our tx would see if it lands right after the
                    // pending swap in the same block.
                    let profit = arb_sim::optimize::find_optimal_amount(
                        path, &projected,
                        flash_bounds.get(&path.flash_token).map(|b| b.0).unwrap_or(path.flash_amount),
                        {
                            let token_max = flash_bounds.get(&path.flash_token).map(|b| b.1)
                                .unwrap_or(path.flash_amount * U256::from(10u32));
                            let liq_max = arb_sim::optimize::path_max_flash(path, &projected, 0.05, token_max);
                            token_max.min(liq_max)
                        },
                        optimization_iterations,
                    );

                    if let Some((opt_amount, opt_profit)) = profit {
                        let profit_bps: u32 = if !opt_amount.is_zero() {
                            ((opt_profit * U256::from(10000u32)) / opt_amount).try_into().unwrap_or(u32::MAX)
                        } else { 0 };

                        let sim = arb_sim::SimResult {
                            path_id: path.id,
                            flash_token: path.flash_token,
                            flash_amount: opt_amount,
                            final_amount: opt_amount + opt_profit,
                            gross_profit: opt_profit,
                            profit_bps,
                        };

                        let decision = profit_gate.should_submit(&sim, path);
                        // A backrun extracts value from the dislocation the
                        // victim creates — it cannot exceed the victim's own
                        // input value. Larger "profits" mean the projection
                        // model overshot (e.g., a same-tick V3 estimate or an
                        // ambiguous same-pair match).
                        if decision.accept {
                            if victim_usd.map_or(false, |v| v > 1e8) {
                                debug!(victim_usd, "Backrun dropped: implausible decoded victim size");
                                continue;
                            }
                            if let Some(vusd) = victim_usd {
                                if decision.effective_profit_usd > vusd {
                                    debug!(
                                        path_id = path.id,
                                        profit_usd = decision.effective_profit_usd,
                                        victim_usd = vusd,
                                        "Backrun candidate dropped: profit exceeds victim size"
                                    );
                                    continue;
                                }
                            }
                        }
                        if decision.accept && !dry_run {
                            // The projected state is approximate — before
                            // spending a submission, re-read the pools the
                            // pending tx touches, re-project, and re-verify
                            // the edge is still there.
                            if refresher.refresh(&store).await.is_ok() {
                                let verified = arb_mempool::impact::project_pending_path(
                                    &store, &pending.decoded, amount_in, &pair_to_pools,
                                    &token_usd_prices, &token_decimals,
                                ).and_then(|(reprojected, _, _)| {
                                    arb_sim::optimize::find_optimal_amount(
                                        path, &reprojected,
                                        flash_bounds.get(&path.flash_token).map(|b| b.0)
                                            .unwrap_or(path.flash_amount),
                                        {
                                            let token_max = flash_bounds.get(&path.flash_token)
                                                .map(|b| b.1)
                                                .unwrap_or(path.flash_amount * U256::from(10u32));
                                            let liq_max = arb_sim::optimize::path_max_flash(
                                                path, &reprojected, 0.05, token_max);
                                            token_max.min(liq_max)
                                        },
                                        optimization_iterations,
                                    )
                                });
                                match verified {
                                    Some((_, reprofit)) if !reprofit.is_zero() => {}
                                    _ => {
                                        debug!(path_id = path.id, "Backrun edge gone on re-check");
                                        continue;
                                    }
                                }
                            }

                            info!(
                                path_id = path.id, profit_bps,
                                pending_router = pending.decoded.router,
                                pending_tx = %pending.tx_hash,
                                victim_age_ms = pending.seen_at.elapsed().as_millis() as u64,
                                "Backrun candidate found"
                            );
                            metrics::BACKRUN_SUBMITTED.inc();

                            // Build a true [victim, ours] ordered bundle: the
                            // watcher streams full pending txs, so the victim's
                            // signed bytes are available — bundle venues prepend
                            // them and our tx lands immediately after the victim.
                            let target_block = block_number + 1;
                            let submit_signer = &signers[signer_rot
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                                % signers.len()];
                            if let Ok(mut bundle) = presign_pool.build_fast(
                                path.id, opt_amount, &endpoint, arb_contract, submit_signer, target_block,
                            ).await {
                                if !pending.raw_tx.is_empty() {
                                    bundle.victim_tx = Some(pending.raw_tx.clone());
                                    bundle.backrun_tx = Some(pending.tx_hash);
                                }
                                endpoint.bump_nonce();
                                if !matched.is_empty() {
                                    // A verified leader route matched this
                                    // victim and survived gate+probe to a
                                    // real submission — count the capture.
                                    arb_leaders::OPPORTUNITY_TOTAL
                                        .with_label_values(&[chain_label, "submitted"])
                                        .inc();
                                }
                                let sub_results = router
                                    .submit_all(&bundle, false, scan_start.elapsed())
                                    .await;
                                metrics::PENDING_TO_SUBMIT
                                    .observe(pending.seen_at.elapsed().as_secs_f64());
                                if sub_results.is_empty() && bundle.victim_tx.is_some() {
                                    metrics::BACKRUN_NO_VENUE.inc();
                                    warn!(
                                        "Backrun bundle dropped: no bundle-capable venue \
                                         (strict_4337 leaves only the UserOp bundler, which \
                                         cannot order after a victim tx)"
                                    );
                                }
                                for r in sub_results {
                                    match r.result {
                                        Ok(res) if res.success => debug!(venue = r.venue, "Backrun submitted"),
                                        Ok(res) => debug!(venue = r.venue, error = ?res.error, "Backrun rejected"),
                                        Err(e) => debug!(venue = r.venue, error = %e, "Backrun error"),
                                    }
                                }
                            }
                            break;
                        }
                    }
                }
            }
        }

        let scan_elapsed = scan_start.elapsed();
        metrics::SCAN_LATENCY.observe(scan_elapsed.as_secs_f64());
        let budget_ms = cfg.chain.scan_budget_ms;
        if scan_elapsed.as_millis() as u64 > budget_ms {
            warn!(block = block_number, elapsed_ms = scan_elapsed.as_millis(), budget_ms, "Exceeded budget");
        }

        // Per-minute summary
        if last_summary.elapsed() >= Duration::from_secs(60) {
            let scans_now = metrics::PATHS_EVALUATED.get();
            let submitted_now = metrics::SUBMIT_ATTEMPTS.get();
            let landed_ok = metrics::SUBMIT_LANDED.with_label_values(&["success"]).get() as u64;
            let landed_revert = metrics::SUBMIT_LANDED.with_label_values(&["revert"]).get() as u64;
            let dropped = metrics::SUBMIT_LANDED.with_label_values(&["dropped"]).get() as u64;

            info!(
                block = block_number,
                scans_delta = (scans_now - last_scans) as u64,
                submitted_delta = (submitted_now - last_submitted) as u64,
                landed_ok, landed_revert, dropped,
                paths_suppressed = circuit_breaker.suppressed_count(block_number),
                builder_sim_rejects = metrics::BUILDER_SIM_REJECT.get() as u64,
                warp_usd = format!("{:.2}", metrics::WARP_SPEND_USD.get()),
                "[minute summary]"
            );

            last_scans = scans_now;
            last_submitted = submitted_now;
            last_summary = Instant::now();
        }

        // Status JSON every 5 seconds
        if last_status_write.elapsed() >= Duration::from_secs(5) {
            let balance_str = balance_rx.borrow().clone();
            write_status_json(&chain_name, &started, block_number, &balance_str, &circuit_breaker);
            last_status_write = Instant::now();
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use arb_paths::HopTemplate;

    fn addr(b: u8) -> Address {
        Address::with_last_byte(b)
    }

    fn make_path(id: u32, flash: Address, hops: Vec<(Address, Address, Address)>) -> PathTemplate {
        PathTemplate {
            id,
            flash_token: flash,
            flash_amount: U256::from(1000u32),
            hops: hops.into_iter().map(|(pool, tin, tout)| HopTemplate {
                protocol: arb_core::types::Protocol::UniswapV2,
                pool, token_in: tin, token_out: tout,
            }).collect(),
        }
    }

    #[test]
    fn test_token_breaker_skips_flash_token() {
        let flash = addr(1);
        let intermediate = addr(2);
        let target = addr(3);
        let path = make_path(0, flash, vec![
            (addr(10), flash, intermediate),
            (addr(11), intermediate, target),
            (addr(12), target, flash),
        ]);

        let mut breaker = TokenCircuitBreaker::new(2, 100);
        for block in 0..5 {
            breaker.record_revert_for_path(&path, block);
        }

        assert!(!breaker.is_token_suppressed(flash, 5),
            "flash token should never be suppressed");
    }

    #[test]
    fn test_token_breaker_skips_popular_intermediary() {
        let flash = addr(1);
        let weth = addr(2);
        let target = addr(3);
        let path = make_path(0, flash, vec![
            (addr(10), flash, weth),
            (addr(11), weth, target),
            (addr(12), target, flash),
        ]);

        let mut breaker = TokenCircuitBreaker::new(2, 100);
        breaker.set_popular_intermediaries(vec![weth]);

        for block in 0..5 {
            breaker.record_revert_for_path(&path, block);
        }

        assert!(!breaker.is_token_suppressed(weth, 5),
            "popular intermediary should not be suppressed");
        assert!(breaker.is_token_suppressed(target, 5),
            "non-popular target token should be suppressed");
    }

    #[test]
    fn test_token_breaker_suppresses_bad_token() {
        let flash = addr(1);
        let good = addr(2);
        let bad = addr(3);
        // bad appears in 2 positions (token_out of hop2 and token_in of hop3),
        // so each record_revert_for_path call increments its counter by 2.
        let path = make_path(0, flash, vec![
            (addr(10), flash, good),
            (addr(11), good, bad),
            (addr(12), bad, flash),
        ]);

        let mut breaker = TokenCircuitBreaker::new(5, 100);
        breaker.set_popular_intermediaries(vec![good]);

        breaker.record_revert_for_path(&path, 1);
        assert!(!breaker.is_token_suppressed(bad, 2), "2 < 5 threshold");

        breaker.record_revert_for_path(&path, 2);
        assert!(!breaker.is_token_suppressed(bad, 3), "4 < 5 threshold");

        breaker.record_revert_for_path(&path, 3);
        assert!(breaker.is_token_suppressed(bad, 4), "6 >= 5 threshold");
        assert!(!breaker.is_token_suppressed(bad, 104), "expired after suppression window");
    }

    #[test]
    fn test_token_breaker_success_resets() {
        let flash = addr(1);
        let token = addr(2);
        let path = make_path(0, flash, vec![
            (addr(10), flash, token),
            (addr(11), token, flash),
        ]);

        let mut breaker = TokenCircuitBreaker::new(3, 100);
        breaker.record_revert_for_path(&path, 1);
        breaker.record_revert_for_path(&path, 2);
        breaker.record_success_for_path(&path);
        breaker.record_revert_for_path(&path, 3);

        assert!(!breaker.is_token_suppressed(token, 4),
            "success should reset consecutive count");
    }

    #[test]
    fn test_path_circuit_breaker_trip_and_decay() {
        let mut cb = PathCircuitBreaker::new();
        cb.record_submit(1);
        cb.record_revert(1, 100);
        cb.record_revert(1, 101);
        assert!(!cb.is_suppressed(1, 102));

        cb.record_revert(1, 102);
        assert!(cb.is_suppressed(1, 103), "should be suppressed after 3 consecutive reverts");
        assert!(!cb.is_suppressed(1, 200), "should expire after SUPPRESS_BLOCKS");
    }

    #[test]
    fn test_path_circuit_breaker_success_resets() {
        let mut cb = PathCircuitBreaker::new();
        cb.record_revert(1, 1);
        cb.record_revert(1, 2);
        cb.record_success(1);
        cb.record_revert(1, 3);
        assert!(!cb.is_suppressed(1, 4));
    }

    #[test]
    fn test_path_circuit_breaker_decay_gap() {
        let mut cb = PathCircuitBreaker::new();
        cb.record_revert(1, 10);
        cb.record_revert(1, 11);
        cb.record_revert(1, 300);
        assert!(!cb.is_suppressed(1, 301),
            "reverts separated by >DECAY_BLOCKS should reset counter");
    }
}
