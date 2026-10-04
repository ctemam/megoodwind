// Refreshes live pool state and dumps what the store holds for the pools on a
// given path, then simulates each hop — used to localize phantom-profit hops.
// Usage: statecheck <config.toml> <chain_name> <path_id>

use std::collections::HashMap;
use std::sync::Arc;

use alloy_primitives::{Address, U256};
use anyhow::Result;
use arb_core::types::*;
use arb_core::AmmQuoter;
use arb_discovery::store::DiscoveryStore;
use arb_paths::enumerate::{PathEnumerator, PoolInfo};
use arb_state::refresher::{PoolConfig, StateRefresher};
use arb_state::PoolStore;
use arb_rpc::endpoint::Endpoint;
use arb_core::types::Protocol;

#[path = "../config.rs"]
mod config;
#[path = "../token_safety.rs"]
mod token_safety;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let mut args = std::env::args().skip(1);
    let cfg_path = args.next().expect("usage: statecheck <config> <chain> <path_id>");
    let chain_name = args.next().expect("chain");
    let want_id: u32 = args.next().expect("path_id").parse()?;

    let cfg = config::load_config(&cfg_path)?;
    let tokens: HashMap<String, Address> = cfg
        .tokens
        .iter()
        .map(|(n, a)| (n.clone(), a.parse().expect("bad token")))
        .collect();
    let token_syms: HashMap<Address, String> = tokens
        .iter()
        .map(|(n, a)| (*a, n.clone()))
        .collect();
    let sym = |a: &Address| token_syms.get(a).cloned().unwrap_or_else(|| format!("{a:?}"));

    let mut pool_infos: Vec<PoolInfo> = cfg
        .pools
        .iter()
        .filter_map(|p| p.pseudo_address().ok().map(|address| PoolInfo {
            address,
            protocol: p.parse_protocol(),
            token0: tokens[&p.token0],
            token1: tokens[&p.token1],
            liquidity_hint: 0.0,
        }))
        .collect();

    let toml_addrs: std::collections::HashSet<Address> =
        pool_infos.iter().map(|p| p.address).collect();
    let discovery_store = DiscoveryStore::new(std::path::Path::new("discovery"));
    if let Ok(pu) = discovery_store.load_pools_async(&chain_name.to_lowercase()).await {
        for dp in &pu.pools {
            let Ok(addr) = dp.address.parse::<Address>() else { continue };
            if toml_addrs.contains(&addr) {
                continue;
            }
            let (Ok(t0), Ok(t1)) = (dp.token0.parse(), dp.token1.parse()) else {
                continue;
            };
            let protocol = config::PoolEntry {
                name: format!("DISC_{}", dp.exchange_name.replace(' ', "_")),
                address: dp.address.clone(),
                protocol: dp.protocol.clone(),
                token0: dp.token0.clone(),
                token1: dp.token1.clone(),
                fee_bps: dp.fee_bps,
                fee_pips: None,
                tick_spacing: None,
                hooks: None,
            }
            .parse_protocol();
            pool_infos.push(PoolInfo { address: addr, protocol, token0: t0, token1: t1, liquidity_hint: dp.liquidity_usd });
        }
    }

    for pi in pool_infos.iter_mut() {
        let uni = matches!(
            pi.protocol,
            Protocol::UniswapV2 | Protocol::UniswapV3 | Protocol::UniswapV4
                | Protocol::Algebra | Protocol::AerodromeV2 | Protocol::AerodromeSlipstream
        );
        if uni && pi.token0 > pi.token1 {
            std::mem::swap(&mut pi.token0, &mut pi.token1);
        }
    }

    let mut pool_configs: Vec<PoolConfig> = cfg
        .pools
        .iter()
        .filter_map(|p| p.pseudo_address().ok().map(|address| PoolConfig {
            address,
            protocol: p.parse_protocol(),
            fee_bps: p.fee_bps,
            token0: tokens.get(&p.token0).copied(),
            token1: tokens.get(&p.token1).copied(),
        }))
        .collect();

    let mut read_urls: Vec<&str> = cfg.chain.rpc_https_pool.iter().map(String::as_str).collect();
    if read_urls.is_empty() {
        read_urls.push(cfg.chain.rpc_https.as_str());
    }
    let endpoint = Arc::new(
        Endpoint::new_pooled(&read_urls, &cfg.chain.rpc_wss, None, cfg.chain.chain_id).await?,
    );
    let state_reader: Address = cfg.chain.state_reader.parse().unwrap_or(Address::ZERO);
    let (v4_specs, _, invalid_v4) = config::resolve_v4(
        &cfg.pools,
        &tokens,
        cfg.chain.v4_pool_manager.as_deref().and_then(|s| s.parse().ok()),
    );
    pool_configs.retain(|pc| !invalid_v4.contains(&pc.address));
    let refresher = StateRefresher::new(endpoint, state_reader, pool_configs, cfg.chain.chain_id)
        .with_v4_pools(v4_specs);
    let store = PoolStore::new();
    let (updated, dur) = refresher.refresh(&store).await?;
    println!("refreshed pools={updated} in {dur:?}");

    // Enumerate the path and walk its hops.
    let flash_tokens: Vec<Address> =
        cfg.scanner.flash_tokens.iter().map(|n| tokens[n]).collect();
    let flash_amounts: HashMap<Address, U256> = cfg
        .scanner
        .flash_amounts
        .iter()
        .map(|(n, a)| (tokens[n], U256::from(*a)))
        .collect();
    let paths = PathEnumerator::new(pool_infos.clone(), flash_tokens, flash_amounts)
        .with_limits(config::spec::MAX_PATH_HOPS, 25_000, 200)
        .enumerate();
    let path = paths
        .iter()
        .find(|p| p.id == want_id)
        .expect("path id not found");
    println!("path {} flash={} amount={}", path.id, sym(&path.flash_token), path.flash_amount);

    // What does evaluate_all think is profitable right now?
    let results = arb_sim::evaluate::evaluate_all(&paths, &store);
    println!("evaluate_all profitable={}", results.len());
    for r in results.iter().take(10) {
        let p = &paths[r.path_id as usize];
        let hops: Vec<String> = p
            .hops
            .iter()
            .map(|h| format!("{}:{}", h.pool, sym(&h.token_in)))
            .collect();
        println!("  profitable path {} bps={} gross={} hops=[{}]",
            r.path_id, r.profit_bps, r.gross_profit, hops.join(" -> "));
    }

    // Dump store state for any extra pool addresses given on argv.
    for a in args {
        if let Ok(addr) = a.parse::<Address>() {
            match store.get_ref(&addr).as_deref() {
                Some(PoolState::V3(s)) => println!(
                    "dump V3 {addr} sqrtP={} liq={} fee={} tick={} t0={} t1={}",
                    s.sqrt_price_x96, s.liquidity, s.fee, s.tick, s.token0, s.token1
                ),
                Some(PoolState::V2(s)) => println!(
                    "dump V2 {addr} r0={} r1={} fee_bps={}",
                    s.reserve0, s.reserve1, s.fee_bps
                ),
                Some(other) => println!("dump {addr} variant={:?}", std::mem::discriminant(other)),
                None => println!("dump {addr} NOT IN STORE"),
            }
        }
    }

    let mut cur = path.flash_amount;
    for (i, hop) in path.hops.iter().enumerate() {
        let st = store.get_ref(&hop.pool);
        match st.as_deref() {
            Some(PoolState::V3(s)) => println!(
                "hop{i} V3 {} {}->{} sqrtP={} liq={} fee={} tick={}",
                hop.pool, sym(&hop.token_in), sym(&hop.token_out),
                s.sqrt_price_x96, s.liquidity, s.fee, s.tick
            ),
            Some(PoolState::V2(s)) => println!(
                "hop{i} V2 {} {}->{} r0={} r1={} fee_bps={} t0={} t1={}",
                hop.pool, sym(&hop.token_in), sym(&hop.token_out),
                s.reserve0, s.reserve1, s.fee_bps, sym(&s.token0), sym(&s.token1)
            ),
            Some(other) => println!("hop{i} {:?} {}", std::mem::discriminant(other), sym(&hop.token_in)),
            None => println!("hop{i} {} NOT IN STORE", hop.pool),
        }
        let out = match st.as_deref() {
            Some(PoolState::V2(s)) => s.quote(hop.token_in, cur),
            Some(PoolState::V3(s)) => s.quote(hop.token_in, cur),
            Some(PoolState::Curve(s)) => s.quote(hop.token_in, cur),
            Some(PoolState::Wombat(s)) => s.quote(hop.token_in, cur),
            Some(PoolState::Dodo(s)) => s.quote(hop.token_in, cur),
            Some(PoolState::AeroV2(s)) => s.quote(hop.token_in, cur),
            None => break,
        };
        match out {
            Ok(o) => {
                println!("   in={cur} out={o}");
                cur = o;
            }
            Err(e) => {
                println!("   in={cur} quote ERR {e:?}");
                break;
            }
        }
    }
    println!("final={cur} profit={}", cur.saturating_sub(path.flash_amount));
    Ok(())
}
