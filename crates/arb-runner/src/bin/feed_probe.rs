// feed_probe — offline funnel measurement for the feed lane.
// Replays the exact feed_lane stages on live DS+GT data and on-chain state,
// instrumenting each drop point. Additionally interface-probes pools that
// normalize() drops (unlabeled/unsupported dex ids) to price the coverage
// gap, and re-sizes candidates with find_optimal_amount to measure the
// fixed-$2000 sizing loss.
//
// Usage: feed_probe <config.toml>
// No submission, no mutation — read-only measurement.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use alloy::providers::Provider;
use alloy::sol;
use alloy_primitives::{address, Address, Bytes, U256};
use alloy_sol_types::SolCall;
use anyhow::Result;
use serde::Deserialize;

use arb_core::types::{PoolState, Protocol};
use arb_core::AmmQuoter;
use arb_paths::{HopTemplate, PathTemplate};
use arb_rpc::Endpoint;
use arb_sim::optimize::path_max_flash;
use arb_sim::{evaluate_path, find_optimal_amount};
use arb_state::refresher::PoolConfig;
use arb_state::{PoolStore, StateRefresher};

#[path = "../config.rs"]
mod config;


sol! {
    // UniV3-periphery QuoterV2 — same interface the feed lane's step-4b
    // divergence check calls on-chain. A quoter resolves the pool from its
    // own factory's create2: confirm factory.getPool == the hop pool first
    // or a same-tokens-same-fee pool under another factory gets priced.
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
    interface IV3Factory {
        function getPool(address tokenA, address tokenB, uint24 fee)
            external
            view
            returns (address pool);
    }
}

