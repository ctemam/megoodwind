//! Pre-built feed lane — the ToR engine: ingest aggregated GeckoTerminal
//! spreads over REST instead of raw mempool scanning.
//!
//! Pipeline per ToR:
//!   1. Ingest: `GET /api/v2/networks/<net>/pools` → the network's top
//!      pools in ONE call (per-token endpoints cost one call per token and
//!      exceed GT's ~30 req/min free rate across three chains).
//!   2. Filter: DEX-only (DEX id maps to V2/V3 AMMs only), liquidity floor,
//!      min h1 activity, and group by (base,quote) so cross-pool spreads are
//!      only ever compared between identical asset pairs.
//!   3. Verify: hot-register both pools with the state refresher, pull
//!      fresh on-chain state, re-sim the round trip at flash size locally.
//!   4. Execute: `executeV4Arbitrage` calldata → eth_call probe → sponsored
//!      UserOp via the venue router. Last hop minOut = flash_amount so a
//!      decayed spread reverts rather than losing money.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use alloy::providers::Provider;
use alloy::sol;
use alloy_primitives::{address, Address, Bytes, U256};
use alloy_sol_types::SolCall;
use serde::Deserialize;
use tracing::{info, warn};

use arb_core::opportunity::{
    ActionableOpportunity, ExecutionStatus, SimulationStatus,
};
use arb_core::types::{PoolState, Protocol};
use arb_core::AmmQuoter;
use arb_paths::{HopTemplate, PathTemplate};
use arb_rpc::Endpoint;
use arb_sim::optimize::path_max_flash;
use arb_sim::{evaluate_path, find_optimal_amount};
use arb_state::refresher::PoolConfig;
use arb_state::{PoolStore, StateRefresher};
use arb_submit::builder::{
    executeV4ArbitrageCall, PoolKey, SwapInstruction,
};
use arb_submit::router::VenueRouter;
use arb_submit::{Bundle, UserOpCall};

use crate::config::FeedConfig;
use crate::metrics;

/// Everything the lane needs, bundled so `spawn` stays readable.
pub struct FeedArgs {
    pub cfg: FeedConfig,
    pub chain: String,
    pub chain_id: u64,
    pub endpoint: Arc<Endpoint>,
    pub refresher: Arc<StateRefresher>,
    pub store: Arc<PoolStore>,
    pub router: Arc<VenueRouter>,
    pub arb_contract: Address,
    /// Smart account that will msg.sender the executor via UserOp.
    pub account: Option<Address>,
    /// Allowed flash assets, addr -> (usd_price, decimals).
    pub flash_quotes: HashMap<Address, (f64, u8)>,
    /// Extra tokens to ingest pools for ([feed].tokens resolved) — the
    /// mid assets that form (mid,quote) pair groups a borrow-only fetch
    /// can't see. Unioned with flash_quotes in the DS call.
    pub feed_tokens: Vec<Address>,
    /// addr -> usd price for P&L bookkeeping (flash assets + majors).
    pub token_usd_prices: HashMap<Address, f64>,
    /// USD price of the chain's native gas token — symbol-resolved in
    /// run(), never "the most expensive tracked token".
    pub native_usd: f64,
    /// Tokens the safety screen flagged — a pair touching one is dropped.
    pub blocked: HashSet<Address>,
    /// data/leaders/<chain> — opportunities land in _opportunities.jsonl.
    pub data_dir: String,
    /// Lanes kill switch AND scanner.dry_run must both permit real submits.
    pub submit_enabled: bool,
}

// ---- GeckoTerminal response model ---------------------------------------

#[derive(Debug, Deserialize)]
struct GtRel {
    data: Option<GtRelData>,
}

#[derive(Debug, Deserialize)]
struct GtRelData {
    id: String, // "bsc_0x..." / "pancakeswap-v3-bsc"
}

#[derive(Debug, Deserialize)]
struct GtRels {
    base_token: Option<GtRel>,
    quote_token: Option<GtRel>,
    dex: Option<GtRel>,
}

#[derive(Debug, Deserialize)]
struct GtBuySell {
    #[serde(default)]
    buys: u64,
    #[serde(default)]
    sells: u64,
}

#[derive(Debug, Deserialize)]
struct GtTxns {
    h1: Option<GtBuySell>,
}

#[derive(Debug, Deserialize)]
struct GtAttrs {
    address: String,
    #[serde(default)]
    name: String,
    reserve_in_usd: Option<String>,
    base_token_price_quote_token: Option<String>,
    #[serde(default)]
    transactions: Option<GtTxns>,
}

#[derive(Debug, Deserialize)]
struct GtPool {
    attributes: GtAttrs,
    relationships: Option<GtRels>,
}

/// A pool normalized to pair terms: `price` = base units of quote per base
/// (i.e. base-token price denominated in the quote asset).
/// `proto` is None when the feed carried no usable version signal — the
/// pool gets ONE on-chain interface probe (slot0/getReserves) downstream
/// rather than a guessed interface or a silent drop.
struct NormPool {
    pool: Address,
    proto: Option<Protocol>,
    base: Address,
    quote: Address,
    /// base-token price denominated in the quote asset.
    price: f64,
    liquidity_usd: f64,
    h1_txns: u64,
    /// GT pool name minus the fee tail, e.g. "CAKE / WBNB".
    pair_label: String,
    /// GT dex id, e.g. "pancakeswap-v3-bsc".
    dex: String,
}

impl GtPool {
    fn normalize(&self) -> Option<NormPool> {
        let a = &self.attributes;
        let pool: Address = a.address.parse().ok()?;
        let rel = self.relationships.as_ref()?;
        let base_id = rel.base_token.as_ref()?.data.as_ref()?.id.as_str();
        let quote_id = rel.quote_token.as_ref()?.data.as_ref()?.id.as_str();
        let base: Address = base_id.split('_').nth(1)?.parse().ok()?;
        let quote: Address = quote_id.split('_').nth(1)?.parse().ok()?;
        let dex = rel
            .dex
            .as_ref()
            .and_then(|d| d.data.as_ref())
            .map(|d| d.id.as_str())
            .unwrap_or("");
        let proto = match classify_dex(dex, &a.name) {
            DexKind::Unsupported => return None,
            DexKind::Proto(p) => Some(p),
            DexKind::Unknown => None,
        };
        let price: f64 = a.base_token_price_quote_token.as_deref()?.parse().ok()?;
        if price <= 0.0 || !price.is_finite() {
            return None;
        }
        let liquidity_usd = a
            .reserve_in_usd
            .as_deref()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        let h1_txns = a
            .transactions
            .as_ref()
            .and_then(|t| t.h1.as_ref())
            .map(|h| h.buys + h.sells)
            .unwrap_or(0);
        // "CAKE / WBNB 0.25%" → "CAKE / WBNB": drop the fee suffix.
        let pair_label = match a.name.rsplit(' ').next() {
            Some(t) if t.ends_with('%') => {
                a.name.rsplit_once(' ').map(|(h, _)| h.to_string()).unwrap_or_else(|| a.name.clone())
            }
            _ => a.name.clone(),
        };
        Some(NormPool {
            pool,
            proto,
            base,
            quote,
            price,
            liquidity_usd,
            h1_txns,
            pair_label,
            dex: dex.to_string(),
        })
    }
}

/// Tri-state DEX classification. `Proto` = feed carried a usable version
/// signal; `Unsupported` = an interface our executor can't drive (dropped);
/// `Unknown` = no signal at all — DexScreener ships ~40% of rows with no
/// `labels`, including every `dexId:"uniswap"` pool (verified 2026-10-06:
/// 23/23 such pools on BSC are live V3, ~$37M liquidity the lane used to
/// drop at ingest). Unknown rows go to the on-chain interface sniff.
enum DexKind {
    Proto(Protocol),
    Unknown,
    Unsupported,
}

