//! profit_profile — offline decomposition of where candidate profit dies.
//!
//! Runs the REAL pipeline (enumerate → evaluate → optimize → gate) against
//! live chain state over N consecutive refreshes and reports, per candidate
//! and per reject stage, exactly where profit is lost:
//!
//!   pass1:     probe at template flash_amount (spread existence)
//!   sizing:    find_optimal_amount at the production cap (5% reserve) and a
//!              deeper counterfactual cap (50%) — answers "sizing too shallow?"
//!   depth:     max V3 in-range utilization across hops at the optimal size —
//!              util > 30% means the single-tick quote is extrapolating past
//!              liquidity we cannot see (depth mis-model risk)
//!   gate:      the production ProfitGate decision + a permissive
//!              counterfactual (no margin, no USD floor)
//!   coverage:  pools configured vs pools with live state, per protocol
//!
//! Usage: cargo run --release --bin profit_profile -- <config.toml> [cycles]
//! Default: 3 cycles. Every line is prefixed so `grep` slices cleanly.

use std::collections::HashMap;
use std::sync::Arc;

use alloy_primitives::{Address, U256};
use anyhow::Result;

use arb_core::types::*;
use arb_core::AmmQuoter;
use arb_mempool::MempoolWatcher;
use arb_paths::{PathEnumerator, PathTemplate};
use arb_rpc::Endpoint;
use arb_sim::evaluate::evaluate_all;
use arb_sim::optimize::{find_optimal_amount, path_max_flash};
use arb_sim::ProfitGate;
use arb_state::refresher::{PoolConfig, StateRefresher};
use arb_state::PoolStore;
use tokio::sync::mpsc;

#[path = "../config.rs"]
mod config;
#[path = "../pricing.rs"]
mod pricing;

const Q96: U256 = U256::from_limbs([0, 0x1_0000_0000, 0, 0]);

/// Raw signed bps for a path at its probe amount — evaluate_path drops
/// losers, but the near-miss distribution is what tells you whether the
/// spread exists at all. Returns None when a hop can't quote.
fn probe_bps(path: &PathTemplate, store: &PoolStore) -> Option<i64> {
    let mut cur = path.flash_amount;
    for hop in &path.hops {
        let pool_ref = store.get_ref(&hop.pool)?;
        let out = match &*pool_ref {
            PoolState::V2(s) => s.quote(hop.token_in, cur).ok()?,
            PoolState::V3(s) => s.quote(hop.token_in, cur).ok()?,
            PoolState::Curve(s) => s.quote(hop.token_in, cur).ok()?,
            PoolState::Wombat(s) => s.quote(hop.token_in, cur).ok()?,
            PoolState::Dodo(s) => s.quote(hop.token_in, cur).ok()?,
            PoolState::AeroV2(s) => s.quote(hop.token_in, cur).ok()?,
        };
        if out.is_zero() {
            return None;
        }
        cur = out;
    }
    if cur >= path.flash_amount {
        let p = (cur - path.flash_amount) * U256::from(10_000u32) / path.flash_amount;
        p.try_into().ok()
    } else {
        let l = (path.flash_amount - cur) * U256::from(10_000u32) / path.flash_amount;
        l.try_into().ok().map(|v: i64| -v)
    }
}

fn state_protocol(s: &PoolState) -> &'static str {
    match s {
        PoolState::V2(_) => "v2",
        PoolState::V3(_) => "v3",
        PoolState::Curve(_) => "pcs_stable",
        PoolState::Wombat(_) => "wombat",
        PoolState::Dodo(_) => "dodo",
        PoolState::AeroV2(_) => "aero_v2",
    }
}

/// In-range input-side utilization for a V3 hop at `amount_in`, in bps.
/// Mirrors the estimate inside `arb_core::v3::quote_multi_tick_approx`:
/// above ~30% the single-tick quote is extrapolating beyond the active
/// tick range and its output is a guess, not a measurement.
fn v3_util_bps(s: &V3PoolState, token_in: Address, amount_in: U256) -> u64 {
    if s.sqrt_price_x96.is_zero() || s.liquidity == 0 {
        return 10000;
    }
    let l = U256::from(s.liquidity);
    let reserve_in = if token_in == s.token0 {
        l.checked_mul(Q96)
            .and_then(|v| v.checked_div(s.sqrt_price_x96))
            .unwrap_or(U256::MAX)
    } else {
        l.checked_mul(s.sqrt_price_x96)
            .and_then(|v| v.checked_div(Q96))
            .unwrap_or(U256::MAX)
    };
    if reserve_in.is_zero() {
        return 10000;
    }
    let fee_amount = amount_in * U256::from(s.fee) / U256::from(1_000_000u32);
    let after_fee = amount_in.saturating_sub(fee_amount);
    ((after_fee * U256::from(10000u32)) / reserve_in)
        .try_into()
        .unwrap_or(10000)
}