// (QuoterV2, its V3 factory) — 1:1 with feed_lane::v3_quoters.
fn v3_quoters(chain_id: u64) -> Vec<(Address, Address)> {
    match chain_id {
        56 => vec![
            (
                address!("B048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997"),
                address!("0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
            ),
            (
                address!("78D78E420Da98ad378D7799bE8f4AF69033EB077"),
                address!("db1d10011ad0ff90774d0c6bb92e5c5c8b4461f7"),
            ),
        ],
        1 | 137 | 42161 | 10 => vec![(
            address!("61fFE014bA17989E743c5F6cB21bF9697530B21e"),
            address!("1F98431c8aD98523631AE4a59f267346ea31F984"),
        )],
        _ => vec![],
    }
}

async fn qv2_leg(
    endpoint: &Endpoint,
    quoter_cache: &mut HashMap<Address, Option<Address>>,
    chain_id: u64,
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
    let try_call = |q: Address| {
        let calldata = calldata.clone();
        let endpoint = endpoint;
        async move {
            let req = alloy::rpc::types::TransactionRequest::default()
                .to(q)
                .input(Bytes::from(calldata).into());
            let raw = endpoint.provider().call(req).await.ok()?;
            IV3QuoterV2::quoteExactInputSingleCall::abi_decode_returns(&raw)
                .ok()
                .map(|r| r.amountOut)
        }
    };
    let owns_pool = |factory: Address| {
        let endpoint = endpoint;
        async move {
            let calldata = IV3Factory::getPoolCall {
                tokenA: token_in,
                tokenB: token_out,
                fee: alloy_primitives::Uint::<24, 1>::from(fee),
            }
            .abi_encode();
            let req = alloy::rpc::types::TransactionRequest::default()
                .to(factory)
                .input(Bytes::from(calldata).into());
            match endpoint.provider().call(req).await {
                Ok(raw) => Some(
                    IV3Factory::getPoolCall::abi_decode_returns(&raw)
                        .map(|r| r == pool)
                        .unwrap_or(false),
                ),
                Err(_) => None,
            }
        }
    };
    match quoter_cache.get(&pool) {
        Some(&Some(q)) => return try_call(q).await,
        Some(&None) => return None,
        None => {}
    }
    // Misses are not cached on transport failure — same policy as
    // feed_lane's `sniffed`: a dead endpoint isn't evidence.
    let mut saw_transport_err = false;
    for (q, factory) in v3_quoters(chain_id) {
        match owns_pool(factory).await {
            Some(true) => {
                if let Some(out) = try_call(q).await {
                    quoter_cache.insert(pool, Some(q));
                    return Some(out);
                }
            }
            Some(false) => {}
            None => saw_transport_err = true,
        }
    }
    if !saw_transport_err {
        quoter_cache.insert(pool, None);
    }
    None
}

/// Chained round-trip output with UniV3 legs re-quoted on-chain via
/// QuoterV2 (V2 stays local — constant-product is exact). None when a
/// UniV3 leg has no answering quoter (Algebra/Slipstream/other factories).
async fn qv2_round_trip(
    endpoint: &Endpoint,
    quoter_cache: &mut HashMap<Address, Option<Address>>,
    chain_id: u64,
    store: &PoolStore,
    path: &PathTemplate,
) -> Option<U256> {
    let mut amount = path.flash_amount;
    for hop in &path.hops {
        let v3_fee = match store.get_ref(&hop.pool) {
            Some(r) => match &*r {
                PoolState::V3(s) if hop.protocol == Protocol::UniswapV3 => {
                    Some(s.fee)
                }
                _ => None,
            },
            None => return None,
        };
        amount = match v3_fee {
            Some(fee) => {
                qv2_leg(endpoint, quoter_cache, chain_id, hop.pool, fee,
                        hop.token_in, hop.token_out, amount).await?
            }
            None => {
                let r = store.get_ref(&hop.pool)?;
                match &*r {
                    PoolState::V2(s) => s.quote(hop.token_in, amount).ok()?,
                    PoolState::V3(s) => s.quote(hop.token_in, amount).ok()?,
                    PoolState::Curve(s) => s.quote(hop.token_in, amount).ok()?,
                    PoolState::Wombat(s) => s.quote(hop.token_in, amount).ok()?,
                    PoolState::Dodo(s) => s.quote(hop.token_in, amount).ok()?,
                    PoolState::AeroV2(s) => s.quote(hop.token_in, amount).ok()?,
                }
            }
        };
    }
    Some(amount)
}

// ─── Feed response models (1:1 with feed_lane.rs) ──────────────────────────

#[derive(Debug, Deserialize)]
struct GtRel { data: Option<GtRelData> }
#[derive(Debug, Deserialize)]
struct GtRelData { id: String }
#[derive(Debug, Deserialize)]
struct GtRels { base_token: Option<GtRel>, quote_token: Option<GtRel>, dex: Option<GtRel> }
#[derive(Debug, Deserialize)]
struct GtBuySell { #[serde(default)] buys: u64, #[serde(default)] sells: u64 }
#[derive(Debug, Deserialize)]
struct GtTxns { h1: Option<GtBuySell> }
#[derive(Debug, Deserialize)]
struct GtAttrs {
    address: String,
    #[serde(default)] name: String,
    reserve_in_usd: Option<String>,
    base_token_price_quote_token: Option<String>,
    #[serde(default)] transactions: Option<GtTxns>,
}
#[derive(Debug, Deserialize)]
struct GtPool { attributes: GtAttrs, relationships: Option<GtRels> }

#[derive(Debug, Clone)]
struct NormPool {
    pool: Address,
    proto: Protocol,
    base: Address,
    quote: Address,
    price: f64,
    liquidity_usd: f64,
    h1_txns: u64,
    pair_label: String,
    dex: String,
    /// Why normalize dropped it (None = kept).
    drop: Option<String>,
    /// Feed-declared fee in hundredths of a bip when known (DS labels).
    fee_hint: Option<u32>,
}

fn protocol_for(dex_id: &str, name: &str) -> Option<Protocol> {
    let d = dex_id.to_ascii_lowercase();
    if d.contains("clmm") || d.contains("stable") || d.contains("curve")
        || d.contains("dodo") || d.contains("wombat") || d.contains("v4")
        || d.contains("integral") || d.contains("solidly") || d.contains("algebra")
        || d.contains("thena") || d.contains("ramses") || d.contains("velodrome")
    {
        return None;
    }
    if d.contains("v3") || (name.contains('%') && d.contains("uniswap")) {
        return Some(Protocol::UniswapV3);
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
        return Some(Protocol::UniswapV2);
    }
    if name.contains('%') { Some(Protocol::UniswapV3) } else { None }
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
        let dex = rel.dex.as_ref().and_then(|d| d.data.as_ref()).map(|d| d.id.as_str()).unwrap_or("");
        let proto = protocol_for(dex, &a.name);
        let price: f64 = a.base_token_price_quote_token.as_deref()?.parse().ok()?;
        if price <= 0.0 || !price.is_finite() { return None; }
        let liquidity_usd = a.reserve_in_usd.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let h1_txns = a.transactions.as_ref().and_then(|t| t.h1.as_ref()).map(|h| h.buys + h.sells).unwrap_or(0);
        let pair_label = match a.name.rsplit(' ').next() {
            Some(t) if t.ends_with('%') => a.name.rsplit_once(' ').map(|(h, _)| h.to_string()).unwrap_or_else(|| a.name.clone()),
            _ => a.name.clone(),
        };
        Some(NormPool {
            pool, base, quote, price, liquidity_usd, h1_txns, pair_label,
            dex: dex.to_string(),
            proto: proto.unwrap_or(Protocol::UniswapV2),
            drop: if proto.is_none() { Some(format!("proto:{dex}")) } else { None },
            fee_hint: None,
        })
    }
}

#[derive(Debug, Deserialize)]
struct DsToken { address: String, #[serde(default)] symbol: String }
#[derive(Debug, Deserialize)]
struct DsLiq { usd: Option<f64> }
#[derive(Debug, Deserialize)]
struct DsTxns { h1: Option<GtBuySell> }
#[derive(Debug, Deserialize)]
struct DsPair {
    #[serde(rename = "pairAddress")] pair_address: String,
    #[serde(rename = "dexId", default)] dex_id: String,
    #[serde(rename = "baseToken")] base_token: DsToken,
    #[serde(rename = "quoteToken")] quote_token: DsToken,
    #[serde(rename = "priceNative")] price_native: Option<String>,
    liquidity: Option<DsLiq>,
    txns: Option<DsTxns>,
    #[serde(default)] labels: Option<Vec<String>>,
}

impl DsPair {
    /// Same logic as feed_lane::DsPair::normalize, but returns a NormPool
    /// with `drop` set instead of None when the lane would discard the row.
    fn normalize(&self) -> Option<NormPool> {
        let pool: Address = self.pair_address.parse().ok()?;
        let base: Address = self.base_token.address.parse().ok()?;
        let quote: Address = self.quote_token.address.parse().ok()?;
        if self.dex_id.eq_ignore_ascii_case("nomiswap") {
            let price: f64 = self.price_native.as_deref()?.parse().ok()?;
            return Some(NormPool {
                pool, base, quote, price,
                proto: Protocol::UniswapV2,
                liquidity_usd: self.liquidity.as_ref().and_then(|l| l.usd).unwrap_or(0.0),
                h1_txns: self.txns.as_ref().and_then(|t| t.h1.as_ref()).map(|h| h.buys + h.sells).unwrap_or(0),
                pair_label: format!("{} / {}", self.base_token.symbol, self.quote_token.symbol),
                dex: self.dex_id.clone(),
                drop: Some("nomiswap".into()),
                fee_hint: None,
            });
        }
        let has = |tag: &str| {
            self.labels.as_ref().map(|l| l.iter().any(|t| t.eq_ignore_ascii_case(tag))).unwrap_or(false)
        };
        let (proto, drop) = if has("v3") {
            (Some(Protocol::UniswapV3), None)
        } else if has("v2") || has("v1") {
            (Some(Protocol::UniswapV2), None)
        } else {
            match protocol_for(&self.dex_id, "") {
                Some(p) => (Some(p), None),
                None => (None, Some(format!("proto:{}", self.dex_id))),
            }
        };
        let price: f64 = self.price_native.as_deref()?.parse().ok()?;
        if price <= 0.0 || !price.is_finite() { return None; }
        Some(NormPool {
            pool, base, quote, price,
            proto: proto.unwrap_or(Protocol::UniswapV2),
            liquidity_usd: self.liquidity.as_ref().and_then(|l| l.usd).unwrap_or(0.0),
            h1_txns: self.txns.as_ref().and_then(|t| t.h1.as_ref()).map(|h| h.buys + h.sells).unwrap_or(0),
            pair_label: format!("{} / {}", self.base_token.symbol, self.quote_token.symbol),
            dex: self.dex_id.clone(),
            drop,
            fee_hint: None,
        })
    }
}

async fn ds_fetch(client: &reqwest::Client, slug: &str, token: Address) -> Vec<DsPair> {
    let url = format!("https://api.dexscreener.com/token-pairs/v1/{slug}/{token}");
    let Ok(resp) = client.get(&url).send().await else { return Vec::new() };
    if !resp.status().is_success() { return Vec::new() }
    resp.json::<Vec<DsPair>>().await.unwrap_or_default()
}

enum FetchOutcome { Ok(Vec<GtPool>), RateLimited(Duration), Fail }

async fn gt_fetch(client: &reqwest::Client, url: &str) -> FetchOutcome {
    let Ok(resp) = client.get(url).send().await else { return FetchOutcome::Fail };
    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS { return FetchOutcome::RateLimited(Duration::from_secs(30)) }
    if !resp.status().is_success() { return FetchOutcome::Fail }
    let Ok(v) = resp.json::<serde_json::Value>().await else { return FetchOutcome::Fail };
    match v.get("data").and_then(|d| serde_json::from_value(d.clone()).ok()) {
        Some(p) => FetchOutcome::Ok(p),
        None => FetchOutcome::Fail,
    }
}

/// quote-per-base mid price from pool state — mirrors feed_lane::onchain_price.
fn onchain_price(store: &PoolStore, pool: Address, base: Address) -> Option<f64> {
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
            if r0 <= 0.0 || r1 <= 0.0 { return None; }
            if base == token0 { Some(r1 / r0) } else { Some(r0 / r1) }
        }
        arb_core::types::PoolState::V3(s) => {
            if s.sqrt_price_x96.is_zero() { return None; }
            let sp: f64 = s.sqrt_price_x96.try_into().map(|v: u128| v as f64).unwrap_or(0.0);
            let p = (sp / 79228162514264337593543950336.0).powi(2);
            if !p.is_finite() || p <= 0.0 { return None; }
            if base == s.token0 { Some(p) } else { Some(1.0 / p) }
        }
        _ => None,
    }
}