/// DEX id / pool name → AMM interface guess, or a marker for the chain
/// probe. Anything not matching the V2 or V3 swap interface is a
/// non-atomic venue for our executor — dropped.
fn classify_dex(dex_id: &str, name: &str) -> DexKind {
    let d = dex_id.to_ascii_lowercase();
    // Explicitly unsupported interfaces first — mislabeled protocol means a
    // guaranteed exec revert.
    // Only interfaces a probe can provably never classify are dropped —
    // clmm/stable/curve/dodo/wombat/v4 have no globalState/slot0/
    // getReserves to answer. The algebra-family ids (algebra/thena/
    // integral/ramses/velodrome/solidly) are NOT here: measured live,
    // "ramses" pools on Polygon and unlabeled "uniswap" on BSC are real
    // slot0-answering V3 deployments — the chain probe decides.
    if d.contains("clmm") || d.contains("stable") || d.contains("curve")
        || d.contains("dodo") || d.contains("wombat") || d.contains("v4")
    {
        return DexKind::Unsupported;
    }
    if d.contains("v3") || (name.contains('%') && d.contains("uniswap")) {
        return DexKind::Proto(Protocol::UniswapV3);
    }
    if d.contains("v2")
        || d.contains("pancakeswap")
        || d.contains("sushiswap")
        || d.contains("quickswap")
        || d.contains("apeswap")
        || d.contains("biswap")
        || d.contains("nomiswap")
        || d.contains("babyswap")
        || d.contains("mdex")
        || d.contains("shibaswap")
        || d.contains("traderjoe")
    {
        return DexKind::Proto(Protocol::UniswapV2);
    }
    // Algebra-family ids (Algebra/Thena/Integral + V3-style forks like
    // ramses/velodrome/solidly): never guess — the probe triplet
    // (globalState/slot0/getReserves) classifies them on-chain. Guessing
    // V3 for an Algebra pool misreads its dynamic fee.
    if d.contains("algebra") || d.contains("thena") || d.contains("integral")
        || d.contains("ramses") || d.contains("velodrome") || d.contains("solidly")
    {
        return DexKind::Unknown;
    }
    // Unversioned dex ids ("uniswap-bsc", ...): a fee% in the pool name
    // means concentrated-liquidity V3; anything else is unknown — probe
    // the contract interface on-chain instead of dropping coverage.
    if name.contains('%') {
        DexKind::Proto(Protocol::UniswapV3)
    } else {
        DexKind::Unknown
    }
}

// ---- DexScreener response model ------------------------------------------
// Second ingest source — DS free tier is ~300 req/min per IP (vs GT's ~30)
// and /token-pairs returns EVERY pool for a token, not the top-N tail GT
// pages cover. Runs alongside GT so a saturated-IP 429 on one host never
// stalls coverage.

#[derive(Debug, Deserialize)]
struct DsToken {
    address: String,
    #[serde(default)]
    symbol: String,
}

