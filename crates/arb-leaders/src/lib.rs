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
use std::sync::{Mutex, RwLock};
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

/// Writes observations to `data/leaders/<chain>/<wallet>.jsonl` and —
    /// when `[leaders] discover = true` — scores every sender in the stream
    /// to find top wallets autonomously.
pub struct LeaderObserver {
    registry: std::sync::Arc<LeaderRegistry>,
    discoverer: Option<LeaderDiscoverer>,
    dir: PathBuf,
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
        let discoverer = discover_cfg.discover.then(|| {
            LeaderDiscoverer::new(
                std::sync::Arc::clone(&registry),
                data_dir.clone(),
                chain.clone(),
                discover_cfg.discover_min_score,
                discover_cfg.discover_min_observations,
                discover_cfg.discover_max_wallets,
                discover_cfg.discover_halflife_secs,
            )
        });
        Self { registry, discoverer, dir: data_dir, chain }
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

    /// Hot-path call on every decoded pending swap. Feeds the discovery
    /// scorer first (when enabled), then O(1) registry lookup — returns
    /// immediately when `from` is not a registered leader.
    pub fn observe(&self, pending: &PendingSwap) {
        let t0 = std::time::Instant::now();
        if let Some(d) = &self.discoverer {
            d.track(pending);
        }
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
    dir: PathBuf,
    chain: String,
    min_score: f64,
    min_observations: u32,
    max_wallets: usize,
    halflife_secs: f64,
}

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
        dir: PathBuf,
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
            dir,
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
            let count = callees.entry((from, pending.to)).or_insert((0u32, now));
            // expire stale callee entries cheaply
            count.1 = now;
            count.0 += 1;
            if count.0 >= 2 {
                w = 4.0; // repeat_opaque — comparable to tracked_pool_trade
            }
        }

        let promote = {
            let mut map = self.stats.lock().unwrap();
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
        let _ = self.persist_event(&ev);
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

    fn persist_event(&self, ev: &DiscoveryEvent) -> std::io::Result<()> {
        let dir = self.dir.join(&self.chain);
        create_dir_all(&dir)?;
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("_discovered.jsonl"))?;
        let mut line = serde_json::to_vec(ev).unwrap_or_default();
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
        assert!(std::fs::read_to_string(&disc)
            .unwrap()
            .contains("0x8888888888888888888888888888888888888888"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