#[derive(Default)]
struct Funnel {
    gt_rows: u64,
    ds_rows: u64,
    norm_ok: u64,
    norm_drop: HashMap<String, u64>,
    filt_liquidity: u64,
    filt_inactive: u64,
    filt_noflash: u64,
    groups_total: u64,
    groups_singleton: u64,
    groups_ge2: u64,
    gate_no_state: u64,
    gate_below_spread: u64,
    gate_suspect: u64,
    candidates: u64,
    sim_fail_fixed: u64,
    sim_pass_fixed: u64,
    sim_fail_optimal: u64,
    sim_rescued: u64,
    net_fail_fixed: u64,
    net_fail_optimal: u64,
}

struct GapResult {
    probed: u64,
    classified: HashMap<String, u64>,
    new_pools_priced: u64,
    new_candidates: u64,
    new_sim_pass: u64,
    best_gap_bps: f64,
    best_gap_desc: String,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let cfg_path = std::env::args().nth(1).expect("usage: feed_probe <config.toml>");
    let probe_gap = std::env::args().any(|a| a == "--gap");
    let cfg = config::load_config(&cfg_path)?;
    let chain = cfg.chain.name.to_lowercase();
    let chain_id = cfg.chain.chain_id;

    let tokens: HashMap<String, Address> = cfg
        .tokens
        .iter()
        .map(|(n, a)| (n.clone(), a.parse().expect("bad token addr")))
        .collect();
    let token_syms: HashMap<Address, String> = tokens.iter().map(|(n, a)| (*a, n.clone())).collect();
    let sym = |a: Address| -> String {
        token_syms.get(&a).cloned().unwrap_or_else(|| format!("{:.8}", format!("{a:?}")))
    };

