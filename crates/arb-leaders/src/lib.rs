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
use prometheus::{
    register_counter_vec, register_histogram_vec, register_int_counter_vec,
    register_int_gauge_vec, CounterVec, HistogramVec, IntCounterVec, IntGaugeVec,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{mpsc, Mutex, RwLock};
use std::fs::{create_dir_all, File, OpenOptions};
use std::io::{BufWriter, Write};
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
    /// Per-observation enqueue latency — the Phase-1 observer budget is
    /// p50 <100µs / p95 <500µs / p99 <2ms, so this histogram is what proves
    /// the async writer keeps intelligence off the execution path.
    pub static ref LEADER_OBSERVE_SECS: HistogramVec = register_histogram_vec!(
        "arb_leader_observe_seconds",
        "Leader observation enqueue latency in seconds",
        &["chain"],
        vec![0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.002, 0.005]
    )
    .unwrap();
    /// Wallets auto-promoted into the registry by real-time discovery.
    pub static ref LEADER_DISCOVERED: IntCounterVec = register_int_counter_vec!(
        "arb_leader_discovered_total",
        "Leader wallets auto-discovered from the live pending-swap stream",
        &["chain"]
    )
    .unwrap();
    /// Candidate wallets evicted when the discovery cap is hit.
    pub static ref LEADER_EVICTED: IntCounterVec = register_int_counter_vec!(
        "arb_leader_evicted_total",
        "Auto-discovered leader wallets evicted by the registry cap",
        &["chain"]
    )
    .unwrap();
    /// Observations dropped because the async writer queue was full — the
    /// execution path always wins: intelligence telemetry is shed first.
    pub static ref LEADER_QUEUE_DROPPED: IntCounterVec = register_int_counter_vec!(
        "arb_leader_queue_dropped_total",
        "Leader observations dropped on a full writer queue",
        &["chain"]
    )
    .unwrap();
    /// Pending jobs in the async observation-writer queue.
    pub static ref LEADER_QUEUE_DEPTH: IntGaugeVec = register_int_gauge_vec!(
        "arb_leader_queue_depth",
        "Depth of the leader-observation writer queue",
        &["chain"]
    )
    .unwrap();
    /// Flush batches completed by the async writer worker.
    pub static ref LEADER_WRITER_BATCHES: IntCounterVec = register_int_counter_vec!(
        "arb_leader_writer_batch_total",
        "Batched JSONL flushes by the leader-observation writer",
        &["chain"]
    )
    .unwrap();
    /// Total microseconds the writer spent serializing + flushing.
    pub static ref LEADER_WRITER_FLUSH_US: CounterVec = register_counter_vec!(
        "arb_leader_writer_flush_us_total",
        "Total microseconds spent in writer serialization/flush",
        &["chain"]
    )
    .unwrap();
    /// Multi-chain intelligence metrics (expansion spec): shadow-simulation
    /// attempts and positive reproductions, and strategies expired on stale
    /// evidence — all partitioned per chain.
    pub static ref LEADER_SHADOW_ATTEMPTS: IntCounterVec = register_int_counter_vec!(
        "arb_leader_shadow_attempts_total",
        "Shadow-sim evaluations of strategies (per chain)",
        &["chain"]
    )
    .unwrap();
    pub static ref LEADER_SHADOW_POSITIVE: IntCounterVec = register_int_counter_vec!(
        "arb_leader_shadow_positive_total",
        "Shadow-sim evaluations that reproduced positive profit (per chain)",
        &["chain"]
    )
    .unwrap();
    pub static ref LEADER_STRATEGY_EXPIRED: IntCounterVec = register_int_counter_vec!(
        "arb_leader_strategy_expired_total",
        "Strategies expired on stale evidence (per chain)",
        &["chain"]
    )
    .unwrap();
    /// Total microseconds spent inside the discovery stats mutex.
    pub static ref LEADER_DISCOVERY_LOCK_US: CounterVec = register_counter_vec!(
        "arb_leader_discovery_lock_us_total",
        "Total microseconds spent in the discovery sender-map critical section",
        &["chain"]
    )
    .unwrap();
    /// Actionable-opportunity funnel (Commander directive): the product is an
    /// executable opportunity, not a wallet scorecard. Stages: decoded
    /// (route+context emitted by leader_scan), replay_attempts /
    /// replay_positive (historical reproduction), shadow_positive (live-state
    /// sim positive), submitted, landed, settled, plus {reason} rejections.
    pub static ref OPPORTUNITY_TOTAL: IntCounterVec = register_int_counter_vec!(
        "arb_opportunity_total",
        "Actionable-opportunity records by stage (per chain, stage)",
        &["chain", "stage"]
    )
    .unwrap();
    pub static ref OPPORTUNITY_REJECTED: IntCounterVec = register_int_counter_vec!(
        "arb_opportunity_rejected_total",
        "Opportunity rejections by machine-readable reason (per chain)",
        &["chain", "reason"]
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

/// `[leaders]` section of a chain config. Absent = feature off.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct LeadersConfig {
    /// Manually registered wallets (optional — discovery runs without them).
    #[serde(default)]
    pub wallets: Vec<LeaderWallet>,
    /// Real-time top-wallet discovery: score every sender in the pending
    /// stream on bot signals and auto-promote leaders. Off by default.
    #[serde(default)]
    pub discover: bool,
    /// Score a sender must reach inside the decay window to be promoted.
    /// Weights per observation: direct_pool_swap=5, tracked_pool_trade=3,
    /// multi_hop_router=2, single_hop_router=1, opaque=0. Default 15.
    #[serde(default = "default_min_score")]
    pub discover_min_score: f64,
    /// Minimum scored observations before promotion (anti-flash).
    #[serde(default = "default_min_obs")]
    pub discover_min_observations: u32,
    /// Cap on auto-discovered wallets; lowest-scored candidates evict first.
    /// Manual entries are never evicted. Default 50.
    #[serde(default = "default_max_wallets")]
    pub discover_max_wallets: usize,
    /// Score decay half-life in seconds. Default 300 — a wallet must keep
    /// behaving like a bot to stay ahead of the threshold.
    #[serde(default = "default_halflife")]
    pub discover_halflife_secs: f64,
}

fn default_min_score() -> f64 { 15.0 }
fn default_min_obs() -> u32 { 3 }
fn default_max_wallets() -> usize { 50 }
fn default_halflife() -> f64 { 300.0 }

/// Parsed, enabled wallets keyed by address. Interior mutability because
    /// real-time discovery promotes new wallets while the stream is live.
pub struct LeaderRegistry {
    wallets: RwLock<HashMap<Address, LeaderWallet>>,
    /// Addresses auto-discovered (not manually configured) — only these
    /// may be evicted by the discovery cap.
    discovered: Mutex<std::collections::HashSet<Address>>,
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
        Self {
            wallets: RwLock::new(wallets),
            discovered: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// True when no manual wallets AND nothing discovered yet. Used at
    /// startup only — discovery can still fill the registry later, so the
    /// observer must stay installed whenever discovery is enabled.
    pub fn is_empty(&self) -> bool {
        self.wallets.read().unwrap().is_empty()
    }

    pub fn len(&self) -> usize {
        self.wallets.read().unwrap().len()
    }

    pub fn contains(&self, from: &Address) -> bool {
        self.wallets.read().unwrap().contains_key(from)
    }

    pub fn lookup(&self, from: &Address) -> Option<LeaderWallet> {
        self.wallets.read().unwrap().get(from).cloned()
    }

    /// Promote a discovered sender. Returns false if already registered.
    pub fn insert_discovered(&self, addr: Address, wallet: LeaderWallet) -> bool {
        let mut map = self.wallets.write().unwrap();
        if map.contains_key(&addr) {
            return false;
        }
        map.insert(addr, wallet);
        self.discovered.lock().unwrap().insert(addr);
        true
    }

    /// Evict the lowest-priority discovered wallet (caller decides which —
    /// passed by address). Manual wallets are never candidates for eviction.
    pub fn evict_discovered(&self, addr: &Address) {
        self.wallets.write().unwrap().remove(addr);
        self.discovered.lock().unwrap().remove(addr);
    }

    pub fn discovered_count(&self) -> usize {
        self.discovered.lock().unwrap().len()
    }

    pub fn discovered_addrs(&self) -> Vec<Address> {
        self.discovered.lock().unwrap().iter().copied().collect()
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
    /// Stored raw so the hot path never pays for hex encoding; the async
    /// writer serializes them as the same 0x-prefixed hex on disk.
    #[serde(serialize_with = "hex_ser", deserialize_with = "hex_de")]
    pub raw_tx: Vec<u8>,
    #[serde(serialize_with = "hex_ser", deserialize_with = "hex_de")]
    pub raw_input: Vec<u8>,
}

fn hex_ser<S: serde::Serializer>(b: &[u8], s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format!("0x{}", hex::encode(b)))
}

fn hex_de<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
    let s = String::deserialize(d)?;
    hex::decode(s.strip_prefix("0x").unwrap_or(&s)).map_err(serde::de::Error::custom)
}

/// Work handed to the async observation writer — never blocks the caller.
enum WriterJob {
    Observation { wallet_hex: String, obs: Box<LeaderObservation> },
    DiscoveryEvent(Box<DiscoveryEvent>),
    Shutdown,
}

/// One background writer per chain: batches JSONL appends so the mempool
/// hot path only enqueues. Keeps per-wallet files open; flushes on a
/// ~100ms tick or after a bounded batch.
fn writer_loop(
    rx: mpsc::Receiver<WriterJob>,
    dir: PathBuf,
    chain: String,
    depth: std::sync::Arc<std::sync::atomic::AtomicUsize>,
) {
    let chain_dir = dir.join(&chain);
    let _ = create_dir_all(&chain_dir);
    let mut files: HashMap<String, BufWriter<File>> = HashMap::new();
    let mut pending = Vec::with_capacity(64);
    loop {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(job) => pending.push(job),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        while let Ok(job) = rx.try_recv() {
            pending.push(job);
            if pending.len() >= 128 {
                break;
            }
        }
        if pending.is_empty() {
            continue;
        }
        let t0 = std::time::Instant::now();
        let mut shutdown = false;
        for job in pending.drain(..) {
            depth.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            match job {
                WriterJob::Shutdown => {
                    shutdown = true;
                }
                WriterJob::Observation { wallet_hex, obs } => {
                    let mut line = serde_json::to_vec(&obs).unwrap_or_default();
                    line.push(b'\n');
                    let res = files
                        .entry(wallet_hex.clone())
                        .or_insert_with(|| {
                            match OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(chain_dir.join(format!("{wallet_hex}.jsonl")))
                            {
                                Ok(f) => BufWriter::new(f),
                                Err(_) => BufWriter::new(File::open("/dev/null").unwrap()),
                            }
                        });
                    if let Err(e) = res.write_all(&line) {
                        LEADER_WRITE_ERRORS.with_label_values(&[&chain]).inc();
                        warn!(error = %e, wallet = %wallet_hex, "leader observation write failed");
                    }
                }
                WriterJob::DiscoveryEvent(ev) => {
                    let path = chain_dir.join("_discovered.jsonl");
                    let mut line = serde_json::to_vec(&ev).unwrap_or_default();
                    line.push(b'\n');
                    if let Err(e) = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&path)
                        .and_then(|mut f| f.write_all(&line))
                    {
                        LEADER_WRITE_ERRORS.with_label_values(&[&chain]).inc();
                        warn!(error = %e, "discovery event write failed");
                    }
                }
            }
        }
        for f in files.values_mut() {
            let _ = f.flush();
        }
        LEADER_WRITER_BATCHES.with_label_values(&[&chain]).inc();
        LEADER_WRITER_FLUSH_US
            .with_label_values(&[&chain])
            .inc_by(t0.elapsed().as_micros() as f64);
        LEADER_QUEUE_DEPTH
            .with_label_values(&[&chain])
            .set(depth.load(std::sync::atomic::Ordering::Relaxed) as i64);
        if shutdown {
            break;
        }
    }
    for mut f in files.into_values() {
        let _ = f.flush();
    }
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

/// Writes observations to `data/leaders/<chain>/<wallet>.jsonl` and —
    /// when `[leaders] discover = true` — scores every sender in the stream
    /// to find top wallets autonomously.
pub struct LeaderObserver {
    registry: std::sync::Arc<LeaderRegistry>,
    discoverer: Option<LeaderDiscoverer>,
    writer_tx: mpsc::SyncSender<WriterJob>,
    depth: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    chain: String,
}

impl LeaderObserver {
    pub fn new(
        registry: LeaderRegistry,
        data_dir: PathBuf,
        chain: String,
        discover_cfg: &LeadersConfig,
    ) -> Self {
        let registry = std::sync::Arc::new(registry);
        // Bounded queue between the mempool hot path and the disk writer:
        // try_send never blocks; on a full queue the observation is dropped
        // so execution always wins over telemetry.
        let (writer_tx, writer_rx) = mpsc::sync_channel::<WriterJob>(2048);
        let writer_dir = data_dir.clone();
        let writer_chain = chain.clone();
        let depth = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let writer_depth = std::sync::Arc::clone(&depth);
        std::thread::Builder::new()
            .name(format!("leader-writer-{chain}"))
            .spawn(move || writer_loop(writer_rx, writer_dir, writer_chain, writer_depth))
            .expect("spawn leader observation writer");
        let discoverer = discover_cfg.discover.then(|| {
            LeaderDiscoverer::new(
                std::sync::Arc::clone(&registry),
                writer_tx.clone(),
                chain.clone(),
                discover_cfg.discover_min_score,
                discover_cfg.discover_min_observations,
                discover_cfg.discover_max_wallets,
                discover_cfg.discover_halflife_secs,
            )
        });
        Self { registry, discoverer, writer_tx, depth, chain }
    }

    /// Test-only constructor: inject queue capacity and hand the receiver to
    /// the caller so tests can hold the queue undrained (saturation) or drop
    /// it (disconnection) — the two non-blocking failure modes.
    #[cfg(test)]
    fn new_with_queue(
        registry: LeaderRegistry,
        chain: &str,
        cap: usize,
    ) -> (Self, mpsc::Receiver<WriterJob>) {
        let (writer_tx, writer_rx) = mpsc::sync_channel::<WriterJob>(cap);
        (
            Self {
                registry: std::sync::Arc::new(registry),
                discoverer: None,
                writer_tx,
                depth: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                chain: chain.to_string(),
            },
            writer_rx,
        )
    }

    /// Flush + stop the writer thread (tests and clean shutdown).
    pub fn shutdown_writer(&self) {
        let _ = self.writer_tx.try_send(WriterJob::Shutdown);
    }

    /// Returns configured+discovered wallet count.
    pub fn wallet_count(&self) -> usize {
        self.registry.len()
    }

    /// Wallets promoted by real-time discovery (excludes manual entries).
    pub fn discovered_wallets(&self) -> usize {
        self.registry.discovered_count()
    }

    /// Senders in the discovery scorer's stats map (0 when discovery off).
    pub fn scored_senders(&self) -> usize {
        self.discoverer.as_ref().map(|d| d.tracked_senders()).unwrap_or(0)
    }

    /// Top-scored senders from the discovery scorer (empty when off).
    pub fn top_senders(&self, n: usize) -> Vec<(Address, f64, u32, &'static str)> {
        self.discoverer
            .as_ref()
            .map(|d| d.top_senders(n))
            .unwrap_or_default()
    }

    /// Hot-path call on every decoded pending swap: bounded in-memory
    /// scoring + one non-blocking enqueue. No file I/O, no serialization,
    /// no hex encoding — all of that happens in the writer worker, so a
    /// slow disk or lock contention can never delay candidate evaluation.
    pub fn observe(&self, pending: &PendingSwap) {
        let t0 = std::time::Instant::now();
        if let Some(d) = &self.discoverer {
            d.track(pending);
        }
        let Some(wallet) = self.registry.lookup(&pending.from) else {
            LEADER_OBSERVE_US
                .with_label_values(&[&self.chain])
                .inc_by(t0.elapsed().as_micros() as f64);
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
            raw_tx: pending.raw_tx.clone(),
            raw_input: pending.raw_input.clone(),
        };

        match self
            .writer_tx
            .try_send(WriterJob::Observation { wallet_hex, obs: Box::new(obs) })
        {
            Ok(()) => {
                self.depth.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            Err(mpsc::TrySendError::Full(_)) => {
                LEADER_QUEUE_DROPPED.with_label_values(&[&self.chain]).inc();
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                LEADER_WRITE_ERRORS.with_label_values(&[&self.chain]).inc();
            }
        }
        let elapsed = t0.elapsed();
        LEADER_OBSERVE_US
            .with_label_values(&[&self.chain])
            .inc_by(elapsed.as_micros() as f64);
        LEADER_OBSERVE_SECS
            .with_label_values(&[&self.chain])
            .observe(elapsed.as_secs_f64());
    }
}

/// Per-sender decayed score in the live stream. A wallet promotes into the
/// registry when its score crosses `min_score` — i.e. when it repeatedly
/// does things only MEV/trading bots do (call pools directly, run multi-hop
/// routes through our tracked liquidity, high sustained frequency).
#[derive(Debug, Default)]
struct SenderStats {
    score: f64,
    observations: u32,
    last_seen: Option<std::time::Instant>,
    /// Most common attribution class — recorded as the wallet's initial
    /// strategy hypothesis until replay measurement refines it.
    dominant_class: &'static str,
    dominant_count: u32,
    class_counts: [u32; 5],
}

/// Observation-time class ordering must match `classify` weights below.
const CLASS_WEIGHTS: [(&str, f64); 5] = [
    ("direct_pool_swap", 5.0),   // humans never call swap() on a pool — pure bot
    ("tracked_pool_trade", 3.0), // trades our tracked liquidity — likely arb loop
    ("multi_hop_router", 2.0),   // paths humans rarely compose manually
    ("single_hop_router", 1.0),  // weakest signal — retail flow too
    ("opaque", 0.0),
];

fn class_weight(class: &str) -> f64 {
    CLASS_WEIGHTS
        .iter()
        .find(|(c, _)| *c == class)
        .map(|(_, w)| *w)
        .unwrap_or(0.0)
}

/// Real-time leader discovery. Scores every pending-swap sender with an
/// exponentially decayed behavior score and auto-registers top wallets.
/// Discovery is *observation-only*: promoted wallets get `risk_tier =
/// "candidate"` — they are recorded, never acted on.
pub struct LeaderDiscoverer {
    registry: std::sync::Arc<LeaderRegistry>,
    stats: Mutex<HashMap<Address, SenderStats>>,
    /// (sender, callee) → (hit count, last seen) — repeat-callee signal.
    callee_hits: Mutex<HashMap<(Address, Address), (u32, std::time::Instant)>>,
    /// Discovery events go to the same async writer as observations —
    /// promotion never opens a file on the hot path.
    writer_tx: mpsc::SyncSender<WriterJob>,
    chain: String,
    min_score: f64,
    min_observations: u32,
    max_wallets: usize,
    halflife_secs: f64,
}

/// Hard caps keep discovery maps bounded — once full, new senders/pairs
/// are simply not tracked (existing entries keep scoring).
const MAX_SENDER_STATS: usize = 20_000;
const MAX_CALLEE_PAIRS: usize = 50_000;

#[derive(Debug, Serialize)]
struct DiscoveryEvent {
    chain: String,
    wallet: String,
    unix_ms: u64,
    score: f64,
    observations: u32,
    dominant_class: String,
    reason: String,
}

impl LeaderDiscoverer {
    fn new(
        registry: std::sync::Arc<LeaderRegistry>,
        writer_tx: mpsc::SyncSender<WriterJob>,
        chain: String,
        min_score: f64,
        min_observations: u32,
        max_wallets: usize,
        halflife_secs: f64,
    ) -> Self {
        Self {
            registry,
            stats: Mutex::new(HashMap::new()),
            callee_hits: Mutex::new(HashMap::new()),
            writer_tx,
            chain,
            min_score,
            min_observations,
            max_wallets,
            halflife_secs,
        }
    }

    fn track(&self, pending: &PendingSwap) {
        let from = pending.from;
        if self.registry.contains(&from) {
            return; // already a leader — no re-scoring needed
        }
        let class = classify(pending, !pending.decoded.pools_touched.is_empty());
        let mut w = class_weight(class);
        let now = std::time::Instant::now();
        // Real arb bots usually send to their OWN contract — the pending tx
        // decodes as opaque. The tell is repetition: a wallet hammering the
        // same callee contract is running an automated strategy. 2nd+ hit
        // on the same (sender, callee) pair inside the decay window scores.
        if w == 0.0 {
            let mut callees = self.callee_hits.lock().unwrap();
            let key = (from, pending.to);
            // Cap the pair map: only update existing pairs once full.
            if !callees.contains_key(&key) && callees.len() >= MAX_CALLEE_PAIRS {
                return;
            }
            let count = callees.entry(key).or_insert((0u32, now));
            // expire stale callee entries cheaply
            count.1 = now;
            count.0 += 1;
            if count.0 >= 2 {
                w = 4.0; // repeat_opaque — comparable to tracked_pool_trade
            }
        }

        let promote = {
            let lock_t0 = std::time::Instant::now();
            let mut map = self.stats.lock().unwrap();
            let lock_us = lock_t0.elapsed().as_micros() as f64;
            LEADER_DISCOVERY_LOCK_US
                .with_label_values(&[&self.chain])
                .inc_by(lock_us);
            // Cap the sender map: cold unobserved senders stop being
            // tracked once full — already-scored senders keep working.
            if !map.contains_key(&from) && map.len() >= MAX_SENDER_STATS {
                return;
            }
            let s = map.entry(from).or_default();
            // Exponential decay since last sighting, then add this obs.
            if let Some(last) = s.last_seen {
                let dt = now.duration_since(last).as_secs_f64();
                s.score *= 0.5f64.powf(dt / self.halflife_secs);
            }
            s.last_seen = Some(now);
            s.score += w;
            s.observations += 1;
            let idx = CLASS_WEIGHTS.iter().position(|(c, _)| *c == class).unwrap_or(4);
            s.class_counts[idx] += 1;
            if s.class_counts[idx] > s.dominant_count {
                s.dominant_count = s.class_counts[idx];
                s.dominant_class = CLASS_WEIGHTS[idx].0;
            }
            let (score, obs, dom) = (s.score, s.observations, s.dominant_class);
            if score >= self.min_score && obs >= self.min_observations {
                Some((score, obs, dom))
            } else {
                // Keep the stats map bounded — drop cold, never-scoring senders.
                if map.len() > 20_000 {
                    let cutoff = now - std::time::Duration::from_secs(3600);
                    map.retain(|_, st| st.last_seen.map(|l| l > cutoff).unwrap_or(false));
                }
                None
            }
        };

        let Some((score, obs, dom)) = promote else {
            return;
        };
        self.promote(from, score, obs, dom);
    }

    fn promote(&self, addr: Address, score: f64, observations: u32, dominant: &'static str) {
        // Evict weakest discovered wallet when at cap — manual entries safe.
        if self.registry.discovered_count() >= self.max_wallets {
            if let Some(victim) = self.weakest_discovered() {
                self.registry.evict_discovered(&victim);
                LEADER_EVICTED.with_label_values(&[&self.chain]).inc();
                self.stats.lock().unwrap().remove(&victim);
            }
        }
        let wallet = LeaderWallet {
            address: format!("{addr:#x}"),
            label: "auto-discovered".to_string(),
            strategy_hypothesis: dominant.to_string(),
            risk_tier: "candidate".to_string(),
            max_copied_notional_usd: 0.0,
            enabled: true,
        };
        if !self.registry.insert_discovered(addr, wallet) {
            return;
        }
        LEADER_DISCOVERED.with_label_values(&[&self.chain]).inc();
        let ev = DiscoveryEvent {
            chain: self.chain.clone(),
            wallet: format!("{addr:#x}"),
            unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            score,
            observations,
            dominant_class: dominant.to_string(),
            reason: "bot-signal score crossed threshold in live pending stream".to_string(),
        };
        match self.writer_tx.try_send(WriterJob::DiscoveryEvent(Box::new(ev))) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => {
                LEADER_QUEUE_DROPPED.with_label_values(&[&self.chain]).inc();
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                LEADER_WRITE_ERRORS.with_label_values(&[&self.chain]).inc();
            }
        }
    }

    fn tracked_senders(&self) -> usize {
        self.stats.lock().unwrap().len()
    }

    /// Top-scored senders right now — the simulation's candidate ranking.
    pub fn top_senders(&self, n: usize) -> Vec<(Address, f64, u32, &'static str)> {
        let map = self.stats.lock().unwrap();
        let mut v: Vec<_> = map
            .iter()
            .map(|(a, s)| (*a, s.score, s.observations, s.dominant_class))
            .collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        v.truncate(n);
        v
    }

    /// Lowest-current-score discovered wallet — eviction candidate.
    fn weakest_discovered(&self) -> Option<Address> {
        let map = self.stats.lock().unwrap();
        self.registry
            .discovered_addrs()
            .into_iter()
            .filter_map(|a| map.get(&a).map(|s| (a, s.score)))
            .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(a, _)| a)
    }


}