#[derive(Debug, Deserialize)]
struct DsLiq {
    usd: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct DsTxns {
    h1: Option<GtBuySell>,
}

#[derive(Debug, Deserialize)]
struct DsPair {
    #[serde(rename = "pairAddress")]
    pair_address: String,
    #[serde(rename = "dexId", default)]
    dex_id: String,
    #[serde(rename = "baseToken")]
    base_token: DsToken,
    #[serde(rename = "quoteToken")]
    quote_token: DsToken,
    /// base token price denominated in quote token — same convention as
    /// GT's base_token_price_quote_token.
    #[serde(rename = "priceNative")]
    price_native: Option<String>,
    liquidity: Option<DsLiq>,
    txns: Option<DsTxns>,
    /// e.g. ["v3"] — the ONLY reliable version signal: dexId is just
    /// "pancakeswap" for both v2 and v3 pools (verified live).
    #[serde(default)]
    labels: Option<Vec<String>>,
}

impl DsPair {
    fn normalize(&self) -> Option<NormPool> {
        let pool: Address = self.pair_address.parse().ok()?;
        let base: Address = self.base_token.address.parse().ok()?;
        let quote: Address = self.quote_token.address.parse().ok()?;
        // Nomiswap on BSC is the documented bait family — quotes look fine
        // but the swap leg reverts on-chain (live: 18 probe deaths). The
        // DS rows carry no version label either, so there is no safe
        // read here; drop at ingest.
        if self.dex_id.eq_ignore_ascii_case("nomiswap") {
            return None;
        }
        // Version comes from labels[] — dexId alone lies ("pancakeswap"
        // covers v2 AND v3; mislabeled protocol = guaranteed exec revert).
        let has = |tag: &str| {
            self.labels
                .as_ref()
                .map(|l| l.iter().any(|t| t.eq_ignore_ascii_case(tag)))
                .unwrap_or(false)
        };
        // Version comes from labels[] — dexId alone lies. With no labels
        // the pool goes to the on-chain interface probe rather than being
        // dropped or guessed (measured: unlabeled "uniswap" on BSC = real
        // UniV3; "ramses" on Polygon answers slot0).
        let proto = if has("v3") {
            Some(Protocol::UniswapV3)
        } else if has("v2") || has("v1") {
            Some(Protocol::UniswapV2)
        } else {
            match classify_dex(&self.dex_id, "") {
                DexKind::Unsupported => return None,
                DexKind::Proto(p) => Some(p),
                DexKind::Unknown => None,
            }
        };
        let price: f64 = self.price_native.as_deref()?.parse().ok()?;
        if price <= 0.0 || !price.is_finite() {
            return None;
        }
        Some(NormPool {
            pool,
            proto,
            base,
            quote,
            price,
            liquidity_usd: self
                .liquidity
                .as_ref()
                .and_then(|l| l.usd)
                .unwrap_or(0.0),
            h1_txns: self
                .txns
                .as_ref()
                .and_then(|t| t.h1.as_ref())
                .map(|h| h.buys + h.sells)
                .unwrap_or(0),
            pair_label: format!("{} / {}", self.base_token.symbol, self.quote_token.symbol),
            dex: self.dex_id.clone(),
        })
    }
}

/// Fetch every pool trading `token` on this chain from DexScreener.
/// Errors and 429s degrade to an empty list — GT results still apply.
/// NOTE: `/tokens/v1/{chain}/{a,b,c}` is the WRONG endpoint here — it
/// returns only the single top pair per token (5 rows for 5 tokens on
/// Ethereum, all already covered by GT). `/token-pairs/v1` returns the
/// full pool set for ONE token, so we call it per token.
async fn ds_fetch_token_pools(
    client: &reqwest::Client,
    chain_slug: &str,
    token: Address,
) -> Vec<DsPair> {
    let url = format!(
        "https://api.dexscreener.com/token-pairs/v1/{chain_slug}/{token}"
    );
    let Ok(resp) = client.get(&url).send().await else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    resp.json::<Vec<DsPair>>().await.unwrap_or_default()
}

/// Directional candidate: borrow `borrow`, swap it to `mid` on `pool_in`,
/// swap back on `pool_out`, repay.
struct FeedCandidate {
    borrow: Address,
    mid: Address,
    pool_in: Address,
    proto_in: Protocol,
    pool_out: Address,
    proto_out: Protocol,
    spread_bps: f64,
    min_liquidity_usd: f64,
    /// Display context mirrored from the feed row.
    pair_label: String,
    dex_in: String,
    dex_out: String,
    price_lo: f64,
    price_hi: f64,
    h1_min: u64,
}

pub fn spawn(args: FeedArgs) -> tokio::task::JoinHandle<()> {
    info!(
        chain = %args.chain,
        quotes = args.flash_quotes.len(),
        submit = args.submit_enabled,
        "feed lane armed — GeckoTerminal network scan"
    );
    tokio::spawn(run(args))
}

async fn run(args: FeedArgs) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "feed lane: http client failed to build");
            return;
        }
    };
    // GT network slugs differ from chain names.
    let slug = match args.chain.to_ascii_lowercase().as_str() {
        "ethereum" | "eth" => "eth".to_string(),
        "polygon" | "matic" => "polygon_pos".to_string(),
        "bsc" | "bnb" => "bsc".to_string(),
        "base" => "base".to_string(),
        other => other.to_string(),
    };
    // Pages 1-3 cover ~top-300 pools — spreads live in the mid-liquidity
    // tail that page 1 alone never sees. Fetches are staggered inside the
    // cycle (~4s apart) to stay under the free rate limit.
    let urls: Vec<String> = (1..=3)
        .map(|p| {
            format!("https://api.geckoterminal.com/api/v2/networks/{slug}/pools?page={p}")
        })
        .collect();
    let mut next_id: u32 = 0xF00D;
    // On-chain interface probe hits — a pool's AMM interface is
    // immutable. Misses are NOT cached: they re-probe next cycle so a
    // transport failure can't permanently drop a pool.
    let mut sniffed: HashMap<Address, Protocol> = HashMap::new();
    // Pools that reverted at exec — suppressed for 1h after 2 strikes.
    let mut suppressed: HashMap<Address, (u32, Instant)> = HashMap::new();
    // pool -> QuoterV2 deployment that answers for it (None = every known
    // quoter reverted — non-UniV3-factory V3 pool, skip the check).
    let mut v3_quoter_cache: HashMap<Address, Option<Address>> = HashMap::new();
    // (borrow, pool_in, pool_out) re-eval cooldown.
    let mut cooldown: HashMap<(Address, Address, Address), Instant> = HashMap::new();
    // Pools already pushed into the refresher config.
    let mut registered: HashSet<Address> = HashSet::new();

    // GT's free rate limit is per-IP (~30 req/min) and the shared egress IP
    // is often saturated by other tenants — treat 429 as a paced sleep, not
    // a retry storm.
    let mut rl_sleep = Duration::from_secs(30);
    loop {
        let mut pools: Vec<GtPool> = Vec::new();
        for (i, url) in urls.iter().enumerate() {
            if i > 0 {
                // ~4s between page fetches → ≤9 req/min across 3 chains.
                tokio::time::sleep(Duration::from_secs(4)).await;
            }
            match fetch(&client, url).await {
                FetchOutcome::Ok(mut p) => {
                    rl_sleep = Duration::from_secs(30);
                    pools.append(&mut p);
                }
                FetchOutcome::RateLimited(after) => {
                    metrics::FEED_REJECTS
                        .with_label_values(&[&args.chain, "rate_limited"])
                        .inc();
                    if pools.is_empty() {
                        // +jitter so the three chain lanes don't hammer
                        // in lockstep.
                        let jitter = (std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.subsec_millis() % 5000)
                            .unwrap_or(0)) as u64;
                        tokio::time::sleep(
                            after.max(rl_sleep) + Duration::from_millis(jitter),
                        )
                        .await;
                        rl_sleep =
                            (rl_sleep * 2).min(Duration::from_secs(240));
                        break;
                    }
                    // Partial coverage is still useful — evaluate what we
                    // got and let the next cycle retry deeper pages.
                    break;
                }
                FetchOutcome::Fail => {
                    metrics::FEED_REJECTS
                        .with_label_values(&[&args.chain, "fetch"])
                        .inc();
                    break;
                }
            }
        }
        // Normalize GT rows, dedup by pool address.
        let mut seen: HashSet<Address> = HashSet::new();
        let mut norm: Vec<NormPool> = Vec::new();
        for raw in &pools {
            if let Some(p) = raw.normalize() {
                if seen.insert(p.pool) {
                    norm.push(p);
                }
            }
        }
        let gt_norm = norm.len();

        // DexScreener token-pairs ingest — one call per flash quote covers
        // every pool for that token on the chain, not just GT's top-N tail.
        // ~250ms stagger is far under DS's ~300 req/min; a different host,
        // so a saturated-IP GT 429 can't starve the lane.
        let ds_slug: &str = match args.chain_id {
            56 => "bsc",
            1 => "ethereum",
            137 => "polygon",
            8453 => "base",
            _ => &slug,
        };
        // Pools convicted anywhere (classic/backrun exec probes, bait gate)
        // are off-limits here too — re-read the persisted list each cycle
        // so fresh convictions land without a restart.
        let bait_set: HashSet<Address> = std::fs::read_to_string(format!(
            "{}/_bait_pools.json",
            args.data_dir
        ))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("pools").and_then(|a| a.as_array()).cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    e.get("pool")
                        .and_then(|p| p.as_str())
                        .and_then(|p| p.parse::<Address>().ok())
                })
                .collect()
        })
        .unwrap_or_default();
        norm.retain(|p| !bait_set.contains(&p.pool));

        // Borrow assets + [feed].tokens mid assets — the mids are what make
        // (mid,quote) groups form across DEXes, not just (quote,quote).
        let mut ingest: Vec<Address> = args.flash_quotes.keys().copied().collect();
        for t in &args.feed_tokens {
            if !ingest.contains(t) {
                ingest.push(*t);
            }
        }
        // One request per ingest token in parallel — 5-6 calls vs the
        // 300/min budget is nothing, and the cycle stays fast.
        let mut ds_added = 0u64;
        let fetches = ingest
            .iter()
            .map(|t| ds_fetch_token_pools(&client, ds_slug, *t));
        for pairs in futures::future::join_all(fetches).await {
            for dp in &pairs {
                if let Some(p) = dp.normalize() {
                    if bait_set.contains(&p.pool) {
                        continue;
                    }
                    if seen.insert(p.pool) {
                        ds_added += 1;
                        norm.push(p);
                    }
                }
            }
        }
        metrics::FEED_INGESTED
            .with_label_values(&[&args.chain, "gt"])
            .inc_by(gt_norm as f64);
        metrics::FEED_INGESTED
            .with_label_values(&[&args.chain, "ds"])
            .inc_by(ds_added as f64);

        if norm.is_empty() {
            tokio::time::sleep(Duration::from_secs(args.cfg.interval_secs.max(5))).await;
            continue;
        }
        metrics::FEED_SCANNED.with_label_values(&[&args.chain]).inc();

        // Step 2 — rigid filters; group by (base, quote) pair parity.
        let mut filtered: Vec<NormPool> = Vec::new();
        for p in norm {
            if args.blocked.contains(&p.base) || args.blocked.contains(&p.quote) {
                metrics::FEED_REJECTS
                    .with_label_values(&[&args.chain, "token_blocked"])
                    .inc();
                continue;
            }
            if p.liquidity_usd < args.cfg.min_liquidity_usd {
                metrics::FEED_REJECTS
                    .with_label_values(&[&args.chain, "liquidity"])
                    .inc();
                continue;
            }
            if p.h1_txns < args.cfg.min_h1_txns {
                metrics::FEED_REJECTS
                    .with_label_values(&[&args.chain, "inactive"])
                    .inc();
                continue;
            }
            if !args.flash_quotes.contains_key(&p.base)
                && !args.flash_quotes.contains_key(&p.quote)
            {
                metrics::FEED_REJECTS
                    .with_label_values(&[&args.chain, "no_flash_asset"])
                    .inc();
                continue; // neither side is a flash asset — can't borrow
            }
            filtered.push(p);
        }

        // Interface probe: filtered rows with no feed version signal get
        // ONE batched aggregate3 — globalState/slot0/getReserves,
        // allowFailure, most-specific-wins (Algebra > V3 > V2) — the
        // industry-standard way to resolve unlabeled AMMs. Measured live:
        // ~36-53 liquid pools/chain/cycle sat in this coverage gap, ~97%
        // answer a supported interface. Only classifications are cached:
        // a miss re-probes next cycle so transport failure can't
        // permanently drop a pool (interfaces are immutable anyway).
        {
            let addrs: Vec<Address> = filtered
                .iter()
                .filter(|p| p.proto.is_none() && !sniffed.contains_key(&p.pool))
                .map(|p| p.pool)
                .collect();
            if let Some(hits) = args.refresher.probe_interfaces(&addrs).await {
                for (a, proto) in hits {
                    sniffed.insert(a, proto);
                }
            }
            let mut admitted = 0u64;
            for p in &mut filtered {
                if p.proto.is_none() {
                    if let Some(proto) = sniffed.get(&p.pool) {
                        p.proto = Some(*proto);
                        admitted += 1;
                    }
                }
            }
            if admitted > 0 {
                metrics::FEED_INGESTED
                    .with_label_values(&[&args.chain, "probed"])
                    .inc_by(admitted as f64);
                info!(
                    chain = %args.chain,
                    admitted,
                    "feed: interface-probe admitted previously-invisible pools"
                );
            }
        }
        let mut by_pair: HashMap<(Address, Address), Vec<NormPool>> =
            HashMap::new();
        for p in filtered {
            if p.proto.is_none() {
                metrics::FEED_REJECTS
                    .with_label_values(&[&args.chain, "unknown_iface"])
                    .inc();
                continue;
            }
            // Canonical pair key — feeds disagree on (base,quote)
            // orientation for the same pair (DS lists WBNB/USDT where GT
            // lists USDT/WBNB); keying by the unordered token pair merges
            // the venue set instead of splitting the same pools across two
            // mirrored groups and double-simming them.
            by_pair
                .entry(canonical_pair_key(p.base, p.quote))
                .or_default()
                .push(p);
        }

        // Register + refresh every pool in a >=2-member pair group FIRST,
        // then gate on ON-CHAIN prices. Feeds are discovery only — their
        // price fields are CDN-cached and only measure staleness.
        {
            let mut gate_pools: Vec<Address> = Vec::new();
            let mut add: Vec<PoolConfig> = Vec::new();
            for group in by_pair.values() {
                if group.len() < 2 {
                    continue;
                }
                for p in group {
                    gate_pools.push(p.pool);
                    if registered.insert(p.pool) {
                        let Some(proto) = p.proto else { continue };
                        add.push(PoolConfig {
                            address: p.pool,
                            protocol: proto,
                            fee_bps: 0,
                            token0: None,
                            token1: None,
                        });
                    }
                }
            }
            if !add.is_empty() {
                args.refresher.add_pools(add);
            }
            args.refresher.refresh_pools(&args.store, &gate_pools).await;
        }

        // Collect candidates across all pair groups first — then ONE
        // merged gas read covers every verify in the cycle (same
        // two-pass discipline as the backrun lane; probes stay serial,
        // they need the account context and can't be batched).
        let mut todo: Vec<FeedCandidate> = Vec::new();
        let mut outlier_pools: Vec<Address> = Vec::new();
        for ((base, quote), mut group) in by_pair {
            if group.len() < 2 {
                continue;
            }
            // On-chain prices only — pools that failed refresh have no
            // state and can't participate in the gate.
            group.retain_mut(|p| {
                if let Some(op) = onchain_price(&args.store, p.pool, base, quote) {
                    p.price = op;
                    true
                } else {
                    false
                }
            });
            if group.len() < 2 {
                continue;
            }
            group.sort_by(|a, b| {
                a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal)
            });
            // One poisoned pool must not kill the whole pair group: while
            // the lo-hi spread sits above the suspect cap, drop the
            // endpoint farthest from the group median and re-evaluate the
            // clean subset. A pool diverging on live chain state is the
            // documented bait signature — it also goes on the persisted
            // exclusion list so other lanes stop seeing it.
            for dropped in trim_divergent(&mut group, args.cfg.max_spread_bps) {
                metrics::FEED_REJECTS
                    .with_label_values(&[&args.chain, "price_outlier"])
                    .inc();
                warn!(
                    pool = %dropped.pool,
                    dex = %dropped.dex,
                    pair = %dropped.pair_label,
                    price = dropped.price,
                    "feed: divergent pool excluded from pair group"
                );
                suppressed.insert(
                    dropped.pool,
                    (2, Instant::now() + Duration::from_secs(6 * 3600)),
                );
                outlier_pools.push(dropped.pool);
            }
            if group.len() < 2 {
                continue;
            }
            let lo_p = &group[0];
            let hi_p = group.last().unwrap();
            let spread_bps = (hi_p.price - lo_p.price) / lo_p.price * 10_000.0;
            // Fee-aware floor: a spread below the round-trip fee cost can
            // never clear min_net — gate on fees + net margin instead of a
            // flat bps, with min_spread_bps kept as an absolute noise floor.
            let required_bps = required_spread_bps(
                store_fee_bps(&args.store, lo_p.pool),
                store_fee_bps(&args.store, hi_p.pool),
                &args.cfg,
            );
            if spread_bps < required_bps {
                metrics::FEED_REJECTS
                    .with_label_values(&[&args.chain, "below_spread"])
                    .inc();
                continue;
            }
            if spread_bps > args.cfg.max_spread_bps {
                // >cap spreads on aggregated feeds are almost always
                // honeypot or dust-pool noise.
                metrics::FEED_REJECTS
                    .with_label_values(&[&args.chain, "spread_suspect"])
                    .inc();
                continue;
            }
            // Pick the borrow side: whichever of base/quote is a flash asset.
            // quote-borrow: buy base cheap (quote→base on lo), sell base dear.
            // base-borrow: sell base dear (base→quote on hi), buy base back cheap.
            let (Some(lo_proto), Some(hi_proto)) = (lo_p.proto, hi_p.proto)
            else {
                continue;
            };
            let cand = if args.flash_quotes.contains_key(&quote) {
                FeedCandidate {
                    borrow: quote,
                    mid: base,
                    pool_in: lo_p.pool,
                    proto_in: lo_proto,
                    pool_out: hi_p.pool,
                    proto_out: hi_proto,
                    spread_bps,
                    min_liquidity_usd: lo_p.liquidity_usd.min(hi_p.liquidity_usd),
                    pair_label: lo_p.pair_label.clone(),
                    dex_in: lo_p.dex.clone(),
                    dex_out: hi_p.dex.clone(),
                    price_lo: lo_p.price,
                    price_hi: hi_p.price,
                    h1_min: lo_p.h1_txns.min(hi_p.h1_txns),
                }
            } else {
                FeedCandidate {
                    borrow: base,
                    mid: quote,
                    pool_in: hi_p.pool,
                    proto_in: hi_proto,
                    pool_out: lo_p.pool,
                    proto_out: lo_proto,
                    spread_bps,
                    min_liquidity_usd: lo_p.liquidity_usd.min(hi_p.liquidity_usd),
                    pair_label: lo_p.pair_label.clone(),
                    dex_in: hi_p.dex.clone(),
                    dex_out: lo_p.dex.clone(),
                    price_lo: lo_p.price,
                    price_hi: hi_p.price,
                    h1_min: lo_p.h1_txns.min(hi_p.h1_txns),
                }
            };
            if suppressed
                .get(&cand.pool_in)
                .or_else(|| suppressed.get(&cand.pool_out))
                .map(|(_, until)| Instant::now() < *until)
                .unwrap_or(false)
            {
                metrics::FEED_REJECTS
                    .with_label_values(&[&args.chain, "pool_suppressed"])
                    .inc();
                continue;
            }
            let key = (cand.borrow, cand.pool_in, cand.pool_out);
            if cooldown
                .get(&key)
                .map(|t| t.elapsed() < Duration::from_secs(120))
                .unwrap_or(false)
            {
                continue;
            }
            metrics::FEED_CANDIDATES
                .with_label_values(&[&args.chain])
                .inc();
            cooldown.insert(key, Instant::now());
            todo.push(cand);
        }
        if !outlier_pools.is_empty() {
            persist_bait_pools(&args.data_dir, &outlier_pools);
        }

        if !todo.is_empty() {
            // Gate already registered + refreshed every pair-group pool.
            // Measured actualGasUsed on the first landed op = 1,276,435
            // (EntryPoint+verify+3-hop exec) — 1.3M keeps the floor honest.
            let gas_usd = match args.endpoint.gas_price().await {
                Ok(gp) => {
                    // 1.3M gas round trip (measured) × gas price × native
                    // price — max-priced tracked token is wrong (BTCB ~= 130x BNB).
                    gp as f64 * 1_300_000.0 / 1e18 * args.native_usd
                }
                Err(_) => 0.0,
            };
            for cand in &todo {
                let fails = verify_and_submit(
                    &args,
                    cand,
                    &mut next_id,
                    gas_usd,
                    &mut v3_quoter_cache,
                )
                .await;
                if let Some((pool, strikes)) = fails {
                    let (n, _) = suppressed
                        .get(&pool)
                        .copied()
                        .unwrap_or((0, Instant::now()));
                    let n = n + strikes;
                    if n >= 2 {
                        suppressed.insert(
                            pool,
                            (n, Instant::now() + Duration::from_secs(3600)),
                        );
                        warn!(pool = %pool, "feed lane suppressing reverting pool 1h");
                    } else {
                        suppressed.insert(
                            pool,
                            (n, Instant::now() + Duration::from_secs(60)),
                        );
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(args.cfg.interval_secs.max(5))).await;
    }
}


/// Canonical (base, quote) for pair grouping — ordered token pair so feeds
/// reporting opposite orientations for the same pool set land in one group.
fn canonical_pair_key(base: Address, quote: Address) -> (Address, Address) {
    if base <= quote {
        (base, quote)
    } else {
        (quote, base)
    }
}

/// Swap fee (bps) charged by a priced pool, straight from on-chain state.
/// V3/Algebra keep the fee in hundredths-of-a-bip raw units; V2/AeroV2 are
/// plain bps. Unpriced pools never reach the gate — the 30 bps default is
/// unreachable in practice.
fn store_fee_bps(store: &PoolStore, pool: Address) -> f64 {
    use arb_core::types::PoolState;
    match store.get(&pool) {
        Some(PoolState::V2(s)) => s.fee_bps as f64,
        Some(PoolState::V3(s)) => s.fee as f64 / 100.0,
        Some(PoolState::AeroV2(s)) => s.fee_bps as f64,
        _ => 30.0,
    }
}

/// Spread (bps) a candidate must exceed to clear economics by construction:
/// round-trip swap fees + the min-net margin at max notional, with
/// min_spread_bps kept as an absolute noise floor. A V2-V2 round trip at
/// 25+25 bps can never profit on a 40 bps spread — it used to pass the gate
/// and die at sim; now it dies honestly, one stage earlier.
fn required_spread_bps(fee_in: f64, fee_out: f64, cfg: &FeedConfig) -> f64 {
    let net_margin_bps = (cfg.min_net_usd / cfg.max_notional_usd * 10_000.0).max(1.0);
    cfg.min_spread_bps.max(fee_in + fee_out + net_margin_bps)
}

/// Pool price in "quote per base" raw units, computed from live pool
/// state — NOT the feed's CDN-cached `price_native`. Comparing two
/// API-reported prices across venues only measures relative staleness:
/// it fabricates spreads that die at fresh-state sim and hides real
/// ones that averaged out in the cache. The industry pattern is
/// feeds-for-discovery, chain-for-pricing.
fn onchain_price(store: &PoolStore, pool: Address, base: Address, quote: Address) -> Option<f64> {
    let st = store.get_ref(&pool)?;
    match &*st {
        arb_core::types::PoolState::V2(_) | arb_core::types::PoolState::AeroV2(_) => {
            let (token0, r0, r1) = match &*st {
                arb_core::types::PoolState::V2(s) => (s.token0, s.reserve0, s.reserve1),
                arb_core::types::PoolState::AeroV2(s) => (s.token0, s.reserve0, s.reserve1),
                _ => unreachable!(),
            };
            let r0: f64 = r0.try_into().map(|v: u128| v as f64).unwrap_or(0.0);
            let r1: f64 = r1.try_into().map(|v: u128| v as f64).unwrap_or(0.0);
            if r0 <= 0.0 || r1 <= 0.0 {
                return None;
            }
            if base == token0 {
                Some(r1 / r0) // quote per base
            } else {
                Some(r0 / r1)
            }
        }
        arb_core::types::PoolState::V3(s) => {
            if s.sqrt_price_x96.is_zero() {
                return None;
            }
            let sp: f64 = s
                .sqrt_price_x96
                .try_into()
                .map(|v: u128| v as f64)
                .unwrap_or(0.0);
            let p = (sp / 79228162514264337593543950336.0).powi(2);
            if !p.is_finite() || p <= 0.0 {
                return None;
            }
            // V3 sqrtP encodes token1-per-token0.
            if base == s.token0 {
                Some(p)
            } else {
                Some(1.0 / p)
            }
        }
        _ => None,
    }
}

/// Merge pools into the shared `data/leaders/<chain>/_bait_pools.json`
/// exclusion list (same shape runner.rs writes: {pool, until_block}).
/// 4e9 blocks is past every supported chain's horizon — effectively
/// permanent, matching the hard-conviction semantics of a pool diverging
/// on live chain state. Best-effort: a lost update just means the pool
/// is re-detected next cycle.
fn persist_bait_pools(data_dir: &str, new_pools: &[Address]) {
    let path = format!("{data_dir}/_bait_pools.json");
    let mut pools: Vec<serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("pools").and_then(|a| a.as_array()).cloned())
        .unwrap_or_default();
    let mut have: HashSet<String> = pools
        .iter()
        .filter_map(|e| {
            e.get("pool")
                .and_then(|p| p.as_str())
                .map(|s| s.to_ascii_lowercase())
        })
        .collect();
    for a in new_pools {
        let key = format!("{a:#x}");
        if have.insert(key.to_ascii_lowercase()) {
            pools.push(serde_json::json!({
                "pool": key,
                "until_block": 4_000_000_000u64,
            }));
        }
    }
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(&serde_json::json!({ "pools": pools }))
            .unwrap_or_default(),
    );
}

