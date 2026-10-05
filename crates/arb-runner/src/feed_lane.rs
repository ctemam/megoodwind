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
use alloy_primitives::{Address, Bytes, U256};
use alloy_sol_types::SolCall;
use serde::Deserialize;
use tracing::{info, warn};

use arb_core::opportunity::{
    ActionableOpportunity, ExecutionStatus, SimulationStatus,
};
use arb_core::types::Protocol;
use arb_paths::{HopTemplate, PathTemplate};
use arb_rpc::Endpoint;
use arb_sim::evaluate_path;
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
    /// addr -> usd price for P&L bookkeeping (flash assets + majors).
    pub token_usd_prices: HashMap<Address, f64>,
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
struct NormPool {
    pool: Address,
    proto: Protocol,
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
        let proto = protocol_for(dex, &a.name)?;
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

/// DEX id / pool name → AMM interface. Anything not matching the V2 or V3
/// swap interface is a non-atomic venue for our executor — dropped.
fn protocol_for(dex_id: &str, name: &str) -> Option<Protocol> {
    let d = dex_id.to_ascii_lowercase();
    // Explicitly unsupported interfaces first — mislabeled protocol means a
    // guaranteed exec revert.
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
    // Unversioned dex ids ("uniswap-bsc", ...): a fee% in the pool name
    // means concentrated-liquidity V3; otherwise drop rather than guess.
    if name.contains('%') {
        Some(Protocol::UniswapV3)
    } else {
        None
    }
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
    let url = format!("https://api.geckoterminal.com/api/v2/networks/{slug}/pools?page=1");
    let mut next_id: u32 = 0xF00D;
    // Pools that reverted at exec — suppressed for 1h after 2 strikes.
    let mut suppressed: HashMap<Address, (u32, Instant)> = HashMap::new();
    // (borrow, pool_in, pool_out) re-eval cooldown.
    let mut cooldown: HashMap<(Address, Address, Address), Instant> = HashMap::new();
    // Pools already pushed into the refresher config.
    let mut registered: HashSet<Address> = HashSet::new();

    // GT's free rate limit is per-IP (~30 req/min) and the shared egress IP
    // is often saturated by other tenants — treat 429 as a paced sleep, not
    // a retry storm.
    let mut rl_sleep = Duration::from_secs(30);
    loop {
        let pools: Vec<GtPool> = match fetch(&client, &url).await {
            FetchOutcome::Ok(p) => {
                rl_sleep = Duration::from_secs(30);
                p
            }
            FetchOutcome::RateLimited(after) => {
                metrics::FEED_REJECTS
                    .with_label_values(&[&args.chain, "rate_limited"])
                    .inc();
                // +jitter so the three chain lanes don't hammer in lockstep.
                let jitter = (std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_millis() % 5000)
                    .unwrap_or(0)) as u64;
                tokio::time::sleep(
                    after.max(rl_sleep) + Duration::from_millis(jitter),
                )
                .await;
                rl_sleep = (rl_sleep * 2).min(Duration::from_secs(240));
                continue;
            }
            FetchOutcome::Fail => {
                metrics::FEED_REJECTS
                    .with_label_values(&[&args.chain, "fetch"])
                    .inc();
                tokio::time::sleep(Duration::from_secs(args.cfg.interval_secs.max(5))).await;
                continue;
            }
        };
        metrics::FEED_SCANNED.with_label_values(&[&args.chain]).inc();

        // Step 2 — rigid filters; group by (base, quote) pair parity.
        let mut by_pair: HashMap<(Address, Address), Vec<NormPool>> = HashMap::new();
        for raw in &pools {
            let Some(p) = raw.normalize() else {
                continue;
            };
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
                continue; // neither side is a flash asset — can't borrow
            }
            by_pair.entry((p.base, p.quote)).or_default().push(p);
        }