// ============================================================================
// Strategy registry — the persistent, expiring artifact connecting outcome
// discovery to safe execution (observe → replay → shadow → bounded_live →
// expired). leader_scan upserts evidence every run; nothing here ever
// executes — bounded_live stays a manual/ops transition with a notional cap.
// ============================================================================

/// Lifecycle states for an internalized leader strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyState {
    /// Collecting outcome evidence from mined blocks.
    Observe,
    /// Evidence thresholds met — qualifies for P&L replay measurement.
    Replay,
    /// Route reproduced inside our pool graph — shadow coverage proven.
    Shadow,
    /// Ops-approved live deployment under max_notional_usd. Never automatic.
    BoundedLive,
    /// Evidence went stale or replay/execution failed — disabled.
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategyRecord {
    /// Stable id: "<wallet>/<class>".
    pub strategy_id: String,
    pub wallet: String,
    pub class: String,
    /// Route counterparties seen in the wallet's winning txs.
    #[serde(default)]
    pub route_pools: Vec<String>,
    /// Executor contract most used by this wallet, if any.
    #[serde(default)]
    pub executor_family: String,
    #[serde(default)]
    pub sample_trades: u32,
    #[serde(default)]
    pub win_rate: f64,
    #[serde(default)]
    pub median_profit_usd: f64,
    #[serde(default)]
    pub net_pnl_usd: f64,
    /// 0..1 — fraction of route counterparties inside our pool registry.
    #[serde(default)]
    pub coverage: f64,
    /// Simulation verification: our own engine reproduced a positive profit
    /// through this strategy's route pools on live state. REQUIRED for
    /// bounded_live — discovery alone can never approve execution.
    #[serde(default)]
    pub sim_verified: bool,
    /// Best gross profit our simulator found through the route pools, USD.
    #[serde(default)]
    pub verified_profit_usd: f64,
    #[serde(default)]
    pub confidence: f64,
    pub state: StrategyState,
    #[serde(default)]
    pub created_block: u64,
    #[serde(default)]
    pub last_seen_block: u64,
    #[serde(default)]
    pub expires_at_block: u64,
    /// 0 = never deployable. BoundedLive requires this > 0 set by ops.
    #[serde(default)]
    pub max_notional_usd: f64,
    /// Settlement feedback: cumulative realized P&L of OUR executions of
    /// this strategy's route, after gas. Distinct from net_pnl_usd, which
    /// is the leader's measured evidence.
    #[serde(default)]
    pub settled_usd: f64,
    #[serde(default)]
    pub settle_count: u32,
    /// Executions that landed with positive realized P&L.
    #[serde(default)]
    pub settle_wins: u32,
}