/// While a sorted-by-price group's lo-hi spread sits above `cap_bps`, drop
/// the endpoint farthest from the group median and re-evaluate the clean
/// subset. Stops at 2 members (a pair is the minimum viable candidate), so
/// an honest pool is never sacrificed to save a divergent one. Returns the
/// pools convicted as outliers, in drop order.
fn trim_divergent(group: &mut Vec<NormPool>, cap_bps: f64) -> Vec<NormPool> {
    let mut dropped = Vec::new();
    while group.len() > 2 {
        let lo = group.first().unwrap().price;
        let hi = group.last().unwrap().price;
        if (hi - lo) / lo * 10_000.0 <= cap_bps {
            break;
        }
        let median = group[group.len() / 2].price;
        let idx = if (median - lo).abs() >= (hi - median).abs() {
            0
        } else {
            group.len() - 1
        };
        dropped.push(group.remove(idx));
    }
    dropped
}

enum FetchOutcome {
    Ok(Vec<GtPool>),
    /// 429 — the arg is GT's Retry-After hint when present.
    RateLimited(Duration),
    Fail,
}

async fn fetch(client: &reqwest::Client, url: &str) -> FetchOutcome {
    let Ok(resp) = client.get(url).send().await else {
        return FetchOutcome::Fail;
    };
    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .map(Duration::from_secs)
            .unwrap_or(Duration::from_secs(30));
        return FetchOutcome::RateLimited(after);
    }
    if !resp.status().is_success() {
        return FetchOutcome::Fail;
    }
    let Ok(v) = resp.json::<serde_json::Value>().await else {
        return FetchOutcome::Fail;
    };
    match v.get("data").and_then(|d| serde_json::from_value(d.clone()).ok()) {
        Some(p) => FetchOutcome::Ok(p),
        None => FetchOutcome::Fail,
    }
}