        for ((base, quote), mut group) in by_pair {
            if group.len() < 2 {
                continue;
            }
            group.sort_by(|a, b| {
                a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal)
            });
            let lo_p = &group[0];
            let hi_p = group.last().unwrap();
            let spread_bps = (hi_p.price - lo_p.price) / lo_p.price * 10_000.0;
            if spread_bps < args.cfg.min_spread_bps {
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
            let cand = if args.flash_quotes.contains_key(&quote) {
                FeedCandidate {
                    borrow: quote,
                    mid: base,
                    pool_in: lo_p.pool,
                    proto_in: lo_p.proto,
                    pool_out: hi_p.pool,
                    proto_out: hi_p.proto,
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
                    proto_in: hi_p.proto,
                    pool_out: lo_p.pool,
                    proto_out: lo_p.proto,
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
            let fails = verify_and_submit(&args, &cand, &mut next_id, &mut registered)
                .await;
            if let Some((pool, strikes)) = fails {
                let (n, _) = suppressed.get(&pool).copied().unwrap_or((0, Instant::now()));
                let n = n + strikes;
                if n >= 2 {
                    suppressed.insert(
                        pool,
                        (n, Instant::now() + Duration::from_secs(3600)),
                    );
                    warn!(pool = %pool, "feed lane suppressing reverting pool 1h");
                } else {
                    suppressed.insert(pool, (n, Instant::now() + Duration::from_secs(60)));
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(args.cfg.interval_secs.max(5))).await;
    }
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

/// Steps 3+4: fresh state → local sim → eth_call probe → venue submit.
/// Returns Some((pool, strikes)) when a pool should accrue a suppress strike.
async fn verify_and_submit(
    args: &FeedArgs,
    c: &FeedCandidate,
    next_id: &mut u32,
    registered: &mut HashSet<Address>,
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

    // Register the pools with the state refresher once, then pull state.
    let mut add = Vec::new();
    for (addr, proto) in [(c.pool_in, c.proto_in), (c.pool_out, c.proto_out)] {
        if registered.insert(addr) {
            add.push(PoolConfig {
                address: addr,
                protocol: proto,
                fee_bps: 0, // StateReader supplies real fee on-chain
                token0: None,
                token1: None,
            });
        }
    }
    if !add.is_empty() {
        args.refresher.add_pools(add);
    }
    let warmed = args
        .refresher
        .refresh_pools(&args.store, &[c.pool_in, c.pool_out])
        .await;
    if warmed < 2 {
        opp.simulation_status = SimulationStatus::Unusable;
        opp.rejection_reason = "state_unreadable".into();
        let _ = opp.append_jsonl(&args.data_dir);
        metrics::FEED_VERIFIED
            .with_label_values(&[&args.chain, "state_fail"])
            .inc();
        return None;
    }

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

    let path = PathTemplate {
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

    // Step 3 — on-chain verification gateway: reserves/slot0 were just
    // re-read; evaluate the round trip on that fresh state.
    let Some(sim) = evaluate_path(&path, &args.store) else {
        opp.simulation_status = SimulationStatus::Fail;
        opp.rejection_reason = "fresh_sim_fail".into();
        let _ = opp.append_jsonl(&args.data_dir);
        metrics::FEED_VERIFIED
            .with_label_values(&[&args.chain, "sim_fail"])
            .inc();
        return None;
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

    // Step 4 — abort if gross can't cover gas.
    let gas_usd = match args.endpoint.gas_price().await {
        Ok(gp) => {
            let native = args
                .token_usd_prices
                .iter()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(_, p)| *p)
                .unwrap_or(0.0);
            // ~600k gas round trip × gas price × native price.
            gp as f64 * 600_000.0 / 1e18 * native
        }
        Err(_) => 0.0,
    };
    opp.gas_usd = gas_usd;
    if gross_usd - gas_usd < args.cfg.min_net_usd {
        opp.rejection_reason = "negative_net_after_gas".into();
        let _ = opp.append_jsonl(&args.data_dir);
        metrics::FEED_REJECTS
            .with_label_values(&[&args.chain, "net_floor"])
            .inc();
        return None;
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