/// Evidence thresholds promoting a wallet Observe -> Replay.
#[derive(Debug, Clone, Copy)]
pub struct PromoteThresholds {
    pub min_net_usd: f64,
    pub min_txs: u32,
    pub min_win_rate: f64,
}

impl Default for PromoteThresholds {
    fn default() -> Self {
        Self { min_net_usd: 50.0, min_txs: 2, min_win_rate: 0.5 }
    }
}

/// JSONL-backed persistent strategy store at
/// `data/leaders/<chain>/_strategies.jsonl`.
pub struct StrategyRegistry {
    path: PathBuf,
    chain: String,
    pub records: HashMap<String, StrategyRecord>,
    /// Blocks of inactivity before a strategy expires.
    ttl_blocks: u64,
}

impl StrategyRegistry {
    pub fn load(chain: &str, ttl_blocks: u64) -> Self {
        let path = PathBuf::from(format!("data/leaders/{chain}/_strategies.jsonl"));
        let mut records = HashMap::new();
        if let Ok(txt) = std::fs::read_to_string(&path) {
            for line in txt.lines() {
                if let Ok(r) = serde_json::from_str::<StrategyRecord>(line) {
                    records.insert(r.strategy_id.clone(), r);
                }
            }
        }
        Self { path, chain: chain.to_string(), records, ttl_blocks }
    }