sol! {
    // UniV3-periphery QuoterV2 — the industry-standard on-chain quoter.
    // Non-view by design: it runs the real multi-tick swap under eth_call and
    // returns the exact amountOut the pool would pay.
    interface IV3QuoterV2 {
        struct QuoteExactInputSingleParams {
            address tokenIn;
            address tokenOut;
            uint256 amountIn;
            uint24 fee;
            uint160 sqrtPriceLimitX96;
        }
        function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
            external
            returns (
                uint256 amountOut,
                uint160 sqrtPriceX96After,
                uint32 initializedTicksCrossed,
                uint256 gasEstimate
            );
    }
    // UniV3-fork factory — getPool resolves the create2 address a quoter
    // will price for (tokenA, tokenB, fee).
    interface IV3Factory {
        function getPool(address tokenA, address tokenB, uint24 fee)
            external
            view
            returns (address pool);
    }
}

/// (QuoterV2, its V3 factory) deployments per chain. A quoter silently
/// resolves the pool from ITS OWN factory's create2 — for a (tokens, fee)
/// tuple that also exists under another factory it would price the WRONG
/// pool. `v3_leg_out` therefore confirms `factory.getPool(tin, tout, fee)
/// == hop.pool` before trusting a quoter's answer.
pub(crate) fn v3_quoters(chain_id: u64) -> Vec<(Address, Address)> {
    match chain_id {
        56 => vec![
            (
                address!("B048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997"), // PCS V3 QuoterV2
                address!("0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"), // PCS V3 factory
            ),
            (
                address!("78D78E420Da98ad378D7799bE8f4AF69033EB077"), // UniV3 QuoterV2 (BSC)
                // its factory() reads back 0xdb1d…4461f7 — the community
                // UniV3-BSC deployment DS tags "uniswap", NOT the newer
                // canonical deploy at 0xdB1d…Ba9745.
                address!("db1d10011ad0ff90774d0c6bb92e5c5c8b4461f7"),
            ),
        ],
        // Canonical Uniswap v3 deployments share one address across chains.
        1 | 137 | 42161 | 10 => vec![(
            address!("61fFE014bA17989E743c5F6cB21bF9697530B21e"), // UniV3 QuoterV2
            address!("1F98431c8aD98523631AE4a59f267346ea31F984"), // UniV3 factory
        )],
        _ => vec![],
    }
}

async fn call_v3_quoter(
    endpoint: &Endpoint,
    quoter: Address,
    calldata: &[u8],
) -> Option<U256> {
    let req = alloy::rpc::types::TransactionRequest::default()
        .to(quoter)
        .input(Bytes::copy_from_slice(calldata).into());
    let raw = endpoint.provider().call(req).await.ok()?;
    IV3QuoterV2::quoteExactInputSingleCall::abi_decode_returns(&raw)
        .ok()
        .map(|r| r.amountOut)
}

/// Does `factory` derive `pool` for (token_in, token_out, fee)? The check
/// pins a quoter to the exact hop pool — a quoter for a foreign factory
/// would otherwise price a same-tokens-same-fee pool that isn't ours.
/// Returns None on transport failure — a timed-out call is not evidence
/// the pool isn't there, and must not poison the quoter cache.
async fn factory_owns_pool(
    endpoint: &Endpoint,
    factory: Address,
    pool: Address,
    fee: u32,
    token_in: Address,
    token_out: Address,
) -> Option<bool> {
    let calldata = IV3Factory::getPoolCall {
        tokenA: token_in,
        tokenB: token_out,
        fee: alloy_primitives::Uint::<24, 1>::from(fee),
    }
    .abi_encode();
    let req = alloy::rpc::types::TransactionRequest::default()
        .to(factory)
        .input(Bytes::from(calldata).into());
    let raw = endpoint.provider().call(req).await.ok()?;
    Some(
        IV3Factory::getPoolCall::abi_decode_returns(&raw)
            .map(|r| r == pool)
            .unwrap_or(false),
    )
}

/// One UniV3 leg's real output via eth_call to QuoterV2, at the chained
/// sim amount. `cache` maps pool -> the quoter that answered (or None when
/// every deployment reverted = pool isn't a UniV3-factory clone we know —
/// Algebra, Slipstream, Sushi V3 — the leg then stays local and the
/// revm exec-probe remains the gate).
pub(crate) async fn v3_leg_out(
    endpoint: &Arc<Endpoint>,
    chain_id: u64,
    cache: &mut HashMap<Address, Option<Address>>,
    pool: Address,
    fee: u32,
    token_in: Address,
    token_out: Address,
    amount_in: U256,
) -> Option<U256> {
    let params = IV3QuoterV2::QuoteExactInputSingleParams {
        tokenIn: token_in,
        tokenOut: token_out,
        amountIn: amount_in,
        fee: alloy_primitives::Uint::<24, 1>::from(fee),
        sqrtPriceLimitX96: alloy_primitives::Uint::<160, 3>::ZERO,
    };
    let calldata = IV3QuoterV2::quoteExactInputSingleCall { params }.abi_encode();
    match cache.get(&pool) {
        Some(&Some(q)) => return call_v3_quoter(endpoint, q, &calldata).await,
        Some(&None) => return None,
        None => {}
    }
    // Hits are cached; misses are NOT — a transport failure must not
    // permanently strip the on-chain check from a pool (same policy as
    // `sniffed`). Only a run where every factory definitively answered
    // "not mine" earns the None cache.
    let mut saw_transport_err = false;
    for (q, factory) in v3_quoters(chain_id) {
        match factory_owns_pool(endpoint, factory, pool, fee, token_in, token_out)
            .await
        {
            Some(true) => {
                if let Some(out) = call_v3_quoter(endpoint, q, &calldata).await {
                    cache.insert(pool, Some(q));
                    return Some(out);
                }
            }
            Some(false) => {}
            None => saw_transport_err = true,
        }
    }
    if !saw_transport_err {
        cache.insert(pool, None);
    }
    None
}