fn max_v3_util_bps(path: &PathTemplate, store: &PoolStore, amount_in: U256) -> Option<u64> {
    // Walk the path at `amount_in`, returning the worst utilization among
    // V3 hops. None when the path dies mid-route (no usable quote).
    let mut cur = amount_in;
    let mut worst: u64 = 0;
    let mut seen_v3 = false;
    for hop in &path.hops {
        let pool = store.get_ref(&hop.pool)?;
        match &*pool {
            PoolState::V3(s) => {
                seen_v3 = true;
                let u = v3_util_bps(s, hop.token_in, cur);
                worst = worst.max(u);
                cur = s.quote(hop.token_in, cur).ok()?;
            }
            PoolState::V2(s) => cur = s.quote(hop.token_in, cur).ok()?,
            PoolState::Curve(s) => cur = s.quote(hop.token_in, cur).ok()?,
            PoolState::Wombat(s) => cur = s.quote(hop.token_in, cur).ok()?,
            PoolState::Dodo(s) => cur = s.quote(hop.token_in, cur).ok()?,
            PoolState::AeroV2(s) => cur = s.quote(hop.token_in, cur).ok()?,
        }
        if cur.is_zero() {
            return None;
        }
    }
    seen_v3.then_some(worst)
}

fn usd_value(amount: U256, token: &Address, prices: &HashMap<Address, f64>, decimals: &HashMap<Address, u32>) -> f64 {
    let price = prices.get(token).copied().unwrap_or(1.0);
    let dec = decimals.get(token).copied().unwrap_or(18);
    let amt_f: f64 = amount.try_into().map(|v: u128| v as f64).unwrap_or(f64::MAX);
    amt_f / 10f64.powi(dec as i32) * price
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("warn"))
        .init();

    let args: Vec<String> = std::env::args().collect();
    let config_path = args.get(1).map(String::as_str).unwrap_or("config/bsc.toml");
    let cycles: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3);
    // 0 = only pass-1 survivors get optimized; 1 = every path gets optimized
    // (counterfactual: does the fixed-probe filter drop profitable paths?).
    let optimize_all: bool = args.iter().any(|a| a == "--optimize-all");
    // --backrun <secs>: instead of scanning resting state, stream pending swaps
    // for `secs` seconds, project each onto the pool(s) it hits, and measure
    // post-swap profitability — the mode the runner's backrun path uses.
    let backrun_secs: Option<u64> = args
        .iter()
        .position(|a| a == "--backrun")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok());

    let cfg = config::load_config(config_path)?;
    println!("PROFILER chain={} config={config_path} cycles={cycles} optimize_all={optimize_all}", cfg.chain.name);

    let mut read_urls: Vec<&str> = cfg.chain.rpc_https_pool.iter().map(String::as_str).collect();
    if read_urls.is_empty() {
        read_urls.push(cfg.chain.rpc_https.as_str());
    }
    let endpoint = Arc::new(
        Endpoint::new_pooled(&read_urls, &cfg.chain.rpc_wss, None, cfg.chain.chain_id).await?,
    );
    println!("PROFILER read_pool_size={}", endpoint.read_pool_size());

    let tokens: HashMap<String, Address> = cfg
        .tokens
        .iter()
        .map(|(name, addr_str)| (name.clone(), addr_str.parse().expect("bad token addr")))
        .collect();

    let mut token_usd_prices: HashMap<Address, f64> = cfg
        .token_usd_prices
        .iter()
        .filter_map(|(name, &price)| tokens.get(name).map(|&a| (a, price)))
        .collect();

    let mut token_decimals: HashMap<Address, u32> = HashMap::new();
    for (name, &addr) in &tokens {
        let dec = match name.as_str() {
            "USDT" | "USDC" | "USDbC" | "BUSD" => 6,
            _ => 18,
        };
        token_decimals.insert(addr, dec);
    }

    // Pool set: identical construction to arb-runner (TOML only — the
    // discovery-store merge is an ops-box data artifact, not repo state).
    let mut pool_configs: Vec<PoolConfig> = cfg
        .pools
        .iter()
        .map(|p| PoolConfig {
            address: p.address.parse().expect("bad pool addr"),
            protocol: p.parse_protocol(),
            fee_bps: p.fee_bps,
            token0: tokens.get(&p.token0).copied(),
            token1: tokens.get(&p.token1).copied(),
        })
        .collect();

    let mut pool_infos: Vec<arb_paths::enumerate::PoolInfo> = cfg
        .pools
        .iter()
        .map(|p| arb_paths::enumerate::PoolInfo {
            address: p.address.parse().expect("bad pool addr"),
            protocol: p.parse_protocol(),
            token0: tokens[&p.token0],
            token1: tokens[&p.token1],
        })
        .collect();

    // Same boot normalization the runner applies: Uniswap-family token0 <
    // token1 sort on BOTH the graph infos and the refresher's pool_configs —
    // pool_tokens() feeds the slim Multicall3 path, so a config that stays
    // flipped fabricates inverted prices (phantom ~30% spreads measured).
    let mut normalized = 0u32;
    for pi in pool_infos.iter_mut() {
        let uni = matches!(
            pi.protocol,
            Protocol::UniswapV2 | Protocol::UniswapV3 | Protocol::UniswapV4
                | Protocol::Algebra | Protocol::AerodromeV2 | Protocol::AerodromeSlipstream
        );
        if uni && pi.token0 > pi.token1 {
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
        println!("PROFILER normalized_flipped_pools={normalized}");
    }

    let pool_fee_bps: HashMap<Address, u32> =
        pool_configs.iter().map(|c| (c.address, c.fee_bps)).collect();
    let store = Arc::new(PoolStore::new());
    let state_reader: Address = cfg.chain.state_reader.parse().unwrap_or(Address::ZERO);
    let refresher = StateRefresher::new(
        endpoint.clone(),
        state_reader,
        pool_configs,
        cfg.chain.chain_id,
    );

    let flash_tokens: Vec<Address> = cfg.scanner.flash_tokens.iter().map(|n| tokens[n]).collect();
    let flash_amounts: HashMap<Address, U256> = cfg
        .scanner
        .flash_amounts
        .iter()
        .map(|(n, &a)| (tokens[n], U256::from(a)))
        .collect();
    let flash_bounds: HashMap<Address, (U256, U256)> = cfg
        .scanner
        .flash_bounds
        .iter()
        .filter_map(|(n, b)| tokens.get(n).map(|&a| (a, (U256::from(b.min), U256::from(b.max)))))
        .collect();

    let enumerator = PathEnumerator::new(pool_infos.clone(), flash_tokens, flash_amounts)
        .with_limits(config::spec::MAX_PATH_HOPS, 25_000, 200);
    let paths = enumerator.enumerate();
    println!("PROFILER paths={} max_hops={}", paths.len(), config::spec::MAX_PATH_HOPS);

    // Production gate and the permissive counterfactual (no margin/floor).
    let real_gate = ProfitGate::new(
        cfg.scanner.min_profit_bps,
        config::min_profit_usd_floor(cfg.gate.min_profit_usd),
        cfg.gate.safety_margin_bps,
        cfg.gate.stable_pool_extra_margin_bps,
        token_usd_prices.clone(),
        token_decimals.clone(),
    );
    let free_gate = ProfitGate::new(
        0, 0.0, 0, 0, token_usd_prices.clone(), token_decimals.clone(),
    );

    if let Some(secs) = backrun_secs {
        // Same indexes the runner's backrun path uses.
        let mut pair_to_pools: HashMap<(Address, Address), Vec<(Address, u32)>> = HashMap::new();
        for p in &pool_infos {
            let key = if p.token0 < p.token1 { (p.token0, p.token1) } else { (p.token1, p.token0) };
            let fee = pool_fee_bps.get(&p.address).copied().unwrap_or(0);
            pair_to_pools.entry(key).or_default().push((p.address, fee));
        }
        let mut pool_to_paths: HashMap<Address, Vec<usize>> = HashMap::new();
        for (idx, path) in paths.iter().enumerate() {
            for hop in &path.hops {
                pool_to_paths.entry(hop.pool).or_default().push(idx);
            }
        }

        // Leader wallet intelligence — same observer as the runner loop:
        // scores every sender, auto-promotes candidates, persists JSONL.
        let leader_observer = {
            let enabled = !cfg.leaders.wallets.is_empty() || cfg.leaders.discover;
            enabled.then(|| {
                arb_leaders::LeaderObserver::new(
                    arb_leaders::LeaderRegistry::new(&cfg.leaders),
                    std::path::PathBuf::from("data/leaders"),
                    cfg.chain.name.clone(),
                    &cfg.leaders,
                )
            })
        };
        if let Some(o) = &leader_observer {
            println!("PROFILER leaders enabled=1 wallets={} discover={}",
                o.wallet_count(), cfg.leaders.discover);
        }

        // Fresh state so projections sit on current reserves.
        let _ = refresher.refresh(&store).await?;
        pricing::derive_prices(&store, &mut token_usd_prices, &token_decimals);

        // Quarantine pools whose implied price diverges >3x from same-pair
        // peers — broken/exhausted state fabricates phantom arb legs.
        let pool_tokens: HashMap<Address, (Address, Address)> = pool_infos
            .iter()
            .map(|p| (p.address, (p.token0, p.token1)))
            .collect();
        let quarantined = arb_mempool::impact::quarantine_outlier_pools(
            &store, &pair_to_pools, &pool_tokens, 3.0);
        if !quarantined.is_empty() {
            println!("PROFILER quarantined_pools={quarantined:?}");
        }

        // Sim verification gate — Commander directive: discovery→execution is
        // auto-approved ONLY after our own simulator reproduces a positive
        // profit through a shadow strategy's route pools on live state.
        // Bounded cap $25 notional. replay/shadow records are evaluated;
        // mark_verified performs the shadow->bounded_live auto-transition.
        {
            const VERIFY_CAP_USD: f64 = 25.0;
            let mut strat = arb_leaders::StrategyRegistry::load(&cfg.chain.name, 20_000);
            let hi = store.last_block();
            let mut n_ver = 0u32;
            let ids: Vec<(String, Vec<String>)> = strat
                .records
                .values()
                .filter(|r| matches!(r.state,
                    arb_leaders::StrategyState::Shadow
                        | arb_leaders::StrategyState::Replay
                        | arb_leaders::StrategyState::BoundedLive))
                .filter(|r| !r.route_pools.is_empty())
                .map(|r| (r.strategy_id.clone(), r.route_pools.clone()))
                .collect();
            for (id, route) in &ids {
                // Candidate paths sharing at least one route pool, minus quarantined.
                let mut cand: HashMap<usize, usize> = HashMap::new();
                for p in route {
                    let pa = match p.parse::<Address>() { Ok(a) => a, Err(_) => continue };
                    if let Some(v) = pool_to_paths.get(&pa) {
                        for &i in v { *cand.entry(i).or_default() += 1; }
                    }
                }
                let mut ranked: Vec<usize> = cand.iter()
                    .filter(|(&i, _)| !paths[i].hops.iter().any(|h| quarantined.contains(&h.pool)))
                    .map(|(&i, _)| i)
                    .collect();
                ranked.sort_unstable_by(|&a, &b| cand[&b].cmp(&cand[&a]));
                let mut best_usd = 0.0;
                for &pi in ranked.iter().take(30) {
                    let path = &paths[pi];
                    let (min_a, token_max) = flash_bounds
                        .get(&path.flash_token)
                        .copied()
                        .unwrap_or((path.flash_amount, path.flash_amount * U256::from(10u32)));
                    let hi = token_max.min(path_max_flash(path, &store, 0.05, token_max));
                    if let Some((_, prof)) = find_optimal_amount(
                        path, &store, min_a, hi,
                        cfg.scanner.optimization_iterations) {
                        if !prof.is_zero() {
                            let usd = usd_value(
                                prof, &path.flash_token,
                                &token_usd_prices, &token_decimals);
                            if usd > best_usd { best_usd = usd; }
                        }
                    }
                }
                if best_usd > 0.0 {
                    if strat.mark_verified(id, best_usd, VERIFY_CAP_USD) {
                        println!("VERIFY {id} profit_usd={best_usd:.1} cap_usd={VERIFY_CAP_USD} -> bounded_live");
                        n_ver += 1;
                    }
                }
            }
            if n_ver > 0 || !ids.is_empty() {
                let _ = strat.expire_stale(hi);
                let _ = strat.save();
            }
            println!("STRATEGY_VERIFY evaluated={} verified={n_ver} block={hi}", ids.len());
        }

        let mut wss_urls = cfg.chain.rpc_wss_pool.clone();
        wss_urls.retain(|u| !u.trim().is_empty());
        if wss_urls.is_empty() {
            wss_urls.push(cfg.chain.rpc_wss.clone());
        }
        let (tx, mut rx) = mpsc::channel(1000);
        let cid = cfg.chain.chain_id;
        tokio::spawn(async move {
            let watcher = MempoolWatcher::new(&wss_urls, cid);
            let _ = watcher.start(tx).await;
        });

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        let mut last_refresh = std::time::Instant::now();
        let (mut n_rx, mut n_amt, mut n_pair, mut n_cand) = (0u64, 0u64, 0u64, 0u64);
        let (mut n_prof, mut n_gate) = (0u64, 0u64);
        let mut best_bps = 0u32;
        let mut top: Vec<(u32, f64, &'static str, String, Option<f64>)> = Vec::new();
        let mut router_stats: HashMap<&'static str, (u64, u64)> = HashMap::new();
        let mut dumped = 0u32;

        while std::time::Instant::now() < deadline {
            let pending = match tokio::time::timeout(
                std::time::Duration::from_millis(100), rx.recv(),
            ).await {
                Ok(Some(p)) => p,
                Ok(None) => break,
                Err(_) => continue,
            };
            n_rx += 1;
            if let Some(o) = &leader_observer {
                o.observe(&pending);
            }
            router_stats.entry(pending.decoded.router).or_insert((0, 0)).0 += 1;
            if last_refresh.elapsed() > std::time::Duration::from_secs(20) {
                let _ = refresher.refresh(&store).await;
                last_refresh = std::time::Instant::now();
            }
            let amount_in = match pending.decoded.amount_in {
                Some(a) => a,
                // Direct pool calls carry no input amount in calldata —
                // it's recovered from reserves inside projection.
                None if pending.decoded.direct.is_some() => U256::ZERO,
                None => {
                    if dumped < 3 {
                        dumped += 1;
                        let hex: String = pending.raw_input.iter().map(|b| format!("{b:02x}")).collect();
                        println!("PROFILER   DUMP {} to={} len={} calldata={}",
                            pending.decoded.router, pending.to, pending.raw_input.len(), hex);
                    }
                    continue;
                }
            };
            n_amt += 1;
            router_stats.get_mut(pending.decoded.router).map(|s| s.1 += 1);
            // Project every hop of the pending path onto tracked pools;
            // a pair match on ANY hop (not just the first) now counts.
            // Direct calls name the pool itself — always a "pair match" in
            // spirit; the projection drops untracked pools itself.
            let hit_any_pair = pending.decoded.direct.is_some() || pending.decoded.path.windows(2).any(|w| {
                let (a, b) = (w[0], w[1]);
                pair_to_pools.contains_key(&if a < b { (a, b) } else { (b, a) })
            }) || (pending.decoded.token_in.is_some()
                && pending.decoded.token_out.is_some()
                && {
                    let (a, b) = (pending.decoded.token_in.unwrap(), pending.decoded.token_out.unwrap());
                    pair_to_pools.contains_key(&if a < b { (a, b) } else { (b, a) })
                });
            if !hit_any_pair { continue; }
            n_pair += 1;
            let Some((projected, hit_pools, victim_usd)) =
                arb_mempool::impact::project_pending_path(
                    &store, &pending.decoded, amount_in, &pair_to_pools,
                    &token_usd_prices, &token_decimals,
                )
            else { continue };
            let mut cand: Vec<usize> = Vec::new();
            for pa in &hit_pools {
                if quarantined.contains(pa) { continue; }
                if let Some(ids) = pool_to_paths.get(pa) {
                    cand.extend_from_slice(ids);
                }
            }
            if cand.is_empty() { continue; }
            cand.sort_unstable();
            cand.dedup();
            cand.retain(|&i| !paths[i].hops.iter().any(|h| quarantined.contains(&h.pool)));
            if cand.is_empty() { continue; }
            n_cand += 1;

            let mut best_for_swap: Option<(U256, u32, Address)> = None;
            let mut best_path: Option<usize> = None;
            let mut victim_usd_dbg = victim_usd;
            // Cheap screen: rank candidate paths by single-point profit at
            // their min flash amount so the 20 full optimizations go to the
            // most promising routes instead of the first 20 by index.
            let mut screened: Vec<(usize, U256)> = cand
                .iter()
                .map(|&i| {
                    let p = &paths[i];
                    let min_a = flash_bounds
                        .get(&p.flash_token)
                        .map(|b| b.0)
                        .unwrap_or(p.flash_amount);
                    // Two probe points: unimodal profit curves can start at
                    // zero for small clips — a mid-size probe catches paths
                    // that only profit at larger flash amounts.
                    let hi_probe = (min_a * U256::from(10u32))
                        .min(flash_bounds.get(&p.flash_token).map(|b| b.1)
                            .unwrap_or(p.flash_amount * U256::from(10u32)));
                    let s = arb_sim::optimize::simulate_profit(p, min_a, &projected)
                        .max(arb_sim::optimize::simulate_profit(p, hi_probe, &projected));
                    (i, s)
                })
                .collect();
            screened.sort_by(|a, b| b.1.cmp(&a.1));
            for &(pidx, _) in screened.iter().take(20) {
                let path = &paths[pidx];
                let (min_a, token_max) = flash_bounds
                    .get(&path.flash_token)
                    .copied()
                    .unwrap_or((path.flash_amount, path.flash_amount * U256::from(10u32)));
                let liq_max = path_max_flash(path, &projected, 0.05, token_max);
                let hi = token_max.min(liq_max);
                let Some((amt, prof)) =
                    find_optimal_amount(path, &projected, min_a, hi, cfg.scanner.optimization_iterations)
                else { continue };
                if prof.is_zero() { continue; }
                let bps: u32 = ((prof * U256::from(10000u32)) / amt).try_into().unwrap_or(u32::MAX);
                let sim = arb_sim::SimResult {
                    path_id: path.id,
                    flash_token: path.flash_token,
                    flash_amount: amt,
                    final_amount: amt + prof,
                    gross_profit: prof,
                    profit_bps: bps,
                };
                let dec = real_gate.should_submit(&sim, path);
                // Cap: a backrun can't extract more than the victim's input.
                // Capped candidates are phantom projections — excluded from
                // gate_pass AND the best/top display, same as the runner.
                // Implausible decoded victim size (>~$100M) = decode garbage,
                // same unverifiable class as an exceeded cap.
                let capped = victim_usd.map_or(false, |v| {
                    v > 1e8 || dec.effective_profit_usd > v
                });
                if dec.accept && !capped {
                    n_gate += 1;
                    if best_for_swap.map_or(true, |(p, _, _)| prof > p) {
                        best_for_swap = Some((prof, bps, path.flash_token));
                        best_path = Some(pidx);
                    }
                }
            }
            if let Some((prof, bps, ft)) = best_for_swap {
                n_prof += 1;
                if bps > best_bps { best_bps = bps; }
                let usd = usd_value(prof, &ft, &token_usd_prices, &token_decimals);
                let pools_dbg = best_path
                    .map(|i| paths[i].hops.iter().map(|h| format!("{:#x}", h.pool)).collect::<Vec<_>>().join(","))
                    .unwrap_or_default();
                top.push((bps, usd, pending.decoded.router, pools_dbg, victim_usd_dbg));
            }
        }
        top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        println!(
            "PROFILER backrun window_secs={secs} pending_rx={n_rx} with_amount={n_amt} \
             pair_match={n_pair} candidates={n_cand} projected_profitable={n_prof} \
             gate_pass={n_gate} best_bps={best_bps}"
        );
        for (bps, usd, router, pools, vusd) in top.iter().take(10) {
            println!("PROFILER   BACKRUN bps={bps} gross_usd={usd:.4} router={router} victim_usd={vusd:?} pools={pools}");
        }
        let mut rs: Vec<_> = router_stats.into_iter().collect();
        rs.sort_by(|a, b| b.1.0.cmp(&a.1.0));
        for (router, (dec, amt)) in rs {
            println!("PROFILER   ROUTER {router} decoded={dec} with_amount={amt}");
        }
        if let Some(o) = &leader_observer {
            println!(
                "PROFILER leaders wallets={} discovered={} scored_senders={}",
                o.wallet_count(),
                o.discovered_wallets(),
                o.scored_senders()
            );
            for (addr, score, obs, class) in o.top_senders(10) {
                println!(
                    "PROFILER   LEADER score={score:.1} obs={obs} class={class} {addr:#x}"
                );
            }
        }
        return Ok(());
    }

    let mut best_ever: Option<(f64, String)> = None;
    let mut gate_hist: HashMap<&'static str, u64> = HashMap::new();

    for cycle in 0..cycles {
        let (_updated, _) = refresher.refresh(&store).await?;
        if cycle == 0 {
            pricing::derive_prices(&store, &mut token_usd_prices, &token_decimals);
            // Coverage report: configured vs live state, per protocol.
            // Liveness keyed by the configured protocol — algebra pools store
            // as PoolState::V3, so counting by state type miscounts them.
            let key_of = |p: Protocol| match p {
                Protocol::UniswapV2 => "v2",
                Protocol::UniswapV3 | Protocol::AerodromeSlipstream => "v3",
                Protocol::Algebra => "algebra",
                Protocol::AerodromeV2 => "aero_v2",
                Protocol::PancakeStable => "pcs_stable",
                Protocol::Wombat => "wombat",
                Protocol::DodoV2 => "dodo",
                Protocol::UniswapV4 => "v4",
            };
            let mut live: HashMap<&'static str, u32> = HashMap::new();
            let mut want: HashMap<&'static str, u32> = HashMap::new();
            for pc in &pool_infos {
                let key = key_of(pc.protocol);
                *want.entry(key).or_insert(0) += 1;
                if store.get(&pc.address).is_some() {
                    *live.entry(key).or_insert(0) += 1;
                }
            }
            for (key, want_n) in &want {
                let got = live.get(key).copied().unwrap_or(0);
                let flag = if got < *want_n { "  <-- DEAD CLASS" } else { "" };
                println!("PROFILER coverage proto={key} configured={want_n} live={got}{flag}");
            }
            println!("PROFILER pools_configured={} pools_live={} priced_tokens={}",
                pool_infos.len(), store.pool_count(), token_usd_prices.len());
            for pi in &pool_infos {
                match store.get(&pi.address) {
                    Some(PoolState::V3(s)) => println!("PROFILER v3state {}..{} sqrtP={:#x} liq={} fee={} t0={} t1={}",
                        &format!("{}", pi.address)[..8], &format!("{}", pi.address)[38..],
                        s.sqrt_price_x96, s.liquidity, s.fee, s.token0, s.token1),
                    Some(PoolState::V2(s)) => println!("PROFILER v2state {}..{} r0={} r1={} fee_bps={} t0={} t1={}",
                        &format!("{}", pi.address)[..8], &format!("{}", pi.address)[38..],
                        s.reserve0, s.reserve1, s.fee_bps, s.token0, s.token1),
                    Some(o) => println!("PROFILER otherstate {}..{} {}",
                        &format!("{}", pi.address)[..8], &format!("{}", pi.address)[38..], state_protocol(&o)),
                    None => println!("PROFILER nostate {}..{} {:?}", 
                        &format!("{}", pi.address)[..8], &format!("{}", pi.address)[38..], pi.protocol),
                }
            }
        }

        let initial = evaluate_all(&paths, &store);
        let candidates: Vec<_> = initial
            .iter()
            .filter(|r| r.profit_bps >= cfg.scanner.min_initial_bps)
            .collect();

        // Near-miss distribution: signed probe bps for every quotable path.
        {
            let mut probes: Vec<(i64, usize)> = paths
                .iter()
                .enumerate()
                .filter_map(|(i, p)| probe_bps(p, &store).map(|b| (b, i)))
                .collect();
            probes.sort_by(|a, b| b.0.cmp(&a.0));
            let quoted = probes.len();
            let ge0 = probes.iter().filter(|(b, _)| *b >= 0).count();
            let ge5 = probes.iter().filter(|(b, _)| *b >= 5).count();
            let ge10 = probes.iter().filter(|(b, _)| *b >= 10).count();
            let ge25 = probes.iter().filter(|(b, _)| *b >= 25).count();
            let ge50 = probes.iter().filter(|(b, _)| *b >= 50).count();
            println!("PROFILER probe_dist quoted={quoted} ge0bps={ge0} ge5={ge5} ge10={ge10} ge25={ge25} ge50={ge50}");
            for (b, i) in probes.iter().take(5) {
                let path = &paths[*i];
                let protos: Vec<String> = path.hops.iter().map(|h| format!("{:?}", h.protocol)).collect();
                let hops: Vec<String> = path.hops.iter().map(|h| {
                    let p = format!("{}", h.pool);
                    format!("{}..{}", &p[..8], &p[38..])
                }).collect();
                println!("PROFILER   NEARMISS path={} probe_bps={} protos={:?} pools={:?}", path.id, b, protos, hops);
            }
        }

        // Counterfactual: paths the pass-1 probe amount kills but the
        // optimizer would have found profitable at some other size.
        let rescued = if optimize_all {
            let mut rescued = Vec::new();
            for (i, path) in paths.iter().enumerate() {
                let (min_a, token_max) = flash_bounds
                    .get(&path.flash_token)
                    .copied()
                    .unwrap_or((path.flash_amount, path.flash_amount * U256::from(10u32)));
                let max_a = token_max.min(path_max_flash(path, &store, 0.05, token_max));
                if let Some((amt, prof)) =
                    find_optimal_amount(path, &store, min_a, max_a, cfg.scanner.optimization_iterations)
                {
                    if !prof.is_zero() && initial.iter().all(|r| r.path_id as usize != i) {
                        rescued.push((path.id, amt, prof));
                    }
                }
            }
            rescued
        } else {
            Vec::new()
        };

        let mut top: Vec<(f64, String)> = Vec::new();
        for c in &candidates {
            let path = &paths[c.path_id as usize];
            let (min_a, token_max) = flash_bounds
                .get(&path.flash_token)
                .copied()
                .unwrap_or((path.flash_amount, path.flash_amount * U256::from(10u32)));

            // Production sizing (5% cap) vs deep counterfactual (50% cap).
            let max_prod = token_max.min(path_max_flash(path, &store, 0.05, token_max));
            let max_deep = token_max.min(path_max_flash(path, &store, 0.50, token_max));
            let opt = find_optimal_amount(path, &store, min_a, max_prod, cfg.scanner.optimization_iterations);
            let opt_deep = find_optimal_amount(path, &store, min_a, max_deep, cfg.scanner.optimization_iterations);
            let (opt_amt, opt_profit) = match opt {
                Some(v) => v,
                None => continue,
            };

            let bps = ((opt_profit * U256::from(10000u32)) / opt_amt).try_into().unwrap_or(u32::MAX);
            let sim = arb_sim::SimResult {
                path_id: c.path_id,
                flash_token: path.flash_token,
                flash_amount: opt_amt,
                final_amount: opt_amt + opt_profit,
                gross_profit: opt_profit,
                profit_bps: bps,
            };
            let dec = real_gate.should_submit(&sim, path);
            let dec_free = free_gate.should_submit(&sim, path);
            *gate_hist.entry(dec.reject_reason.unwrap_or("accept")).or_insert(0) += 1;

            let gross_usd = usd_value(opt_profit, &path.flash_token, &token_usd_prices, &token_decimals);
            let deep_usd = opt_deep.map(|(_a, p)| {
                usd_value(p, &path.flash_token, &token_usd_prices, &token_decimals)
            }).unwrap_or(0.0);
            let util = max_v3_util_bps(path, &store, opt_amt);
            let protos: Vec<String> = path.hops.iter().map(|h| format!("{:?}", h.protocol)).collect();
            let hops: Vec<String> = path.hops.iter().map(|h| {
                let p = format!("{}", h.pool);
                format!("{}..{}", &p[..8], &p[38..])
            }).collect();

            top.push((dec_free.effective_profit_usd.max(gross_usd), format!(
                "CAND path={} hops={} protos={:?} pools={:?} probe_bps={} opt_amt={} opt_bps={} gross_usd={:.6} deep_usd={:.6} free_usd={:.6} real_usd={:.6} reason={:?} v3_util_bps={:?}",
                c.path_id, path.num_hops(), protos, hops, c.profit_bps, opt_amt, bps,
                gross_usd, deep_usd, dec_free.effective_profit_usd,
                dec.effective_profit_usd, dec.reject_reason, util,
            )));
        }

        top.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        println!("PROFILER cycle={cycle} block={} pass1_profitable={} candidates={} rescued_by_optimizer={}",
            store.last_block(), initial.len(), candidates.len(), rescued.len());
        for (_, line) in top.iter().take(10) {
            println!("PROFILER   {line}");
        }
        if let Some((score, line)) = top.into_iter().next() {
            if best_ever.as_ref().map_or(true, |(s, _)| score > *s) {
                best_ever = Some((score, line));
            }
        }
        if !rescued.is_empty() {
            for (pid, amt, prof) in rescued.iter().take(10) {
                println!("PROFILER   RESCUED path={pid} opt_amt={amt} gross={prof}");
            }
        }
    }

    println!("PROFILER ==== summary ====");
    for (k, v) in &gate_hist {
        println!("PROFILER gate_decisions {k}={v}");
    }
    if let Some((_, line)) = &best_ever {
        println!("PROFILER best_seen: {line}");
    }
    Ok(())
}
