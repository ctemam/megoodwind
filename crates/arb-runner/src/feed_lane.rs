//! Pre-built feed lane — the ToR engine: ingest aggregated GeckoTerminal
//! spreads over REST instead of raw mempool scanning.
//!
//! Pipeline per ToR:
//!   1. Ingest: `GET /api/v2/networks/<net>/tokens/<token>/pools` → top
//!      pools per watch token.
//!   2. Filter: DEX-only (labels map to V2/V3 AMMs), liquidity floor,
//!      min h1 activity, quote parity (same flash-quote both legs).
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
    /// Watch tokens to scan, addr -> symbol (resolved from [feed].tokens).
    pub watch_tokens: HashMap<Address, String>,
    /// Allowed flash/quote assets, addr -> (usd_price, decimals).
    pub flash_quotes: HashMap<Address, (f64, u8)>,
    /// addr -> usd price for P&L bookkeeping.
    pub token_usd_prices: HashMap<Address, f64>,
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
    quote_token_price_base_token: Option<String>,
    #[serde(default)]
    transactions: Option<GtTxns>,
}

#[derive(Debug, Deserialize)]
struct GtPool {
    attributes: GtAttrs,
    relationships: Option<GtRels>,
}

/// One GT pool normalized to "the watch token costs `price` counter-tokens".
struct NormPool {
    pool: Address,
    proto: Protocol,
    counter: Address, // the flash-quote asset on the other side
    price: f64,       // watch-token price denominated in `counter`
    liquidity_usd: f64,
    h1_txns: u64,
}

impl GtPool {
    /// Normalize into watch-token terms; None when unparseable/non-AMM.
    fn normalize(&self, watch: Address) -> Option<NormPool> {
        let a = &self.attributes;
        let pool: Address = a.address.parse().ok()?;
        let rel = self.relationships.as_ref()?;
        let base_id = rel.base_token.as_ref()?.data.as_ref()?.id.as_str();
        let quote_id = rel.quote_token.as_ref()?.data.as_ref()?.id.as_str();
        let base: Address = base_id.split('_').nth(1)?.parse().ok()?;
        let quote: Address = quote_id.split('_').nth(1)?.parse().ok()?;
        // Watch-token price denominated in the counter asset, whichever
        // side of the pair the watch token sits on.
        let (counter, price) = if base == watch {
            (
                quote,
                a.base_token_price_quote_token.as_deref()?.parse().ok()?,
            )
        } else if quote == watch {
            (
                base,
                a.quote_token_price_base_token.as_deref()?.parse().ok()?,
            )
        } else {
            return None;
        };
        let dex = rel
            .dex
            .as_ref()
            .and_then(|d| d.data.as_ref())
            .map(|d| d.id.as_str())
            .unwrap_or("");
        let proto = protocol_for(dex, &a.name)?;
        let liquidity_usd = a
            .reserve_in_usd
            .as_deref()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        let h1_txns = self
            .attributes
            .transactions
            .as_ref()
            .and_then(|t| t.h1.as_ref())
            .map(|h| h.buys + h.sells)
            .unwrap_or(0);
        Some(NormPool {
            pool,
            proto,
            counter,
            price,
            liquidity_usd,
            h1_txns,
        })
    }
}

