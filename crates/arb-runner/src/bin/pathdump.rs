// Dumps the hop composition of enumerated paths for a chain config.
// Replicates the runner's pool-graph build: TOML pools → discovery merge →
// token-order normalization → GoPlus filter → enumeration.
// Usage: pathdump <config.toml> <chain_name> [path_id]
//   path_id omitted: list all paths (id, flash token, hops)
//   path_id given: full detail for that path only

use std::collections::{HashMap, HashSet};

use alloy_primitives::{Address, U256};
use anyhow::Result;
use arb_discovery::store::DiscoveryStore;
use arb_paths::enumerate::{PathEnumerator, PoolInfo};
use arb_core::types::Protocol;

#[path = "../config.rs"]
mod config;
#[path = "../token_safety.rs"]
mod token_safety;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let mut args = std::env::args().skip(1);
    let cfg_path = args.next().expect("usage: pathdump <config.toml> <chain> [path_id]");
    let chain_name = args.next().expect("usage: pathdump <config.toml> <chain> [path_id]");
    let want_id: Option<u32> = args.next().map(|s| s.parse().unwrap());

    let cfg = config::load_config(&cfg_path)?;
    let tokens: HashMap<String, Address> = cfg
        .tokens
        .iter()
        .map(|(name, addr)| (name.clone(), addr.parse().expect("bad token addr")))
        .collect();
    let token_syms: HashMap<Address, String> = tokens
        .iter()
        .map(|(n, a)| (*a, n.clone()))
        .collect();
    let sym = |a: Address| -> String {
        token_syms.get(&a).cloned().unwrap_or_else(|| format!("{a:?}"))
    };

    let mut pool_infos: Vec<PoolInfo> = cfg
        .pools
        .iter()
        .map(|p| PoolInfo {
            address: p.address.parse().expect("bad pool addr"),
            protocol: p.parse_protocol(),
            token0: tokens[&p.token0],
            token1: tokens[&p.token1],
        })
        .collect();

    let toml_pool_addrs: HashSet<Address> = pool_infos.iter().map(|p| p.address).collect();
    let discovery_store = DiscoveryStore::new(std::path::Path::new("discovery"));
    if let Ok(pool_universe) = discovery_store
        .load_pools_async(&chain_name.to_lowercase())
        .await
    {
        for dp in &pool_universe.pools {
            let addr: Address = match dp.address.parse() {
                Ok(a) => a,
                Err(_) => continue,
            };
            if toml_pool_addrs.contains(&addr) {
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
            }
            .parse_protocol();
            pool_infos.push(PoolInfo {
                address: addr,
                protocol,
                token0: t0,
                token1: t1,
            });
        }
    }

    // Same token-order normalization as the runner.
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
            std::mem::swap(&mut pi.token0, &mut pi.token1);
        }
    }

    // GoPlus gate — same fail-open semantics.
    let mut all_tokens: HashSet<Address> = HashSet::new();
    for pi in &pool_infos {
        all_tokens.insert(pi.token0);
        all_tokens.insert(pi.token1);
    }
    let blocked = token_safety::screen_tokens(cfg.chain.chain_id, &all_tokens).await;
    if !blocked.is_empty() {
        pool_infos.retain(|pi| !blocked.contains(&pi.token0) && !blocked.contains(&pi.token1));
    }

    let flash_tokens: Vec<Address> = cfg
        .scanner
        .flash_tokens
        .iter()
        .map(|name| tokens[name])
        .collect();
    let flash_amounts: HashMap<Address, U256> = cfg
        .scanner
        .flash_amounts
        .iter()
        .map(|(name, &amount)| (tokens[name], U256::from(amount)))
        .collect();

    let enumerator = PathEnumerator::new(pool_infos, flash_tokens, flash_amounts)
        .with_limits(config::spec::MAX_PATH_HOPS, 25_000, 200);
    let paths = enumerator.enumerate();
    eprintln!("total paths: {}", paths.len());

    let mut found = false;
    for p in &paths {
        if let Some(id) = want_id {
            if p.id != id {
                continue;
            }
        }
        found = true;
        println!(
            "path {} flash={} amount={} hops={}",
            p.id,
            sym(p.flash_token),
            p.flash_amount,
            p.hops.len()
        );
        for (i, h) in p.hops.iter().enumerate() {
            println!(
                "  {}. {:?} {} {}({})->{}({})",
                i + 1,
                h.protocol,
                h.pool,
                sym(h.token_in),
                h.token_in,
                sym(h.token_out),
                h.token_out
            );
        }
        if want_id.is_some() {
            break;
        }
    }
    if let Some(id) = want_id {
        if !found {
            eprintln!("path id {id} not present in enumeration");
        }
    }
    Ok(())
}