    // flash_quotes addr -> (usd, dec) — replicate runner's decimals table.
    let mut flash_quotes: HashMap<Address, (f64, u8)> = HashMap::new();
    for s in &cfg.feed.flash_quotes {
        if let Some(&a) = tokens.get(s) {
            let dec = match s.as_str() {
                "USDT" | "USDC" | "USDCe" | "USDbC" | "BUSD" | "DAI" if chain_id == 1 => 6u8,
                "USDT" | "USDC" | "USDCe" | "USDbC" | "BUSD" => {
                    if chain_id == 1 { 6 } else { 18 }
                }
                "DAI" => 18,
                _ => 18,
            };
            let usd = cfg.token_usd_prices.get(s).copied().unwrap_or(0.0);
            flash_quotes.insert(a, (usd, dec));
        }
    }
    // Known-decimals override set for mids (best-effort).
    let mut known_dec: HashMap<Address, u8> = HashMap::new();
    for (n, a) in &tokens {
        let d = match n.as_str() {
            "USDT" | "USDC" | "USDCe" | "USDbC" | "BUSD" if chain_id == 1 => 6u8,
            "USDT" | "USDC" | "USDCe" | "USDbC" | "BUSD" => {
                if chain_id == 1 { 6 } else { 18 }
            }
            _ => 18,
        };
        known_dec.insert(*a, d);
    }

    let read_urls: Vec<String> = if !cfg.chain.rpc_https.is_empty() {
        vec![cfg.chain.rpc_https.clone()]
    } else {
        cfg.chain.rpc_https_pool.clone()
    };
    let url_refs: Vec<&str> = read_urls.iter().map(|s| s.as_str()).collect();
    let endpoint = Arc::new(
        Endpoint::new_pooled(&url_refs, "", None, chain_id)
            .await
            .map_err(|e| anyhow::anyhow!("endpoint: {e}"))?,
    );
    let state_reader: Address = cfg.chain.state_reader.parse()?;
    let refresher = Arc::new(
        StateRefresher::new(endpoint.clone(), state_reader, Vec::new(), chain_id)
            .with_call_deadline(cfg.chain.call_deadline_ms.unwrap_or(2200)),
    );
    let store = Arc::new(PoolStore::new());

    let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build()?;
    let slug = match chain_id {
        56 => "bsc",
        1 => "ethereum",
        137 => "polygon",
        8453 => "base",
        _ => chain.as_str(),
    };
    let gt_slug = match chain.as_str() {
        "ethereum" | "eth" => "eth",
        "polygon" | "matic" => "polygon_pos",
        "bsc" | "bnb" => "bsc",
        "base" => "base",
        o => o,
    };

    let mut f = Funnel::default();

    // ── Ingest: GT pages + DS token-pairs, dedup by pool (lane order: GT first) ──
    let mut seen: HashSet<Address> = HashSet::new();
    let mut norm: Vec<NormPool> = Vec::new();
    let mut dropped_norm: Vec<NormPool> = Vec::new();
    for p in 1..=3u8 {
        let url = format!("https://api.geckoterminal.com/api/v2/networks/{gt_slug}/pools?page={p}");
        match gt_fetch(&client, &url).await {
            FetchOutcome::Ok(rows) => {
                for raw in &rows {
                    f.gt_rows += 1;
                    if let Some(np) = raw.normalize() {
                        if np.drop.is_none() {
                            if seen.insert(np.pool) { norm.push(np); }
                            f.norm_ok += 1;
                        } else {
                            *f.norm_drop.entry(np.drop.clone().unwrap()).or_insert(0) += 1;
                            if seen.insert(np.pool) {} // keep dedup semantics: still tracked
                            dropped_norm.push(np);
                        }
                    }
                }
            }
            FetchOutcome::RateLimited(_) => eprintln!("GT page {p} rate-limited"),
            FetchOutcome::Fail => eprintln!("GT page {p} fetch failed"),
        }
        tokio::time::sleep(Duration::from_secs(4)).await;
    }