/// Re-quote the round trip with UniV3 legs priced on-chain: the local V3
/// quoter is a constant-L single-tick approximation and on thin pools it
/// overshoots real executable output far past its multi-tick haircut
/// (measured +196…+100445bps vs QuoterV2 on live BSC pairs). V2 legs keep
/// the local quote — constant-product is exact. Returns None when any
/// UniV3 leg can't be resolved on-chain, so callers fall through to the
/// exec-probe exactly as before.
async fn onchain_round_trip_out(
    args: &FeedArgs,
    path: &PathTemplate,
    cache: &mut HashMap<Address, Option<Address>>,
) -> Option<U256> {
    let mut amount = path.flash_amount;
    for hop in &path.hops {
        let v3 = match args.store.get_ref(&hop.pool) {
            Some(r) => match &*r {
                PoolState::V3(s) if hop.protocol == Protocol::UniswapV3 => {
                    Some(s.fee)
                }
                _ => None,
            },
            None => return None,
        };
        amount = match v3 {
            Some(fee) => {
                v3_leg_out(
                    &args.endpoint,
                    args.chain_id,
                    cache,
                    hop.pool,
                    fee,
                    hop.token_in,
                    hop.token_out,
                    amount,
                )
                .await?
            }
            None => {
                // Same zero-copy quote dispatch as evaluate_path.
                let pool_ref = args.store.get_ref(&hop.pool)?;
                match &*pool_ref {
                    PoolState::V2(s) => s.quote(hop.token_in, amount).ok()?,
                    PoolState::V3(s) => s.quote(hop.token_in, amount).ok()?,
                    PoolState::Curve(s) => s.quote(hop.token_in, amount).ok()?,
                    PoolState::Wombat(s) => {
                        s.quote(hop.token_in, amount).ok()?
                    }
                    PoolState::Dodo(s) => s.quote(hop.token_in, amount).ok()?,
                    PoolState::AeroV2(s) => {
                        s.quote(hop.token_in, amount).ok()?
                    }
                }
            }
        };
    }
    Some(amount)
}