    /// Upsert outcome evidence for a wallet. Returns (transitioned_to, is_new).
    pub fn upsert_evidence(
        &mut self,
        wallet: &str,
        class: &str,
        net_pnl_usd: f64,
        txs: u32,
        win_rate: f64,
        median_profit_usd: f64,
        executor_family: &str,
        route_pools: Vec<String>,
        block: u64,
        th: &PromoteThresholds,
    ) -> (StrategyState, bool) {
        let id = format!("{wallet}/{class}");
        let is_new = !self.records.contains_key(&id);
        let r = self.records.entry(id.clone()).or_insert_with(|| StrategyRecord {
            strategy_id: id,
            wallet: wallet.to_string(),
            class: class.to_string(),
            route_pools: vec![],
            executor_family: String::new(),
            sample_trades: 0,
            win_rate: 0.0,
            median_profit_usd: 0.0,
            net_pnl_usd: 0.0,
            coverage: 0.0,
            sim_verified: false,
            verified_profit_usd: 0.0,
            confidence: 0.0,
            state: StrategyState::Observe,
            created_block: block,
            last_seen_block: block,
            expires_at_block: block + self.ttl_blocks,
            max_notional_usd: 0.0,
            settled_usd: 0.0,
            settle_count: 0,
            settle_wins: 0,
        });
        r.last_seen_block = block;
        r.expires_at_block = block + self.ttl_blocks;
        // Latest evidence wins — scans are cumulative windows.
        r.net_pnl_usd = net_pnl_usd;
        r.sample_trades = txs;
        r.win_rate = win_rate;
        r.median_profit_usd = median_profit_usd;
        if !executor_family.is_empty() {
            r.executor_family = executor_family.to_string();
        }
        if !route_pools.is_empty() {
            r.route_pools = route_pools;
        }
        r.confidence = (r.sample_trades as f64 / 10.0).min(1.0)
            * (0.5 + 0.5 * r.win_rate);
        // Promotion: evidence thresholds move Observe -> Replay. Higher
        // states are only ever moved by mark_coverage / ops.
        if r.state == StrategyState::Observe
            && r.net_pnl_usd >= th.min_net_usd
            && r.sample_trades >= th.min_txs
            && r.win_rate >= th.min_win_rate
        {
            r.state = StrategyState::Replay;
        }
        (r.state, is_new)
    }

