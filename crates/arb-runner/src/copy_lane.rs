//! Wallet-copy execution lane: a registered/discovered leader's pending
//! swap becomes a copy order on our smart account.
//!
//! Pipeline per pending swap (runs inside the backrun drain loop, after the
//! observer records it):
//!   watchlist match → dedup → decode gates (V2 router, priced spend token)
//!   → safety (GoPlus blocked set) → sizing (fixed USD notional) → V2
//!   constant-product sim on live pool state → slippage-bounded minOut →
//!   submission through the 4337 venue.
//!
//! Ordering: copies are next-block semantics by design — the lane never
//! front-runs the leader and never sandwiches. Under strict_4337 the only
//! venue is the Pimlico bundler, so the copy lands as soon as the bundler
//! mines it after the leader confirms.
//!
//! Modes: `off` ignores everything; `shadow`/`paper` run the full pipeline
//! and record the decision to _copies.jsonl + _opportunities.jsonl without
//! submitting; `live` additionally requires the wallet's risk_tier ==
//! "live" and submits real UserOps. Approvals are submitted once per
//! (token, router) before the first live copy; the triggering swap is
//! skipped and retried on the leader's next signal.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy_primitives::{Address, B256, U256};
use alloy::sol;
use alloy_sol_types::SolCall;
use arb_leaders::{LeaderRegistry, LeadersConfig};
use arb_mempool::watcher::PendingSwap;
use arb_core::types::PoolState;
use arb_state::PoolStore;
use arb_submit::router::VenueRouter;
use arb_submit::{Bundle, UserOpCall};
use arb_rpc::endpoint::Endpoint;
use dashmap::DashSet;
use tracing::{debug, info, warn};

use crate::metrics;

sol! {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyMode {
    Off,
    /// Full pipeline, record-only — what live mode would do, logged.
    Shadow,
    Live,
}

impl CopyMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "shadow" | "paper" => Self::Shadow,
            "live" => Self::Live,
            _ => Self::Off,
        }
    }
}

/// (tokenA, tokenB) sorted → [(pool, fee_bps)] — mirrors the runner's
/// pair_to_pools index built at startup.
pub type PairPools = HashMap<(Address, Address), Vec<(Address, u32)>>;

pub struct CopyLane {
    chain: String,
    mode: CopyMode,
    usd: f64,
    slippage_bps: u64,
    deadline_secs: u64,
    registry: Arc<LeaderRegistry>,
    /// tx_hash dedup — a tx can be redelivered by WSS pool rotation.
    seen: DashSet<B256>,
    /// GoPlus-blocked tokens (startup screen snapshot).
    blocked: HashSet<Address>,
    /// token → USD price (only priced tokens are spendable/sizeable).
    prices: HashMap<Address, f64>,
    decimals: HashMap<Address, u32>,
    /// Spend-side allowlist; empty = any priced token.
    spend: HashSet<Address>,
    /// V2 routers allowed to carry copies.
    v2_routers: HashSet<Address>,
    store: Arc<PoolStore>,
    pair_to_pools: PairPools,
    router: Arc<VenueRouter>,
    account: Option<Address>,
    endpoint: Arc<Endpoint>,
    chain_id: u64,
    /// (token, router) approvals already submitted.
    approved: DashSet<(Address, Address)>,
    data_dir: std::path::PathBuf,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One constant-product hop. None on zero reserves or zero output.
fn eval_v2_step(amt: U256, r_in: U256, r_out: U256, fee_bps: u32) -> Option<U256> {
    if r_in.is_zero() || r_out.is_zero() {
        return None;
    }
    let fee = U256::from(fee_bps.min(9_999) as u64);
    let amt_fee = amt * (U256::from(10_000u64) - fee);
    let out = amt_fee * r_out / (r_in * U256::from(10_000u64) + amt_fee);
    (!out.is_zero()).then_some(out)
}

impl CopyLane {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cfg: &LeadersConfig,
        chain: &str,
        chain_id: u64,
        registry: Arc<LeaderRegistry>,
        store: Arc<PoolStore>,
        pair_to_pools: PairPools,
        blocked: HashSet<Address>,
        prices: HashMap<Address, f64>,
        decimals: HashMap<Address, u32>,
        router: Arc<VenueRouter>,
        account: Option<Address>,
        endpoint: Arc<Endpoint>,
    ) -> Option<Self> {
        let mode = CopyMode::from_str(&cfg.copy_mode);
        if mode == CopyMode::Off || cfg.copy_usd <= 0.0 {
            return None;
        }
        let v2_routers: HashSet<Address> = cfg
            .copy_v2_routers
            .iter()
            .filter_map(|s| s.parse::<Address>().ok())
            .collect();
        let spend: HashSet<Address> = cfg
            .copy_spend_tokens
            .iter()
            .filter_map(|s| s.parse::<Address>().ok())
            .collect();
        info!(
            chain,
            mode = cfg.copy_mode.as_str(),
            usd = cfg.copy_usd,
            routers = v2_routers.len(),
            "wallet-copy lane armed"
        );
        Some(Self {
            chain: chain.to_string(),
            mode,
            usd: cfg.copy_usd,
            slippage_bps: cfg.copy_slippage_bps,
            deadline_secs: cfg.copy_deadline_secs,
            registry,
            seen: DashSet::new(),
            blocked,
            prices,
            decimals,
            spend,
            v2_routers,
            store,
            pair_to_pools,
            router,
            account,
            endpoint,
            chain_id,
            approved: DashSet::new(),
            data_dir: std::path::PathBuf::from("data/leaders"),
        })
    }