    let mut ingest: Vec<Address> = flash_quotes.keys().copied().collect();
    for s in &cfg.feed.tokens {
        if let Some(&a) = tokens.get(s) {
            if !ingest.contains(&a) { ingest.push(a); }
        }
    }
    for pairs in futures::future::join_all(
        ingest.iter().map(|t| ds_fetch(&client, slug, *t)),
    ).await {
        for dp in &pairs {
            f.ds_rows += 1;
            if let Some(np) = dp.normalize() {
                if np.drop.is_none() {
                    if seen.insert(np.pool) { norm.push(np); }
                    f.norm_ok += 1;
                } else {
                    *f.norm_drop.entry(np.drop.clone().unwrap()).or_insert(0) += 1;
                    if seen.insert(np.pool) {
                        dropped_norm.push(np);
                    }
                }
            }
        }
    }

    println!("=== {} (chain {}) feed funnel ===", cfg.chain.name, chain_id);
    println!("ingest: gt_rows={} ds_rows={} kept={}", f.gt_rows, f.ds_rows, f.norm_ok);
    let mut drops: Vec<_> = f.norm_drop.iter().collect();
    drops.sort_by(|a, b| b.1.cmp(a.1));
    for (r, n) in drops { println!("  normalize-drop {r}: {n}"); }

    // ── Filters (blocked set empty — token_safety needs network; noted) ──
    let mut by_pair: HashMap<(Address, Address), Vec<NormPool>> = HashMap::new();
    for p in norm {
        if p.liquidity_usd < cfg.feed.min_liquidity_usd { f.filt_liquidity += 1; continue; }
        if p.h1_txns < cfg.feed.min_h1_txns { f.filt_inactive += 1; continue; }
        if !flash_quotes.contains_key(&p.base) && !flash_quotes.contains_key(&p.quote) {
            f.filt_noflash += 1;
            continue;
        }
        by_pair.entry((p.base, p.quote)).or_default().push(p);
    }
    println!("filters: liquidity={} inactive={} no-flash={}", f.filt_liquidity, f.filt_inactive, f.filt_noflash);

    for g in by_pair.values() {
        f.groups_total += 1;
        if g.len() < 2 { f.groups_singleton += 1; } else { f.groups_ge2 += 1; }
    }
    println!("pair groups: total={} singleton={} ge2={}", f.groups_total, f.groups_singleton, f.groups_ge2);

    // ── Register + refresh gate pools (identical to lane) ──
    let mut gate_pools: Vec<Address> = Vec::new();
    let mut add: Vec<PoolConfig> = Vec::new();
    for group in by_pair.values() {
        if group.len() < 2 { continue; }
        for p in group {
            gate_pools.push(p.pool);
            add.push(PoolConfig { address: p.pool, protocol: p.proto, fee_bps: 0, token0: None, token1: None });
        }
    }
    refresher.add_pools(add);
    let got = refresher.refresh_pools(&store, &gate_pools).await;
    println!("refresh: {} pools registered, {} got state", gate_pools.len(), got);