    /// Shadow coverage result for a wallet's route. Replay -> Shadow when
    /// the whole route sits inside our pool registry.
    pub fn mark_coverage(&mut self, wallet: &str, class: &str, coverage: f64) {
        let id = format!("{wallet}/{class}");
        if let Some(r) = self.records.get_mut(&id) {
            r.coverage = coverage;
            if r.state == StrategyState::Replay && coverage >= 0.999 {
                r.state = StrategyState::Shadow;
            }
        }
    }

    /// Simulation verification result (auto mode): a strategy whose route
    /// pools reproduce positive profit through our own simulator is
    /// auto-approved to bounded_live under `cap_usd` — the ONLY path to
    /// execution. Applies from shadow OR replay: sim verification subsumes
    /// the coverage gate (route_pools can contain non-pool intermediaries
    /// that suppress coverage without blocking execution). Manual ops
    /// approval requires the same sim_verified precondition, so discovery
    /// alone can never execute.
    pub fn mark_verified(&mut self, strategy_id: &str, profit_usd: f64, cap_usd: f64) -> bool {
        match self.records.get_mut(strategy_id) {
            Some(r)
                if matches!(r.state, StrategyState::Shadow | StrategyState::Replay)
                    && profit_usd > 0.0 =>
            {
                r.sim_verified = true;
                r.verified_profit_usd = profit_usd;
                r.max_notional_usd = cap_usd;
                r.state = StrategyState::BoundedLive;
                true
            }
            Some(r) => {
                if profit_usd <= 0.0 {
                    r.sim_verified = false;
                }
                false
            }
            _ => false,
        }
    }