    fn reject(&self, reason: &'static str) {
        metrics::COPY_REJECTS
            .with_label_values(&[&self.chain, reason])
            .inc();
        debug!(reason, "copy lane reject");
    }

    /// Hot-path entry: called for every pending swap in the backrun drain.
    /// Cheap synchronous guards run inline; submission is spawned so the
    /// victim-evaluation loop never blocks on RPC.
    pub fn mode(&self) -> CopyMode {
        self.mode
    }

    /// Whether a pending tx's sender is a live-tier leader while this lane
    /// runs live — used to gate leader-signaled backrun submissions when the
    /// generic backrun lane is disabled. This is the zero-capital copy: the
    /// executor flash-borrows and replays the displacement the leader's swap
    /// created, so no token inventory is needed.
    pub fn allows_copy_backrun(&self, from: &Address) -> bool {
        self.mode == CopyMode::Live
            && self
                .registry
                .lookup(from)
                .map(|w| w.risk_tier == "live")
                .unwrap_or(false)
    }

    pub fn on_swap(&self, pending: &PendingSwap) {
        let Some(wallet) = self.registry.lookup(&pending.from) else {
            return;
        };
        if !self.seen.insert(pending.tx_hash) {
            return;
        }
        let d = &pending.decoded;

        // Only router swaps are copyable — direct pool calls carry no
        // amount_in semantics a router rebuild can express.
        let (token_in, token_out) = match (d.token_in, d.token_out) {
            (Some(i), Some(o)) => (i, o),
            _ => {
                self.reject("undecoded");
                return;
            }
        };
        if d.path.len() < 2 {
            self.reject("no_path");
            return;
        }
        if !self.v2_routers.contains(&pending.to) {
            self.reject("router_not_copyable");
            return;
        }
        if !self.spend.is_empty() && !self.spend.contains(&token_in) {
            self.reject("spend_not_allowed");
            return;
        }
        if self.blocked.contains(&token_out) {
            self.reject("token_out_blocked");
            return;
        }
        let Some(price_in) = self.prices.get(&token_in).copied() else {
            self.reject("token_in_unpriced");
            return;
        };
        let dec_in = self.decimals.get(&token_in).copied().unwrap_or(18) as u32;

        // Per-wallet notional cap wins over the lane default when set.
        let usd = if wallet.max_copied_notional_usd > 0.0 {
            self.usd.min(wallet.max_copied_notional_usd)
        } else {
            self.usd
        };
        let amount_in = U256::from((usd / price_in) * 10f64.powi(dec_in as i32));
        if amount_in.is_zero() {
            self.reject("dust_size");
            return;
        }

        // Pick the concrete pool per hop first — the same list is reused for
        // the stale sim here and the fresh on-chain re-read in spawn_submit.
        let Some(hops) = self.pick_hops(&d.path, &d.pools_touched) else {
            self.reject("sim_unsupported");
            return;
        };
        // Resting-state sim for the record — any hop we cannot price yields
        // no bounded minOut, so we skip rather than ship a blind copy.
        let Some(sim_out) = self.eval_hops(&d.path, &hops, amount_in) else {
            self.reject("sim_unsupported");
            return;
        };
        let min_out = sim_out * U256::from(10_000 - self.slippage_bps) / U256::from(10_000);
        if min_out.is_zero() {
            self.reject("sim_zero_out");
            return;
        }

        metrics::COPY_SIGNALS.with_label_values(&[&self.chain]).inc();
        self.record(pending, &wallet.address, amount_in, min_out, "evaluated");

        match self.mode {
            CopyMode::Shadow => {
                debug!(
                    leader = %pending.from,
                    tx = %pending.tx_hash,
                    usd,
                    "shadow copy evaluated — would submit"
                );
            }
            CopyMode::Live => {
                if wallet.risk_tier != "live" {
                    self.reject("wallet_not_live");
                    return;
                }
                self.spawn_submit(pending.clone(), d.path.clone(), amount_in, sim_out, hops);
            }
            CopyMode::Off => {}
        }
    }