/// Steps 3+4: local sim on the cycle's merged refresh → eth_call probe →
/// venue submit. `gas_usd` is the cycle-level gas estimate — pools were
/// already registered and refreshed once for all candidates.
/// Returns Some((pool, strikes)) when a pool should accrue a suppress strike.
async fn verify_and_submit(
    args: &FeedArgs,
    c: &FeedCandidate,
    next_id: &mut u32,
    gas_usd: f64,
    v3_quoter_cache: &mut HashMap<Address, Option<Address>>,
) -> Option<(Address, u32)> {
    let mut opp = ActionableOpportunity::new(
        &args.chain,
        "feed_geckoterminal",
        "geckoterminal_api",
        &format!("{}/{}", c.pool_in, c.pool_out),
        vec![format!("{}", c.pool_in), format!("{}", c.pool_out)],
    );
    opp.token_in = format!("{}", c.borrow);
    opp.token_out = format!("{}", c.mid);
    opp.profit_bps = c.spread_bps;
    // DEXScreener-mirrored feed context for the dashboard table.
    opp.feed_pair = c.pair_label.clone();
    opp.feed_dex_in = c.dex_in.clone();
    opp.feed_dex_out = c.dex_out.clone();
    opp.buy_pool = format!("{}", c.pool_in);
    opp.sell_pool = format!("{}", c.pool_out);
    opp.feed_price_lo = c.price_lo;
    opp.feed_price_hi = c.price_hi;
    opp.feed_liquidity_usd = c.min_liquidity_usd;
    opp.feed_h1_txns = c.h1_min;

    // Pools were registered and refreshed once for the whole cycle — a
    // pool that still lacks state fails the fresh-state sim below.

    // Size the flash: min(notional cap, share of the shallower pool's liq)
    // converted to borrow-token wei.
    let Some(&(borrow_usd, borrow_dec)) = args.flash_quotes.get(&c.borrow) else {
        return None;
    };
    let notional = args
        .cfg
        .max_notional_usd
        .min(c.min_liquidity_usd * args.cfg.pool_share_bps / 10_000.0);
    if notional <= 0.0 || borrow_usd <= 0.0 {
        return None;
    }
    let units = notional / borrow_usd;
    let flash_amount = U256::from(units as u128)
        .saturating_mul(U256::from(10u64).pow(U256::from(borrow_dec as u32)));

    let mut path = PathTemplate {
        id: *next_id,
        flash_token: c.borrow,
        flash_amount,
        hops: vec![
            HopTemplate {
                protocol: c.proto_in,
                pool: c.pool_in,
                token_in: c.borrow,
                token_out: c.mid,
            },
            HopTemplate {
                protocol: c.proto_out,
                pool: c.pool_out,
                token_in: c.mid,
                token_out: c.borrow,
            },
        ],
    };
    *next_id = next_id.wrapping_add(1);

    // Fixed notional both overshoots thin pools (impact eats the edge) and
    // undershoots deep ones — the arb profit curve is unimodal, so the
    // backrun lane's ternary optimizer finds the peak with µs-class local
    // quotes. Ceiling = min(notional cap, pool-share of token reserves);
    // floor = 0.01 borrow-token (below that, sim noise dominates).
    let floor = U256::from(10u64).pow(U256::from(borrow_dec.saturating_sub(2) as u32));
    let ceil = path_max_flash(
        &path,
        &args.store,
        args.cfg.pool_share_bps / 10_000.0,
        flash_amount,
    );
    if ceil > floor + U256::from(1u64) {
        if let Some((amt, _)) = find_optimal_amount(&path, &args.store, floor, ceil, 24) {
            path.flash_amount = amt;
        }
    }
    let flash_amount = path.flash_amount;

    // Step 3 — on-chain verification gateway: reserves/slot0 were just
    // re-read; evaluate the round trip on that fresh state.
    let Some(sim) = evaluate_path(&path, &args.store) else {
        opp.simulation_status = SimulationStatus::Fail;
        opp.rejection_reason = "fresh_sim_fail".into();
        let _ = opp.append_jsonl(&args.data_dir);
        metrics::FEED_VERIFIED
            .with_label_values(&[&args.chain, "sim_fail"])
            .inc();
        // The feed quoted a spread that doesn't exist on fresh chain
        // state — someone's reported price is stale or manipulated. A
        // strike against the buy leg: two repeat fake quotes suppress
        // the pool for an hour instead of re-verifying every cycle.
        return Some((c.pool_in, 1));
    };
    let gross_usd = (sim.gross_profit.to::<u128>() as f64)
        / 10f64.powi(borrow_dec as i32)
        * borrow_usd;
    opp.simulation_status = SimulationStatus::Pass;
    opp.allbright_net_usd = gross_usd;
    opp.flash_amount = flash_amount.to_string();
    metrics::FEED_VERIFIED
        .with_label_values(&[&args.chain, "pass"])
        .inc();

    // Step 4 — abort if gross can't cover gas (cycle-level estimate).
    opp.gas_usd = gas_usd;
    // Sponsored gas is still our cost — Pimlico bills actualGasCost to our
    // account balance on every landed op. The floor must cover it.
    let margin_usd = gas_usd;
    if gross_usd - margin_usd < args.cfg.min_net_usd {
        opp.rejection_reason = "negative_net_after_gas".into();
        let _ = opp.append_jsonl(&args.data_dir);
        metrics::FEED_REJECTS
            .with_label_values(&[&args.chain, "net_floor"])
            .inc();
        return None;
    }

    // Step 4b — on-chain truth for V3 legs. The local V3 quoter is a
    // constant-L single-tick approximation whose error blows past its
    // multi-tick haircut on thin pools (measured +196…+100445bps vs
    // QuoterV2 on live BSC pairs). Re-quote UniV3 legs on-chain at the
    // sim's chained amounts; if the real round trip can't cover min_net,
    // die here — one eth_call per V3 leg instead of a revm probe plus a
    // cooldown slot. No pool strike: the divergence is our model's error,
    // not the pool's. Legs whose factory has no known quoter stay local
    // and fall through to the exec-probe as before.
    if let Some(real_out) =
        onchain_round_trip_out(args, &path, v3_quoter_cache).await
    {
        let real_gross_usd = (real_out.saturating_sub(flash_amount).to::<u128>()
            as f64)
            / 10f64.powi(borrow_dec as i32)
            * borrow_usd;
        if real_gross_usd - margin_usd < args.cfg.min_net_usd {
            let sim_out = flash_amount + sim.gross_profit;
            let div_bps = if !real_out.is_zero() {
                (sim_out.to::<u128>() as f64 - real_out.to::<u128>() as f64)
                    / real_out.to::<u128>() as f64
                    * 1e4
            } else {
                f64::INFINITY
            };
            opp.simulation_status = SimulationStatus::Fail;
            opp.rejection_reason = "v3_quoter_divergence".into();
            let _ = opp.append_jsonl(&args.data_dir);
            metrics::FEED_REJECTS
                .with_label_values(&[&args.chain, "v3_quoter_divergence"])
                .inc();
            info!(
                chain = %args.chain,
                pair = %c.pair_label,
                div_bps,
                sim_net_usd = gross_usd - gas_usd,
                onchain_net_usd = real_gross_usd - gas_usd,
                "feed: rejected on QuoterV2 divergence"
            );
            return None;
        }
    }

    // Build the executor call — same executeV4Arbitrage entry point as the
    // bundle builder, but we only need the UserOp call (4337 path), not a
    // signed envelope.
    let zero_key = || PoolKey {
        currency0: Address::ZERO,
        currency1: Address::ZERO,
        fee: alloy_primitives::Uint::from(0u32),
        tickSpacing: alloy_primitives::Signed::<24, 1>::ZERO,
        hooks: Address::ZERO,
    };
    let instructions = vec![
        SwapInstruction {
            protocol: c.proto_in.to_contract_enum(args.chain_id),
            pool: c.pool_in,
            poolKey: zero_key(),
            tokenIn: c.borrow,
            tokenOut: c.mid,
            minOut: U256::ZERO,
        },
        SwapInstruction {
            protocol: c.proto_out.to_contract_enum(args.chain_id),
            pool: c.pool_out,
            poolKey: zero_key(),
            tokenIn: c.mid,
            tokenOut: c.borrow,
            minOut: flash_amount, // never repay-short: decayed spread reverts
        },
    ];
    let deadline = U256::from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
            + 120,
    );
    let calldata = executeV4ArbitrageCall {
        asset: c.borrow,
        amount: flash_amount,
        swapInstructions: instructions,
        deadline,
    }
    .abi_encode();

    // eth_call simulation before any broadcast.
    if let Some(account) = args.account {
        let probe = alloy::rpc::types::TransactionRequest::default()
            .from(account)
            .to(args.arb_contract)
            .input(Bytes::from(calldata.clone()).into());
        if args.endpoint.provider().call(probe).await.is_err() {
            opp.simulation_status = SimulationStatus::Fail;
            opp.rejection_reason = "exec_probe_revert".into();
            let _ = opp.append_jsonl(&args.data_dir);
            metrics::FEED_VERIFIED
                .with_label_values(&[&args.chain, "probe_revert"])
                .inc();
            // A probe revert at fresh state means one leg's pool rejected —
            // strike the entry pool first.
            return Some((c.pool_in, 1));
        }
    }

    if !args.submit_enabled {
        opp.execution_status = ExecutionStatus::Ready;
        let _ = opp.append_jsonl(&args.data_dir);
        info!(
            chain = %args.chain,
            pair = %c.pair_label,
            spread_bps = c.spread_bps,
            est_net_usd = gross_usd - gas_usd,
            "feed: shadow-ready opportunity (submit disabled)"
        );
        return None;
    }

    let bundle = Bundle {
        signed_txs: vec![],
        victim_tx: None,
        target_block: 0,
        chain_id: args.chain_id,
        backrun_tx: None,
        call: Some(UserOpCall {
            to: args.arb_contract,
            data: Bytes::from(calldata),
        }),
    };
    let results = args
        .router
        .submit_all(&bundle, false, Duration::ZERO)
        .await;
    let ok = results
        .iter()
        .any(|r| r.result.as_ref().map(|s| s.success).unwrap_or(false));
    if ok {
        metrics::FEED_SUBMITTED.with_label_values(&[&args.chain]).inc();
        opp.execution_status = ExecutionStatus::Submitted;
        info!(
            chain = %args.chain,
            pair = %c.pair_label,
            buy = %c.pool_in,
            sell = %c.pool_out,
            est_net_usd = gross_usd - gas_usd,
            "feed: arbitrage submitted"
        );
    } else {
        opp.execution_status = ExecutionStatus::Dropped;
        opp.rejection_reason = "venue_reject".into();
        metrics::FEED_REJECTS
            .with_label_values(&[&args.chain, "venue_reject"])
            .inc();
        let reverted = results.iter().any(|r| {
            r.result
                .as_ref()
                .map(|s| s.error.as_deref().unwrap_or("").contains("revert"))
                .unwrap_or(false)
        });
        if reverted {
            // Bundler sim revert → strike the exit pool; the fee model or
            // liquidity was wrong somewhere in the pair.
            return Some((c.pool_out, 1));
        }
    }
    let _ = opp.append_jsonl(&args.data_dir);
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ds_pair(dex_id: &str, labels: Option<Vec<&str>>) -> DsPair {
        DsPair {
            pair_address: "0x00000000000000000000000000000000000000aa".into(),
            dex_id: dex_id.into(),
            base_token: DsToken {
                address: "0x00000000000000000000000000000000000000b1".into(),
                symbol: "B".into(),
            },
            quote_token: DsToken {
                address: "0x00000000000000000000000000000000000000b2".into(),
                symbol: "Q".into(),
            },
            price_native: Some("1.0".into()),
            liquidity: None,
            txns: None,
            labels: labels.map(|v| v.into_iter().map(String::from).collect()),
        }
    }

    // Locked invariants: DS ingest gates. nomiswap is the documented BSC
    // bait family; labels[] is the only reliable version signal; an
    // unversioned unknown dex must never be guessed into an interface.

    #[test]
    fn test_ds_normalize_drops_nomiswap() {
        assert!(ds_pair("nomiswap", Some(vec!["v2"])).normalize().is_none());
        assert!(ds_pair("Nomiswap", None).normalize().is_none());
    }

    #[test]
    fn test_ds_normalize_version_comes_from_labels() {
        let v3 = ds_pair("pancakeswap", Some(vec!["v3"]))
            .normalize()
            .expect("v3 row should normalize");
        assert!(matches!(v3.proto, Some(Protocol::UniswapV3)));
        let v2 = ds_pair("pancakeswap", Some(vec!["v2"]))
            .normalize()
            .expect("v2 row should normalize");
        assert!(matches!(v2.proto, Some(Protocol::UniswapV2)));
    }

    // Locked: unlabeled/unknown dexes are NOT dropped at normalize — they
    // come out proto=None and enter the on-chain interface-probe path
    // (the coverage fix). Only provably-unprobeable venues drop outright.
    #[test]
    fn test_ds_normalize_unlabelled_unknown_goes_to_chain_probe() {
        // No labels + unknown dex → proto unresolved (NOT dropped, NOT
        // guessed): the batched globalState/slot0/getReserves probe
        // assigns it on-chain.
        let p = ds_pair("unknowndex", None)
            .normalize()
            .expect("unlabelled unknown dex should still normalize");
        assert!(p.proto.is_none());
        // Known v2-family dex ids still classify without labels.
        let p = ds_pair("biswap", None)
            .normalize()
            .expect("biswap row should normalize");
        assert!(matches!(p.proto, Some(Protocol::UniswapV2)));
        // Algebra-family dexes normalize to proto=None — the probe
        // decides on-chain (measured: "ramses" pools on Polygon answer
        // slot0; never guess V3 — a misread dynamic fee is worse).
        for d in ["thena", "algebra", "integral", "ramses", "velodrome", "solidly"] {
            let p = ds_pair(d, None)
                .normalize()
                .unwrap_or_else(|| panic!("{d} should normalize to probe"));
            assert!(p.proto.is_none(), "{d} must go to the probe, not a guess");
        }
        // Provably-unprobeable venues still drop outright.
        assert!(ds_pair("curve", None).normalize().is_none());
        assert!(ds_pair("dodo_v2", None).normalize().is_none());
        assert!(ds_pair("uniswap_v4", None).normalize().is_none());
    }

    // Regression lock: the spread gate must read pool prices from live
    // chain state, never the feed's CDN-cached price field. V2 gives
    // quote-per-base by reserve ratio; V3 by sqrtP^2 in the pool's own
    // token order.
    #[test]
    fn onchain_price_orientation_v2_and_v3() {
        use alloy::primitives::{address, U256};
        let store = PoolStore::new();
        let a = address!("00000000000000000000000000000000000000a1");
        let b = address!("00000000000000000000000000000000000000b2");
        let pool_v2 = address!("00000000000000000000000000000000000000c1");
        let pool_v3 = address!("00000000000000000000000000000000000000c2");
        store.update(pool_v2, arb_core::types::PoolState::V2(arb_core::types::V2PoolState {
            address: pool_v2,
            token0: a,
            token1: b,
            reserve0: U256::from(100u64),
            reserve1: U256::from(200u64),
            fee_bps: 30,
        }));
        store.update(pool_v3, arb_core::types::PoolState::V3(arb_core::types::V3PoolState {
            address: pool_v3,
            token0: a,
            token1: b,
            sqrt_price_x96: U256::from(2u64) << 96,
            tick: 0,
            liquidity: 1_000_000,
            fee: 3000,
            fee_otz: None,
        }));
        // V2: quote-per-base = r1/r0 when base is token0, inverted otherwise.
        assert_eq!(onchain_price(&store, pool_v2, a, b), Some(2.0));
        assert_eq!(onchain_price(&store, pool_v2, b, a), Some(0.5));
        // V3: sqrtP=2^97 → token1/token0 = 4.
        assert_eq!(onchain_price(&store, pool_v3, a, b), Some(4.0));
        assert_eq!(onchain_price(&store, pool_v3, b, a), Some(0.25));
        // Unknown pool → no price, excluded from the gate.
        assert_eq!(onchain_price(&store, a, a, b), None);
    }

    // Regression lock (measured 2026-10-06 on BSC): ONE divergent pool must
    // not kill a whole pair group. Live case was USDT/USDC — seven honest
    // pools ~0.9998 plus one pool at 0.637 producing a 5693bps "spread".
    fn np(price: f64) -> NormPool {
        NormPool {
            pool: Address::ZERO,
            proto: Some(Protocol::UniswapV2),
            base: Address::ZERO,
            quote: Address::ZERO,
            price,
            liquidity_usd: 0.0,
            h1_txns: 0,
            pair_label: String::new(),
            dex: String::new(),
        }
    }

    #[test]
    fn trim_divergent_convicts_only_the_poisoned_endpoint() {
        let mut group: Vec<NormPool> =
            [0.637, 0.9997, 0.9998, 0.9998, 0.9999].iter().map(|p| np(*p)).collect();
        let dropped = trim_divergent(&mut group, 200.0);
        assert_eq!(dropped.len(), 1);
        assert!((dropped[0].price - 0.637).abs() < 1e-9);
        assert_eq!(group.len(), 4);
        assert!(group.iter().all(|p| (p.price - 0.9998).abs() < 0.001));
    }

    #[test]
    fn trim_divergent_leaves_tight_group_alone_and_keeps_two() {
        let mut group: Vec<NormPool> =
            [1.0, 1.001, 1.002].iter().map(|p| np(*p)).collect();
        assert!(trim_divergent(&mut group, 200.0).is_empty());
        assert_eq!(group.len(), 3);
        // All-divergent groups still keep 2 members — the honest subset
        // may be smaller than the liar population; never trim to nothing.
        let mut wild: Vec<NormPool> =
            [1.0, 5.0, 9.0].iter().map(|p| np(*p)).collect();
        assert_eq!(trim_divergent(&mut wild, 200.0).len(), 1);
        assert_eq!(wild.len(), 2);
    }

    #[test]
    fn persist_bait_pools_merges_without_duplicates() {
        let dir = std::env::temp_dir().join(format!("bait_{:?}", std::process::id()));
        let p1 = Address::from([1u8; 20]);
        let p2 = Address::from([2u8; 20]);
        persist_bait_pools(dir.to_str().unwrap(), &[p1]);
        persist_bait_pools(dir.to_str().unwrap(), &[p1, p2]);
        let s = std::fs::read_to_string(dir.join("_bait_pools.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        let pools = v["pools"].as_array().unwrap();
        assert_eq!(pools.len(), 2);
        assert!(pools.iter().all(|e| e["until_block"].is_u64()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Locked (2026-10-06): pair grouping keys on the unordered token pair —
    // DS and GT report opposite (base,quote) orientations for the same pool
    // set; feeding both through split the venue group and double-simmed.
    #[test]
    fn canonical_pair_key_merges_feed_orientations() {
        let a = Address::from([1u8; 20]);
        let b = Address::from([2u8; 20]);
        assert_eq!(canonical_pair_key(a, b), (a, b));
        assert_eq!(canonical_pair_key(b, a), (a, b), "orientation-agnostic");
    }

    // Locked (2026-10-06): the spread gate is fee-aware. A spread below the
    // round-trip fee can never clear min_net — a 25+25 bps V2-V2 pair needs
    // >55 bps, a 1+1 bps V3 pair needs >7. Flat-floor candidates that could
    // never profit used to burn sim cycles and cooldown slots.
    #[test]
    fn required_spread_bps_covers_round_trip_fees() {
        let cfg = FeedConfig {
            min_spread_bps: 5.0,
            max_notional_usd: 2000.0,
            min_net_usd: 1.0,
            ..Default::default()
        };
        // V2-V2 at 25+25 bps → fee term dominates the noise floor.
        assert_eq!(required_spread_bps(25.0, 25.0, &cfg), 55.0);
        // Two 1bp V3 legs → 2bps fees + 5bps margin.
        assert_eq!(required_spread_bps(1.0, 1.0, &cfg), 7.0);
        // Noise floor binds below the fee term (e.g. ETH config at 50).
        let eth_cfg = FeedConfig {
            min_spread_bps: 50.0,
            ..cfg.clone()
        };
        assert_eq!(required_spread_bps(5.0, 5.0, &eth_cfg), 50.0);
    }

    // Locked (2026-10-06): store_fee_bps converts each protocol's units to
    // plain bps — V3 raw fee is hundredths-of-a-bip (3000 = 30bps).
    #[test]
    fn store_fee_bps_reads_each_protocols_units() {
        use alloy::primitives::{address, U256};
        let store = PoolStore::new();
        let pool_v2 = address!("00000000000000000000000000000000000000c1");
        let pool_v3 = address!("00000000000000000000000000000000000000c2");
        store.update(pool_v2, arb_core::types::PoolState::V2(arb_core::types::V2PoolState {
            address: pool_v2,
            token0: Address::ZERO,
            token1: Address::ZERO,
            reserve0: U256::from(1u64),
            reserve1: U256::from(1u64),
            fee_bps: 25,
        }));
        store.update(pool_v3, arb_core::types::PoolState::V3(arb_core::types::V3PoolState {
            address: pool_v3,
            token0: Address::ZERO,
            token1: Address::ZERO,
            sqrt_price_x96: U256::from(1u64),
            tick: 0,
            liquidity: 1,
            fee: 3000,
            fee_otz: None,
        }));
        assert_eq!(store_fee_bps(&store, pool_v2), 25.0);
        assert_eq!(store_fee_bps(&store, pool_v3), 30.0, "3000 hundredths-bip = 30bps");
        assert_eq!(store_fee_bps(&store, Address::from([7u8; 20])), 30.0);
    }

    // Locked (2026-10-06): UniV3 legs in feed candidates are re-quoted
    // on-chain via QuoterV2 before exec — the local constant-L V3 quoter
    // overestimates executable output on thin pools far past its haircut
    // (measured +196…+100445bps vs QuoterV2 on live BSC pairs). A quoter
    // resolves the pool from ITS factory's create2, so each entry pairs a
    // quoter with its factory and `factory_owns_pool` confirms the hop's
    // pool is the exact deployment the quoter would price.
    #[test]
    fn v3_quoters_pairs_each_deployment_with_its_factory() {
        let bsc = v3_quoters(56);
        assert_eq!(bsc.len(), 2);
        assert_eq!(
            bsc[0],
            (
                address!("B048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997"),
                address!("0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
            ),
            "PCS V3 QuoterV2 + factory"
        );
        assert_eq!(
            bsc[1],
            (
                address!("78D78E420Da98ad378D7799bE8f4AF69033EB077"),
                address!("db1d10011ad0ff90774d0c6bb92e5c5c8b4461f7"),
            ),
            "Uniswap V3 QuoterV2 + factory on BSC"
        );
        for chain in [1u64, 137, 42161, 10] {
            assert_eq!(
                v3_quoters(chain),
                vec![(
                    address!("61fFE014bA17989E743c5F6cB21bF9697530B21e"),
                    address!("1F98431c8aD98523631AE4a59f267346ea31F984"),
                )],
                "canonical UniV3 QuoterV2 + factory on chain {chain}"
            );
        }
        assert!(v3_quoters(8453).is_empty(), "unmapped chain → skip check");
    }

}