    /// Ops-only promotion — requires simulation verification AND an
    /// explicit notional cap.
    pub fn approve_bounded_live(&mut self, strategy_id: &str, max_notional_usd: f64) -> bool {
        match self.records.get_mut(strategy_id) {
            Some(r)
                if r.state == StrategyState::Shadow
                    && r.sim_verified
                    && max_notional_usd > 0.0 =>
            {
                r.max_notional_usd = max_notional_usd;
                r.state = StrategyState::BoundedLive;
                true
            }
            _ => false,
        }
    }

    /// Settlement feedback: record OUR realized P&L for an execution of
    /// this strategy's route. Health rule: a BoundedLive strategy that has
    /// settled >=3 times with negative cumulative realized P&L is demoted
    /// back to Shadow and must re-verify in simulation before trading —
    /// live losses override stale sim evidence.
    pub fn mark_settled(&mut self, strategy_id: &str, realized_usd: f64) -> bool {
        match self.records.get_mut(strategy_id) {
            Some(r) => {
                r.settled_usd += realized_usd;
                r.settle_count += 1;
                if realized_usd > 0.0 {
                    r.settle_wins += 1;
                }
                if r.state == StrategyState::BoundedLive
                    && r.settle_count >= 3
                    && r.settled_usd < 0.0
                {
                    r.state = StrategyState::Shadow;
                    r.sim_verified = false;
                    r.max_notional_usd = 0.0;
                    true
                } else {
                    false
                }
            }
            None => false,
        }
    }