    /// Pick the best tracked V2 pool per hop. Prefers pools the leader
    /// actually touched, then any tracked pool. `fee_bps` is kept so the
    /// fresh re-read can re-sim without the store.
    fn pick_hops(
        &self,
        path: &[Address],
        pools_touched: &[Address],
    ) -> Option<Vec<(Address, u32)>> {
        let touched: HashSet<Address> = pools_touched.iter().copied().collect();
        let mut hops = Vec::with_capacity(path.len().saturating_sub(1));
        for pair in path.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let key = if a < b { (a, b) } else { (b, a) };
            let candidates = self.pair_to_pools.get(&key)?;
            let pool = candidates
                .iter()
                .filter(|(p, _)| self.store.get(p).is_some())
                .max_by_key(|(p, _)| touched.contains(p) as u8);
            hops.push(pool.copied()?);
        }
        Some(hops)
    }

    /// Constant-product walk of `path` over the picked hops using PoolStore
    /// state. Returns None when a hop has no V2 state or zero reserves.
    fn eval_hops(
        &self,
        path: &[Address],
        hops: &[(Address, u32)],
        amount_in: U256,
    ) -> Option<U256> {
        let mut amt = amount_in;
        for (i, pair) in path.windows(2).enumerate() {
            let (a, _b) = (pair[0], pair[1]);
            let (pool_addr, _) = hops[i];
            let state = self.store.get(&pool_addr)?;
            let PoolState::V2(v2) = state else { return None };
            let (r_in, r_out) = if v2.token0 == a {
                (v2.reserve0, v2.reserve1)
            } else {
                (v2.reserve1, v2.reserve0)
            };
            amt = eval_v2_step(amt, r_in, r_out, v2.fee_bps)?;
        }
        Some(amt)
    }

    fn spawn_submit(
        &self,
        pending: PendingSwap,
        path: Vec<Address>,
        amount_in: U256,
        stale_out: U256,
        hops: Vec<(Address, u32)>,
    ) {
        let Some(account) = self.account else {
            self.reject("no_smart_account");
            return;
        };
        let router = self.router.clone();
        let endpoint = self.endpoint.clone();
        let approved = self.approved.clone();
        let chain = self.chain.clone();
        let chain_id = self.chain_id;
        let deadline_secs = self.deadline_secs;
        let slippage_bps = self.slippage_bps;
        let data_dir = self.data_dir.clone();
        let store = self.store.clone();
        let wallet_hex = format!("{:#x}", pending.from);
        let token_in = path[0];
        let router_addr = pending.to;

        tokio::spawn(async move {
            // Balance gate: the smart account must hold >= amount_in of the
            // spend token — a reverting UserOp still costs sponsorship.
            let bal_cd = balanceOfCall { owner: account }.abi_encode();
            match endpoint.eth_call_timed(token_in, bal_cd.into()).await {
                Ok((ret, _)) => {
                    if ret.len() >= 32 {
                        let bal = U256::from_be_slice(&ret[..32]);
                        if bal < amount_in {
                            metrics::COPY_REJECTS
                                .with_label_values(&[&chain, "insufficient_balance"])
                                .inc();
                            return;
                        }
                    }
                }
                Err(e) => {
                    warn!(error = %e, "copy lane balance read failed");
                    metrics::COPY_REJECTS
                        .with_label_values(&[&chain, "balance_read_err"])
                        .inc();
                    return;
                }
            }

            // Fresh-state re-sim: re-read reserves for every hop at submit
            // time — store state can be a block+ stale, and the leader's own
            // tx lands before ours. `min_out` tightens to the worse of the
            // stale and fresh sims; a hop whose fresh read fails falls back
            // to stored reserves rather than shipping blind.
            let mut read_futs = Vec::with_capacity(hops.len());
            for (pool_addr, _) in &hops {
                let cd = getReservesCall {}.abi_encode();
                read_futs.push(endpoint.eth_call_timed(*pool_addr, cd.into()));
            }
            let reads = futures::future::join_all(read_futs).await;
            let mut amt = amount_in;
            let mut fallback_hops = 0usize;
            let mut sim_ok = true;
            for (i, pair) in path.windows(2).enumerate() {
                let (a, _b) = (pair[0], pair[1]);
                let (pool_addr, fee_bps) = hops[i];
                let fresh = reads[i].as_ref().ok().and_then(|(ret, _)| {
                    if ret.len() >= 64 {
                        Some((
                            U256::from_be_slice(&ret[..32]),
                            U256::from_be_slice(&ret[32..64]),
                        ))
                    } else {
                        None
                    }
                });
                let (r0, r1, token0) = match (fresh, store.get(&pool_addr)) {
                    (Some((r0, r1)), Some(PoolState::V2(v2))) => (r0, r1, v2.token0),
                    (Some((r0, r1)), _) => (r0, r1, a),
                    (None, Some(PoolState::V2(v2))) => {
                        fallback_hops += 1;
                        (v2.reserve0, v2.reserve1, v2.token0)
                    }
                    _ => {
                        sim_ok = false;
                        break;
                    }
                };
                let (r_in, r_out) = if token0 == a { (r0, r1) } else { (r1, r0) };
                match eval_v2_step(amt, r_in, r_out, fee_bps) {
                    Some(o) => amt = o,
                    None => {
                        sim_ok = false;
                        break;
                    }
                }
            }
            if !sim_ok || amt.is_zero() {
                metrics::COPY_REJECTS
                    .with_label_values(&[&chain, "fresh_sim_fail"])
                    .inc();
                metrics::COPY_FRESH
                    .with_label_values(&[&chain, "fail"])
                    .inc();
                return;
            }
            // Tighten min_out to the worse sim — state that moved since
            // detection lowers the bound instead of shipping a stale quote.
            let best_out = amt.min(stale_out);
            let min_out = best_out * U256::from(10_000 - slippage_bps) / U256::from(10_000);
            if min_out.is_zero() {
                metrics::COPY_REJECTS
                    .with_label_values(&[&chain, "fresh_sim_zero"])
                    .inc();
                return;
            }
            if fallback_hops > 0 {
                metrics::COPY_FRESH
                    .with_label_values(&[&chain, "fallback"])
                    .inc();
            } else {
                metrics::COPY_FRESH
                    .with_label_values(&[&chain, "ok"])
                    .inc();
            }

            // One-time approval per (token, router) — submits its own
            // UserOp; the copy itself waits for the next leader signal.
            let key = (token_in, router_addr);
            if !approved.contains(&key) {
                approved.insert(key);
                let approve_cd = approveCall {
                    spender: router_addr,
                    amount: U256::MAX,
                }
                .abi_encode();
                let bundle = Bundle {
                    signed_txs: vec![],
                    victim_tx: None,
                    target_block: 0,
                    chain_id,
                    backrun_tx: None,
                    call: Some(UserOpCall {
                        to: token_in,
                        data: approve_cd.into(),
                    }),
                };
                let res = router
                    .submit_all(&bundle, false, Duration::ZERO)
                    .await;
                metrics::COPY_APPROVALS.with_label_values(&[&chain]).inc();
                let ok = res.iter().any(|r| {
                    r.result.as_ref().map(|s| s.success).unwrap_or(false)
                });
                if !ok {
                    approved.remove(&key);
                    warn!("copy lane approval failed — will retry next signal");
                } else {
                    info!(token = %token_in, router = %router_addr, "copy lane approval submitted");
                }
                return; // this signal is spent; the next one executes.
            }

            let deadline = U256::from(now_ms() / 1000 + deadline_secs);
            let swap_cd = swapExactTokensForTokensSupportingFeeOnTransferTokensCall {
                amountIn: amount_in,
                amountOutMin: min_out,
                path,
                to: account,
                deadline,
            }
            .abi_encode();

            // victim_tx stays None: under strict_4337 the bundler venue is
            // not an ordering venue, and copies are next-block by design.
            let bundle = Bundle {
                signed_txs: vec![],
                victim_tx: None,
                target_block: 0,
                chain_id,
                backrun_tx: Some(pending.tx_hash),
                call: Some(UserOpCall {
                    to: router_addr,
                    data: swap_cd.into(),
                }),
            };
            let results = router
                .submit_all(&bundle, false, Duration::ZERO)
                .await;
            let ok = results.iter().any(|r| {
                r.result.as_ref().map(|s| s.success).unwrap_or(false)
            });
            let status = if ok { "submitted" } else { "venue_reject" };
            if ok {
                metrics::COPY_SUBMITTED.with_label_values(&[&chain]).inc();
                info!(leader = %pending.from, tx = %pending.tx_hash, "copy swap submitted");
            } else {
                metrics::COPY_REJECTS
                    .with_label_values(&[&chain, "venue_reject"])
                    .inc();
            }
            write_copy_record(
                &data_dir,
                &chain,
                &wallet_hex,
                &pending,
                amount_in,
                min_out,
                status,
            );
        });
    }

    /// Record every evaluated signal to _copies.jsonl and the shared
    /// opportunity feed (id "…/copy/…" → dashboard wallet-copy lane).
    fn record(
        &self,
        pending: &PendingSwap,
        wallet_hex: &str,
        amount_in: U256,
        min_out: U256,
        status: &'static str,
    ) {
        write_copy_record(
            &self.data_dir,
            &self.chain,
            wallet_hex,
            pending,
            amount_in,
            min_out,
            status,
        );
    }
}