    // ── Spread gate + fixed-size sim + optimal-size sim ──
    let mut reports: Vec<String> = Vec::new();
    let mut quoter_cache: HashMap<Address, Option<Address>> = HashMap::new();
    for ((base, quote), mut group) in &mut by_pair {
        if group.len() < 2 { continue; }
        group.retain_mut(|p| {
            if let Some(op) = onchain_price(&store, p.pool, *base) {
                p.price = op;
                true
            } else {
                f.gate_no_state += 1;
                false
            }
        });
        if group.len() < 2 { continue; }
        group.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal));
        let lo = &group[0];
        let hi = group.last().unwrap();
        let spread_bps = (hi.price - lo.price) / lo.price * 10_000.0;
        if spread_bps < cfg.feed.min_spread_bps {
            f.gate_below_spread += 1;
            reports.push(format!(
                "  near-miss {} {}/{} spread={:.1}bps (<{:.0} gate)",
                sym(*base) + "/" + &sym(*quote), lo.dex, hi.dex, spread_bps, cfg.feed.min_spread_bps
            ));
            continue;
        }
        if spread_bps > cfg.feed.max_spread_bps { f.gate_suspect += 1; continue; }
        f.candidates += 1;

        let (borrow, mid, pin, pout, din, dout) = if flash_quotes.contains_key(quote) {
            (*quote, *base, lo.pool, hi.pool, lo.dex.clone(), hi.dex.clone())
        } else {
            (*base, *quote, hi.pool, lo.pool, hi.dex.clone(), lo.dex.clone())
        };
        let proto_in = if flash_quotes.contains_key(quote) { lo.proto } else { hi.proto };
        let proto_out = if flash_quotes.contains_key(quote) { hi.proto } else { lo.proto };
        let &(busd, bdec) = flash_quotes.get(&borrow).unwrap();
        let notional = cfg.feed.max_notional_usd.min(lo.liquidity_usd.min(hi.liquidity_usd) * cfg.feed.pool_share_bps / 10_000.0);
        let units = notional / busd;
        let flash_amount = U256::from(units as u128) * U256::from(10u64).pow(U256::from(bdec as u32));
        let mkpath = |amt: U256| PathTemplate {
            id: 0,
            flash_token: borrow,
            flash_amount: amt,
            hops: vec![
                HopTemplate { protocol: proto_in, pool: pin, token_in: borrow, token_out: mid },
                HopTemplate { protocol: proto_out, pool: pout, token_in: mid, token_out: borrow },
            ],
        };
        let path = mkpath(flash_amount);
        let sim = evaluate_path(&path, &store);
        let gross_fixed = sim.as_ref().map(|s| (s.gross_profit.to::<u128>() as f64) / 10f64.powi(bdec as i32) * busd).unwrap_or(0.0);
        if sim.is_some() { f.sim_pass_fixed += 1 } else { f.sim_fail_fixed += 1 }

        // Optimal-size comparison: does a different notional rescue or beat it?
        let max_amt = path_max_flash(&path, &store, 0.05, flash_amount);
        let min_amt = U256::from(10u64).pow(U256::from(bdec as u32)); // $1-ish floor
        let opt = find_optimal_amount(&path, &store, min_amt, max_amt.max(min_amt + U256::from(1u64)), 30);
        let (opt_amt, opt_gross) = opt.map(|(a, g)| {
            (a, (g.to::<u128>() as f64) / 10f64.powi(bdec as i32) * busd)
        }).unwrap_or((U256::ZERO, 0.0));
        if opt.is_none() { f.sim_fail_optimal += 1; }
        if sim.is_none() && opt_gross > 0.0 { f.sim_rescued += 1; }
        let gas_usd = 0.5; // gasless sponsorship — report gross only
        let _ = gas_usd;
        if gross_fixed > 0.0 && gross_fixed < cfg.feed.min_net_usd { f.net_fail_fixed += 1; }
        if opt_gross > 0.0 && opt_gross < cfg.feed.min_net_usd { f.net_fail_optimal += 1; }
        // Net-vs-size curve — answers whether ANY flash_amount clears the
        // gas floor for thin-positive edges (fleet observed $0.015–$0.041
        // nets dying at ~$0.046). Local curve = what find_optimal_amount
        // sees; qv2 curve = on-chain truth at the same sizes, so the peak
        // and its position are measured, not modeled.
        let gas_floor = 0.046f64; // fleet-reported net floor this window
        // Uncapped ceiling: path_max_flash's default_max arg is the $2k
        // notional — the optimizer never sees sizes above it. Scan a
        // depth-only bound (20x notional cap) so a peak above $2k is
        // visible and means "config cap blocks a real edge".
        let uncapped_max =
            path_max_flash(&path, &store, 0.05, flash_amount * U256::from(20u64));
        let mut peak_local = 0.0f64;
        let mut peak_local_amt = U256::ZERO;
        let mut peak_qv2 = f64::MIN;
        let mut peak_qv2_amt = U256::ZERO;
        for i in 0..=6u32 {
            if uncapped_max <= min_amt { break; }
            let amt = min_amt
                + (uncapped_max - min_amt) * U256::from(i) / U256::from(6u32);
            let curve_path = mkpath(amt);
            if let Some(s) = evaluate_path(&curve_path, &store) {
                let g = (s.gross_profit.to::<u128>() as f64)
                    / 10f64.powi(bdec as i32) * busd;
                if g > peak_local { peak_local = g; peak_local_amt = amt; }
            }
            if let Some(out) = qv2_round_trip(
                &endpoint, &mut quoter_cache, chain_id, &store, &curve_path,
            ).await {
                let g = (out.saturating_sub(amt).to::<u128>() as f64)
                    / 10f64.powi(bdec as i32) * busd;
                if g > peak_qv2 { peak_qv2 = g; peak_qv2_amt = amt; }
            }
        }
        let curve_note = format!(
            " peak[local=${:.3}@{:.0} qv2={}@{:.0}]{}",
            peak_local,
            (peak_local_amt.to::<u128>() as f64) / 10f64.powi(bdec as i32),
            if peak_qv2 == f64::MIN { "n/a".into() } else { format!("${:.3}", peak_qv2) },
            (peak_qv2_amt.to::<u128>() as f64) / 10f64.powi(bdec as i32),
            if peak_qv2 > gas_floor + cfg.feed.min_net_usd { " RESCUES" }
            else if peak_qv2 > 0.0 { " (no size clears gas)" } else { "" },
        );
        // On-chain QuoterV2 truth for UniV3 legs — the local V3 quoter is
        // constant-L single-tick; thin pools diverge far past the haircut.
        let qv2 = qv2_round_trip(&endpoint, &mut quoter_cache, chain_id, &store, &path).await;
        let qv2_note = match (qv2, &sim) {
            (Some(out), Some(s)) => {
                let real_gross = (out.saturating_sub(flash_amount).to::<u128>() as f64)
                    / 10f64.powi(bdec as i32) * busd;
                let sim_out = flash_amount + s.gross_profit;
                let div = if !out.is_zero() {
                    (sim_out.to::<u128>() as f64 - out.to::<u128>() as f64)
                        / out.to::<u128>() as f64 * 1e4
                } else { f64::INFINITY };
                format!(" qv2=${:.2}({:+.0}bps)", real_gross, div)
            }
            (Some(out), None) => {
                let real_gross = (out.saturating_sub(flash_amount).to::<u128>() as f64)
                    / 10f64.powi(bdec as i32) * busd;
                format!(" qv2=${:.2}(sim=fail)", real_gross)
            }
            (None, _) => " qv2=n/a".into(),
        };
        // Stored-fee diagnostics: sim honesty depends on the fee the
        // refresher wrote into PoolState — print it next to each candidate.
        let fee_of = |a: Address| -> String {
            match store.get_ref(&a).map(|r| r.clone()) {
                Some(arb_core::types::PoolState::V2(s)) => format!("v2={}bps", s.fee_bps),
                Some(arb_core::types::PoolState::V3(s)) => format!("v3={}hpip", s.fee),
                Some(arb_core::types::PoolState::AeroV2(s)) => format!("aero={}bps", s.fee_bps),
                _ => "?".into(),
            }
        };
        reports.push(format!(
            "  cand {} ({}→{}): spread={:.1}bps fixed=${:.2} opt=${:.2}@{:?}{}{} pools {}/{} fees[{}/{}]",
            format!("{}", sym(*base)) + "/" + &sym(*quote),
            din, dout, spread_bps, gross_fixed, opt_gross, opt_amt, qv2_note,
            curve_note,
            format!("{:.10}", format!("{pin:?}")), format!("{:.10}", format!("{pout:?}")),
            fee_of(pin), fee_of(pout),
        ));
    }
    println!("gate: no_state={} below_spread={} suspect={} candidates={}", f.gate_no_state, f.gate_below_spread, f.gate_suspect, f.candidates);
    println!("sim: pass_fixed={} fail_fixed={} fail_optimal={} rescued={}", f.sim_pass_fixed, f.sim_fail_fixed, f.sim_fail_optimal, f.sim_rescued);
    for r in &reports { println!("{r}"); }

    // ── Coverage gap: interface-probe normalize-dropped pools ──
    if probe_gap {
        let mut gap = GapResult { probed: 0, classified: HashMap::new(), new_pools_priced: 0, new_candidates: 0, new_sim_pass: 0, best_gap_bps: 0.0, best_gap_desc: String::new() };
        let mut add_gap: Vec<PoolConfig> = Vec::new();
        let mut probed_pools: Vec<(Address, Protocol, NormPool)> = Vec::new();
        let mut probe_targets: Vec<Address> = Vec::new();
        let mut probe_norm: Vec<NormPool> = Vec::new();
        for np in &dropped_norm {
            // only pools that would pass the liquidity floor + touch a flash asset
            if np.liquidity_usd < cfg.feed.min_liquidity_usd { continue; }
            if !flash_quotes.contains_key(&np.base) && !flash_quotes.contains_key(&np.quote) { continue; }
            gap.probed += 1;
            probe_targets.push(np.pool);
            probe_norm.push(np.clone());
        }
        // Ship-path verification: classify through the real
        // StateRefresher::probe_interfaces (one aggregate3 batch).
        let hits = refresher.probe_interfaces(&probe_targets).await.unwrap_or_default();
        for np in probe_norm {
            if let Some(proto) = hits.get(&np.pool).copied() {
                *gap.classified.entry(format!("{proto:?}")).or_insert(0) += 1;
                let mut np2 = np.clone();
                np2.proto = proto;
                np2.drop = None;
                probed_pools.push((np.pool, proto, np2));
                add_gap.push(PoolConfig { address: np.pool, protocol: proto, fee_bps: 0, token0: None, token1: None });
            }
        }
        println!("gap: probed={} classified={:?}", gap.probed, gap.classified);
        if !add_gap.is_empty() {
            refresher.add_pools(add_gap);
            let gap_addrs: Vec<Address> = probed_pools.iter().map(|(a, _, _)| *a).collect();
            let g2 = refresher.refresh_pools(&store, &gap_addrs).await;
            println!("gap refresh: {} of {} priced", g2, gap_addrs.len());
            gap.new_pools_priced = g2 as u64;
            // re-group: add probed pools into by_pair under their (base,quote)
            for (_, _, np) in probed_pools.iter().cloned() {
                by_pair.entry((np.base, np.quote)).or_default().push(np);
            }
            // measure spreads with the widened groups
            for ((base, quote), group) in &by_pair {
                if group.len() < 2 { continue; }
                let mut priced: Vec<(f64, &NormPool)> = group
                    .iter()
                    .filter_map(|p| onchain_price(&store, p.pool, *base).map(|pr| (pr, p)))
                    .collect();
                if priced.len() < 2 { continue; }
                priced.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
                let lo = priced[0];
                let hi = *priced.last().unwrap();
                let spread = (hi.0 - lo.0) / lo.0 * 10_000.0;
                let involves_gap = group.iter().any(|p| gap_addrs_slice_contains(&gap_addrs, p.pool));
                if involves_gap && spread >= cfg.feed.min_spread_bps && spread <= cfg.feed.max_spread_bps {
                    gap.new_candidates += 1;
                    if spread > gap.best_gap_bps {
                        gap.best_gap_bps = spread;
                        gap.best_gap_desc = format!("{}/{} {}/{} spread={:.1}bps", sym(*base), sym(*quote), lo.1.dex, hi.1.dex, spread);
                    }
                    // sim the gap candidate at fixed + optimal size
                    let (borrow, mid, pin, pout) = if flash_quotes.contains_key(quote) {
                        (*quote, *base, lo.1.pool, hi.1.pool)
                    } else {
                        (*base, *quote, hi.1.pool, lo.1.pool)
                    };
                    let proto_in = if flash_quotes.contains_key(quote) { lo.1.proto } else { hi.1.proto };
                    let proto_out = if flash_quotes.contains_key(quote) { hi.1.proto } else { lo.1.proto };
                    let &(busd, bdec) = flash_quotes.get(&borrow).unwrap();
                    let notional = cfg.feed.max_notional_usd.min(lo.1.liquidity_usd.min(hi.1.liquidity_usd) * cfg.feed.pool_share_bps / 10_000.0);
                    let units = notional / busd;
                    let flash_amount = U256::from(units as u128) * U256::from(10u64).pow(U256::from(bdec as u32));
                    let gpath = PathTemplate {
                        id: 0,
                        flash_token: borrow,
                        flash_amount,
                        hops: vec![
                            HopTemplate { protocol: proto_in, pool: pin, token_in: borrow, token_out: mid },
                            HopTemplate { protocol: proto_out, pool: pout, token_in: mid, token_out: borrow },
                        ],
                    };
                    let gsim = evaluate_path(&gpath, &store);
                    let gfix = gsim.as_ref().map(|s| (s.gross_profit.to::<u128>() as f64) / 10f64.powi(bdec as i32) * busd).unwrap_or(0.0);
                    let gmax = path_max_flash(&gpath, &store, 0.05, flash_amount);
                    let gmin = U256::from(10u64).pow(U256::from(bdec as u32));
                    let gopt = find_optimal_amount(&gpath, &store, gmin, gmax.max(gmin + U256::from(1u64)), 30);
                    let gopt_usd = gopt.map(|(_, g)| (g.to::<u128>() as f64) / 10f64.powi(bdec as i32) * busd).unwrap_or(0.0);
                    if gsim.is_some() { gap.new_sim_pass += 1; }
                    println!(
                        "  gap-cand {}/{} {}/{} spread={:.1}bps fixed=${:.2} opt=${:.2}",
                        sym(*base), sym(*quote), lo.1.dex, hi.1.dex, spread, gfix, gopt_usd
                    );
                }
            }
            println!("gap: new_candidates={} sim_pass={} best={}", gap.new_candidates, gap.new_sim_pass, gap.best_gap_desc);

            // Diagnose priced-failures: for each probed pool that refresh
            // couldn't price, call fee()/liquidity()/token0() one by one —
            // a V3-looking pool without fee() (e.g. Kyber Elastic) passes
            // the interface probe but can't enter the V3 read path.
            mod fee_if {
                use alloy_sol_types::sol;
                sol! {
                    interface FeeIf {
                        function fee() external view returns (uint24);
                        function liquidity() external view returns (uint128);
                        function token0() external view returns (address);
                    }
                }
            }
            use alloy_sol_types::SolCall;
            use alloy::providers::Provider;
            let mut fee_ok = 0u32;
            let mut liq_ok = 0u32;
            let mut tok_ok = 0u32;
            let mut unpriced = 0u32;
            for (addr, proto, np) in &probed_pools {
                if !matches!(proto, Protocol::UniswapV3) { continue; }
                if store.get_ref(addr).is_some() { continue; }
                unpriced += 1;
                let call = |sel: Vec<u8>| {
                    let req = alloy::rpc::types::TransactionRequest::default()
                        .to(*addr)
                        .input(sel.into());
                    endpoint.provider().call(req)
                };
                let f = call(fee_if::FeeIf::feeCall::new(()).abi_encode()).await.map(|b| b.len() >= 32).unwrap_or(false);
                let l = call(fee_if::FeeIf::liquidityCall::new(()).abi_encode()).await.map(|b| b.len() >= 32).unwrap_or(false);
                let t = call(fee_if::FeeIf::token0Call::new(()).abi_encode()).await.map(|b| b.len() >= 32).unwrap_or(false);
                if f { fee_ok += 1; }
                if l { liq_ok += 1; }
                if t { tok_ok += 1; }
                if unpriced <= 8 {
                    println!("    unpriced-v3 {} dex={} liq={} fee={} liq()={} token0()={}", addr, np.dex, np.liquidity_usd as u64, f, l, t);
                }
            }
            println!("  unpriced-v3 diag: {} pools — fee() ok={} liquidity() ok={} token0() ok={}", unpriced, fee_ok, liq_ok, tok_ok);
        }
    }

    Ok(())
}

fn gap_addrs_slice_contains(addrs: &[Address], a: Address) -> bool {
    addrs.contains(&a)
}