    /// Expire strategies whose evidence went stale.
    pub fn expire_stale(&mut self, current_block: u64) -> Vec<String> {
        let mut expired = Vec::new();
        for r in self.records.values_mut() {
            if r.state != StrategyState::Expired && current_block > r.expires_at_block {
                r.state = StrategyState::Expired;
                expired.push(r.strategy_id.clone());
            }
        }
        if !expired.is_empty() {
            LEADER_STRATEGY_EXPIRED
                .with_label_values(&[&self.chain])
                .inc_by(expired.len() as u64);
        }
        expired
    }

    pub fn save(&self) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            create_dir_all(dir)?;
        }
        let mut out = String::new();
        for r in self.records.values() {
            out.push_str(&serde_json::to_string(r).unwrap_or_default());
            out.push('\n');
        }
        std::fs::write(&self.path, out)
    }

    /// Incremental scan cursor — last block scanned per chain, persisted at
    /// `data/leaders/<chain>/_cursor.json` so each run scans only new blocks.
    pub fn load_cursor(chain: &str) -> Option<u64> {
        let txt = std::fs::read_to_string(format!("data/leaders/{chain}/_cursor.json")).ok()?;
        serde_json::from_str::<serde_json::Value>(&txt).ok()?
            .get("last_scanned_block")?.as_u64()
    }

    pub fn save_cursor(chain: &str, block: u64) -> std::io::Result<()> {
        let dir = format!("data/leaders/{chain}");
        create_dir_all(&dir)?;
        std::fs::write(
            format!("{dir}/_cursor.json"),
            format!("{{\"last_scanned_block\":{block}}}\n"),
        )
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
        assert_eq!(reg.len(), 1);
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
        let obs = LeaderObserver::new(LeaderRegistry::new(&cfg), dir.clone(), "BSC".into(), &LeadersConfig::default());
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
        obs.shutdown_writer();
        let file = dir.join("BSC").join("0x4444444444444444444444444444444444444444.jsonl");
        // Persistence is async: poll briefly for the writer to flush.
        let mut body = String::new();
        for _ in 0..50 {
            if let Ok(b) = std::fs::read_to_string(&file) {
                if !b.is_empty() {
                    body = b;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!body.is_empty(), "writer did not flush the observation");
        assert!(body.contains("\"class\":\"single_hop_router\""));
        assert!(body.contains("\"raw_tx\":\"0x0405\""));
        // Non-leader sender is ignored.
        let mut other = pending;
        other.from = address!("7777777777777777777777777777777777777777");
        obs.observe(&other);
        assert_eq!(std::fs::read_to_string(&file).unwrap().lines().count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn discovery_promotes_bot_like_senders() {
        use arb_mempool::decoder::{DecodedSwap, DirectSwap};
        let dir = std::env::temp_dir().join(format!("arb-leaders-disc-{}", std::process::id()));
        // Discovery on, no manual wallets.
        let cfg: LeadersConfig = toml::from_str(
            r#"discover = true
               discover_min_score = 9.0
               discover_min_observations = 2
               discover_max_wallets = 10
               discover_halflife_secs = 300.0"#,
        )
        .unwrap();
        let reg = LeaderRegistry::new(&cfg);
        let obs = LeaderObserver::new(reg, dir.clone(), "BSC".into(), &cfg);
        let bot = address!("8888888888888888888888888888888888888888");
        let mk = |from: Address, direct: bool| PendingSwap {
            tx_hash: B256::ZERO,
            from,
            to: address!("9999999999999999999999999999999999999999"),
            value: U256::ZERO,
            decoded: DecodedSwap {
                router: "test",
                token_in: None,
                token_out: None,
                amount_in: Some(U256::from(1u64)),
                path: vec![],
                first_hop_fee: None,
                hop_fees: vec![],
                direct: direct.then_some(DirectSwap::V2 {
                    pool: address!("9999999999999999999999999999999999999999"),
                    amount0_out: U256::from(1u64),
                    amount1_out: U256::ZERO,
                }),
                pools_touched: vec![],
            },
            raw_input: vec![],
            raw_tx: vec![],
            seen_at: std::time::Instant::now(),
        };
        // Retail sender: single-hop router swaps (weight 1) — below threshold.
        let retail = address!("7777777777777777777777777777777777777777");
        let mut r_tx = mk(retail, false);
        r_tx.decoded.path = vec![address!("6666666666666666666666666666666666666666")];
        for _ in 0..5 {
            obs.observe(&r_tx);
        }
        assert!(!obs.registry.contains(&retail));
        // Bot: direct pool swaps (weight 5) x2 = 10 >= 9 → promoted.
        obs.observe(&mk(bot, true));
        obs.observe(&mk(bot, true));
        assert!(obs.registry.contains(&bot));
        let disc = dir.join("BSC").join("_discovered.jsonl");
        // Discovery events are persisted by the async writer too.
        obs.shutdown_writer();
        let mut found = String::new();
        for _ in 0..50 {
            if let Ok(b) = std::fs::read_to_string(&disc) {
                found = b;
                if !found.is_empty() {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(found.contains("0x8888888888888888888888888888888888888888"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn strategy_lifecycle_promote_cover_expire() {
        let dir = std::env::temp_dir().join(format!("leaders_test_{:?}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("BSC")).unwrap();
        let cwd = std::env::current_dir().unwrap();
        std::env::set_current_dir(&dir).unwrap();

        let mut reg = StrategyRegistry::load("BSC", 100);
        let th = PromoteThresholds { min_net_usd: 50.0, min_txs: 2, min_win_rate: 0.5 };
        // Below thresholds → stays Observe.
        let (s, _) = reg.upsert_evidence(
            "0xaaa", "bundle_backrunner", 30.0, 1, 0.4, 20.0, "0xexec",
            vec!["0xpool1".into()], 1000, &th);
        assert_eq!(s, StrategyState::Observe);
        // Meets thresholds → promoted to Replay.
        let (s, _) = reg.upsert_evidence(
            "0xbbb", "bundle_backrunner", 500.0, 5, 0.8, 120.0, "0xexec",
            vec!["0xpool1".into(), "0xpool2".into()], 1000, &th);
        assert_eq!(s, StrategyState::Replay);
        // Full route coverage → Shadow.
        reg.mark_coverage("0xbbb", "bundle_backrunner", 1.0);
        assert_eq!(reg.records["0xbbb/bundle_backrunner"].state, StrategyState::Shadow);
        // Bounded live needs sim verification + cap. Unverified is refused.
        assert!(!reg.approve_bounded_live("0xbbb/bundle_backrunner", 250.0));
        assert!(reg.mark_verified("0xbbb/bundle_backrunner", 42.0, 25.0));
        assert_eq!(reg.records["0xbbb/bundle_backrunner"].state, StrategyState::BoundedLive);
        assert!(reg.records["0xbbb/bundle_backrunner"].sim_verified);
        // Stale record expires past ttl.
        let (s, _) = reg.upsert_evidence(
            "0xccc", "atomic_arb", 90.0, 3, 1.0, 30.0, "",
            vec![], 900, &th);
        assert_eq!(s, StrategyState::Replay);
        let expired = reg.expire_stale(1200);
        assert!(expired.contains(&"0xccc/atomic_arb".to_string()));
        // Persist + reload keeps records.
        reg.save().unwrap();
        StrategyRegistry::save_cursor("BSC", 1234).unwrap();
        let reloaded = StrategyRegistry::load("BSC", 100);
        assert!(reloaded.records.contains_key("0xbbb/bundle_backrunner"));
        assert_eq!(StrategyRegistry::load_cursor("BSC"), Some(1234));

        std::env::set_current_dir(cwd).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    fn pending_for(addr: alloy_primitives::Address) -> PendingSwap {
        PendingSwap {
            tx_hash: B256::ZERO,
            from: addr,
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
        }
    }

    #[test]
    fn queue_saturation_drops_without_blocking() {
        // Phase-4: a saturated writer queue must drop observations — never
        // block the execution path — and count each drop.
        let chain = "TSTSAT";
        let cfg = cfg_one("0x4444444444444444444444444444444444444444");
        let (obs, _rx_held_undrained) =
            LeaderObserver::new_with_queue(LeaderRegistry::new(&cfg), chain, 2);
        let pending =
            pending_for(address!("4444444444444444444444444444444444444444"));
        let before = LEADER_QUEUE_DROPPED.with_label_values(&[chain]).get();
        let t0 = std::time::Instant::now();
        for _ in 0..6 {
            obs.observe(&pending);
        }
        let elapsed = t0.elapsed();
        let after = LEADER_QUEUE_DROPPED.with_label_values(&[chain]).get();
        // 6 observations into a cap-2 queue: ≥4 drops, counted — and the
        // loop returning at all proves observe never blocks.
        assert!(after - before >= 4, "expected ≥4 drops, got {}", after - before);
        assert!(
            elapsed.as_millis() < 500,
            "observe blocked for {:?} under queue saturation",
            elapsed
        );
    }

    #[test]
    fn disconnected_writer_errors_without_blocking() {
        // Phase-4: a dead writer must surface as counted errors, not a stall.
        let chain = "TSTDIS";
        let cfg = cfg_one("0x4444444444444444444444444444444444444444");
        let (obs, rx) =
            LeaderObserver::new_with_queue(LeaderRegistry::new(&cfg), chain, 2);
        drop(rx); // simulate writer thread death
        let pending =
            pending_for(address!("4444444444444444444444444444444444444444"));
        let before = LEADER_WRITE_ERRORS.with_label_values(&[chain]).get();
        obs.observe(&pending);
        let after = LEADER_WRITE_ERRORS.with_label_values(&[chain]).get();
        assert!(after > before, "disconnected writer not counted as error");
    }
}