fn write_copy_record(
    data_dir: &std::path::Path,
    chain: &str,
    wallet_hex: &str,
    pending: &PendingSwap,
    amount_in: U256,
    min_out: U256,
    status: &str,
) {
    use arb_core::opportunity::{ActionableOpportunity, ExecutionStatus, SimulationStatus};
    let dir = data_dir.join(chain);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        warn!(error = %e, "copy lane: cannot create data dir");
        return;
    }
    let row = serde_json::json!({
        "unix_ms": now_ms(),
        "chain": chain,
        "leader": wallet_hex,
        "leader_tx": format!("{}", pending.tx_hash),
        "router": format!("{}", pending.to),
        "token_in": pending.decoded.token_in.map(|a| format!("{a}")),
        "token_out": pending.decoded.token_out.map(|a| format!("{a}")),
        "amount_in": amount_in.to_string(),
        "min_out": min_out.to_string(),
        "status": status,
    });
    let mut line = serde_json::to_string(&row).unwrap_or_default();
    line.push('\n');
    if let Err(e) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("_copies.jsonl"))
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()))
    {
        debug!(error = %e, "copy record append failed");
    }

    let tx_short: String = format!("{}", pending.tx_hash).chars().take(18).collect();
    let mut o = ActionableOpportunity::new(
        chain,
        "copy",
        wallet_hex,
        &tx_short,
        pending.decoded.pools_touched.iter().map(|p| format!("{p}")).collect(),
    );
    o.victim_tx = format!("{}", pending.tx_hash);
    o.token_in = pending
        .decoded
        .token_in
        .map(|a| format!("{a}"))
        .unwrap_or_default();
    o.token_out = pending
        .decoded
        .token_out
        .map(|a| format!("{a}"))
        .unwrap_or_default();
    o.simulation_status = SimulationStatus::Pass;
    o.execution_status = match status {
        "submitted" => ExecutionStatus::Ready,
        _ => ExecutionStatus::None,
    };
    if status != "submitted" {
        o.rejection_reason = format!("copy_{status}");
    }
    o.unix_ms = now_ms();
    if let Err(e) = o.append_jsonl(dir.to_str().unwrap_or("")) {
        debug!(error = %e, "copy opportunity append failed");
    }
}