/// DEX id / pool name → AMM interface. Anything not matching the V2 or V3
/// swap interface is a non-atomic venue for our executor — dropped.
fn protocol_for(dex_id: &str, name: &str) -> Option<Protocol> {
    let d = dex_id.to_ascii_lowercase();
    if d.contains("clmm") || d.contains("stable") || d.contains("curve")
        || d.contains("dodo") || d.contains("wombat") || d.contains("v4")
        || d.contains("integral") || d.contains("solidly") || d.contains("algebra")
    {
        return None;
    }
    if d.contains("v3") || name.contains('%') && d.contains("uniswap") {
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
    {
        return Some(Protocol::UniswapV2);
    }
    // "uniswap-bsc" etc without a version token: a fee% in the pool name
    // means concentrated-liquidity V3.
    if name.contains('%') {
        Some(Protocol::UniswapV3)
    } else {
        None
    }
}

struct FeedCandidate {
    token: Address,
    token_sym: String,
    quote: Address,
    buy_pool: Address,
    sell_pool: Address,
    buy_proto: Protocol,
    sell_proto: Protocol,
    spread_bps: f64,
    min_liquidity_usd: f64,
}

pub fn spawn(args: FeedArgs) -> tokio::task::JoinHandle<()> {
    info!(
        chain = %args.chain,
        tokens = args.watch_tokens.len(),
        quotes = args.flash_quotes.len(),
        submit = args.submit_enabled,
        "feed lane armed — GeckoTerminal ingestion"
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
    let mut next_id: u32 = 0xF00D;
    // Pools that reverted at exec — suppressed for 1h after 2 strikes.
    let mut suppressed: HashMap<Address, (u32, Instant)> = HashMap::new();
    // (token, buy, sell) re-eval cooldown — a spread that died gets a rest.
    let mut cooldown: HashMap<(Address, Address, Address), Instant> = HashMap::new();
    // Pools already pushed into the refresher config.
    let mut registered: HashSet<Address> = HashSet::new();

    loop {
        for (token, sym) in &args.watch_tokens {
            let url = format!(
                "https://api.geckoterminal.com/api/v2/networks/{slug}/tokens/{token}/pools?page=1"
            );
            let pools: Vec<GtPool> = match fetch(&client, &url).await {
                Some(p) => p,
                None => {
                    metrics::FEED_REJECTS
                        .with_label_values(&[&args.chain, "fetch"])
                        .inc();
                    continue;
                }
            };
            metrics::FEED_SCANNED.with_label_values(&[&args.chain]).inc();

            // Step 2 — rigid filters + normalize to watch-token terms.
            let mut by_quote: HashMap<Address, Vec<NormPool>> = HashMap::new();
            for raw in &pools {
                let Some(p) = raw.normalize(*token) else {
                    continue; // token not a constituent — shouldn't happen
                };
                if p.price <= 0.0 {
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
                if !args.flash_quotes.contains_key(&p.counter) {
                    continue; // quote parity: counter must be a flash asset
                }
                by_quote.entry(p.counter).or_default().push(p);
            }

            for (quote, mut group) in by_quote {
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
                let (buy_pool, sell_pool) = (lo_p.pool, hi_p.pool);
                if suppressed
                    .get(&buy_pool)
                    .or_else(|| suppressed.get(&sell_pool))
                    .map(|(_, until)| Instant::now() < *until)
                    .unwrap_or(false)
                {
                    metrics::FEED_REJECTS
                        .with_label_values(&[&args.chain, "pool_suppressed"])
                        .inc();
                    continue;
                }
                let key = (*token, buy_pool, sell_pool);
                if cooldown
                    .get(&key)
                    .map(|t| t.elapsed() < Duration::from_secs(120))
                    .unwrap_or(false)
                {
                    continue;
                }
                let min_liq = lo_p.liquidity_usd.min(hi_p.liquidity_usd);
                let cand = FeedCandidate {
                    token: *token,
                    token_sym: sym.clone(),
                    quote,
                    buy_pool,
                    sell_pool,
                    buy_proto: lo_p.proto,
                    sell_proto: hi_p.proto,
                    spread_bps,
                    min_liquidity_usd: min_liq,
                };
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
        }
        tokio::time::sleep(Duration::from_secs(args.cfg.interval_secs.max(5))).await;
    }
}

async fn fetch(client: &reqwest::Client, url: &str) -> Option<Vec<GtPool>> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    serde_json::from_value(v.get("data")?.clone()).ok()
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
        "feed_dexscreener",
        "dexscreener_api",
        &format!("{}/{}", c.buy_pool, c.sell_pool),
        vec![format!("{}", c.buy_pool), format!("{}", c.sell_pool)],
    );
    opp.token_in = format!("{}", c.quote);
    opp.token_out = format!("{}", c.token);
    opp.profit_bps = c.spread_bps;

    // Register the pools with the state refresher once, then pull state.
    let mut add = Vec::new();
    for (addr, proto) in [(c.buy_pool, c.buy_proto), (c.sell_pool, c.sell_proto)] {
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
        .refresh_pools(&args.store, &[c.buy_pool, c.sell_pool])
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
    // converted to quote-token wei.
    let Some(&(quote_usd, quote_dec)) = args.flash_quotes.get(&c.quote) else {
        return None;
    };
    let notional = args
        .cfg
        .max_notional_usd
        .min(c.min_liquidity_usd * args.cfg.pool_share_bps / 10_000.0);
    if notional <= 0.0 || quote_usd <= 0.0 {
        return None;
    }
    let units = notional / quote_usd;
    let flash_amount = U256::from(units as u128)
        .saturating_mul(U256::from(10u64).pow(U256::from(quote_dec as u32)));

    let path = PathTemplate {
        id: *next_id,
        flash_token: c.quote,
        flash_amount,
        hops: vec![
            HopTemplate {
                protocol: c.buy_proto,
                pool: c.buy_pool,
                token_in: c.quote,
                token_out: c.token,
            },
            HopTemplate {
                protocol: c.sell_proto,
                pool: c.sell_pool,
                token_in: c.token,
                token_out: c.quote,
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
        / 10f64.powi(quote_dec as i32)
        * quote_usd;
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
    let zero_key = PoolKey {
        currency0: Address::ZERO,
        currency1: Address::ZERO,
        fee: alloy_primitives::Uint::from(0u32),
        tickSpacing: alloy_primitives::Signed::<24, 1>::ZERO,
        hooks: Address::ZERO,
    };
    let instructions = vec![
        SwapInstruction {
            protocol: c.buy_proto.to_contract_enum(args.chain_id),
            pool: c.buy_pool,
            poolKey: zero_key.clone(),
            tokenIn: c.quote,
            tokenOut: c.token,
            minOut: U256::ZERO,
        },
        SwapInstruction {
            protocol: c.sell_proto.to_contract_enum(args.chain_id),
            pool: c.sell_pool,
            poolKey: zero_key,
            tokenIn: c.token,
            tokenOut: c.quote,
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
        asset: c.quote,
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
            // strike the cheaper (tighter) pool first.
            return Some((c.buy_pool, 1));
        }
    }

    if !args.submit_enabled {
        opp.execution_status = ExecutionStatus::Ready;
        let _ = opp.append_jsonl(&args.data_dir);
        info!(
            chain = %args.chain,
            token = %c.token_sym,
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
            token = %c.token_sym,
            buy = %c.buy_pool,
            sell = %c.sell_pool,
            est_net_usd = gross_usd - gas_usd,
            "feed: arbitrage submitted"
        );
    } else {
        opp.execution_status = ExecutionStatus::Dropped;
        opp.rejection_reason = "venue_reject".into();
        metrics::FEED_REJECTS
            .with_label_values(&[&args.chain, "venue_reject"])
            .inc();
        // Bundler sim revert → strike both pools; the fee-model or
        // liquidity was wrong somewhere in the pair.
        let sell_strike = results.iter().any(|r| {
            r.result
                .as_ref()
                .map(|s| s.error.as_deref().unwrap_or("").contains("revert"))
                .unwrap_or(false)
        });
        if sell_strike {
            return Some((c.sell_pool, 1));
        }
    }
    let _ = opp.append_jsonl(&args.data_dir);
    None
}
