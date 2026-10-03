//! leader_profile — Leader Wallet Intelligence Phase 2: replay measurement.
//!
//! Reads observation JSONL written by `arb-leaders`
//! (`data/leaders/<chain>/<wallet>.jsonl`), pulls each recorded tx's on-chain
//! receipt, and measures the wallet's REALIZED outcome: net ERC-20 Transfer
//! deltas valued in USD minus gas. This is the EigenPhi-style attribution
//! step — a wallet's edge is proven from outcomes, not inferred from shape.
//!
//! Usage:
//!   leader_profile <config.toml> <wallet-addr|"all"> [--limit N]
//!
//! Output rows are grep-prefixed: LEADER_PROFILE / LEADER_TX / LEADER_TOKEN.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use alloy_primitives::{Address, B256, U256};
use anyhow::Result;

use arb_rpc::Endpoint;
use serde::Deserialize;

#[path = "../config.rs"]
mod config;

/// keccak256("Transfer(address,address,uint256)")
const TRANSFER_SIG: B256 = alloy_primitives::b256!(
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
);

#[derive(Debug, Deserialize)]
struct ObsRow {
    tx_hash: B256,
    token_out: Option<Address>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let args: Vec<String> = std::env::args().collect();
    let cfg_path = args.get(1).cloned().unwrap_or_else(|| "config/bsc.toml".into());
    let wallet_arg = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| "all".to_string())
        .to_lowercase();
    let limit: usize = args
        .iter()
        .position(|a| a == "--limit")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);

    let cfg = config::load_config(&cfg_path)?;
    let chain = cfg.chain.name.clone();

    // Address → (price_usd, decimals) for valuing token deltas; symbol →
    // address map is the same one the engine uses.
    let tokens: HashMap<String, Address> = cfg
        .tokens
        .iter()
        .filter_map(|(s, a)| a.parse::<Address>().ok().map(|a| (s.clone(), a)))
        .collect();
    let priced_addrs: HashMap<Address, f64> = cfg
        .token_usd_prices
        .iter()
        .filter_map(|(sym, &price)| tokens.get(sym).map(|&a| (a, price)))
        .collect();
    // Decimals are fetched on-chain per token (cached) — chain conventions
    // differ (BSC stables are 18 decimals, Ethereum's are 6/18 mixed).
    async fn fetch_decimals(ep: &Endpoint, token: Address) -> u32 {
        match ep
            .eth_call_timed(token, alloy_primitives::Bytes::from_static(&[0x31, 0x3c, 0xe5, 0x67]))
            .await
        {
            Ok((out, _)) if out.len() >= 32 => {
                U256::from_be_slice(&out[..32]).try_into().unwrap_or(18)
            }
            _ => 18,
        }
    }
    let native_usd = ["WBNB", "WETH", "WPOL", "ETH"]
        .iter()
        .find_map(|s| cfg.token_usd_prices.get(*s).copied())
        .unwrap_or(0.0);

    let mut read_urls: Vec<&str> = cfg
        .chain
        .rpc_https_pool
        .iter()
        .map(String::as_str)
        .collect();
    if !cfg.chain.rpc_https.is_empty() {
        read_urls.push(cfg.chain.rpc_https.as_str());
    }
    let endpoint = Endpoint::new_pooled(&read_urls, &cfg.chain.rpc_wss, None, cfg.chain.chain_id).await?;
    // Collect observation files.
    let dir = PathBuf::from("data/leaders").join(&chain);
    let files: Vec<PathBuf> = if wallet_arg == "all" {
        let mut v: Vec<PathBuf> = fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| {
                        p.extension().map(|e| e == "jsonl").unwrap_or(false)
                            && !p.file_name().unwrap().to_string_lossy().starts_with('_')
                    })
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    } else {
        vec![dir.join(format!("{wallet_arg}.jsonl"))]
    };

    for file in files {
        let wallet_hex = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let wallet: Address = match wallet_hex.parse() {
            Ok(a) => a,
            Err(_) => continue,
        };
        let body = match fs::read_to_string(&file) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Dedup tx hashes, keep capture order.
        let mut seen = std::collections::HashSet::new();
        let mut txs: Vec<(B256, Option<Address>)> = Vec::new();
        for line in body.lines() {
            if let Ok(row) = serde_json::from_str::<ObsRow>(line) {
                if seen.insert(row.tx_hash) {
                    txs.push((row.tx_hash, row.token_out));
                }
            }
        }
        txs.truncate(limit);
        let hashes: Vec<B256> = txs.iter().map(|(h, _)| *h).collect();

        println!(
            "LEADER_PROFILE wallet={wallet_hex} chain={chain} recorded={} fetching={}",
            seen.len(),
            hashes.len()
        );

        let (mut mined, mut reverted, mut dropped, mut rpc_fail) = (0u32, 0u32, 0u32, 0u32);
        let (mut wins, mut losses, mut breakeven) = (0u32, 0u32, 0u32);
        let mut total_net_usd = 0.0f64;
        let mut total_gas_usd = 0.0f64;
        let mut unpriced_tokens = std::collections::HashSet::new();
        let mut per_token_net: HashMap<Address, f64> = HashMap::new();
        let mut dec_cache: HashMap<Address, u32> = HashMap::new();
        // Execution-implied pricing: a leader's own fills define the market
        // price of unpriced tokens — priced leg USD / unpriced qty per fill.
        // Median over the wallet's fills is robust to single bad prints.
        let mut implied_fills: HashMap<Address, Vec<f64>> = HashMap::new();
        let mut beneficiary_count: HashMap<Address, u32> = HashMap::new();

        for (h, token_out) in &txs {
            let receipt = match endpoint.get_receipt(*h).await {
                Ok(Some(r)) => r,
                Ok(None) => {
                    dropped += 1;
                    continue;
                }
                Err(_) => {
                    rpc_fail += 1;
                    continue;
                }
            };
            if !receipt.status() {
                reverted += 1;
                continue;
            }
            mined += 1;
            let gas_usd = receipt.gas_used as f64 * receipt.effective_gas_price as f64 / 1e18
                * native_usd;
            total_gas_usd += gas_usd;

            // Net ERC-20 deltas for the wallet from Transfer logs.
            let mut tx_unpriced = 0u32;
            let mut best_beneficiary: Option<(Address, U256)> = None;
            let mut tx_deltas: Vec<(Address, f64)> = Vec::new();
            for log in receipt.inner.logs() {
                let topics = log.topics();
                if topics.len() != 3 || topics[0] != TRANSFER_SIG {
                    continue;
                }
                let from = Address::from_word(topics[1]);
                let to = Address::from_word(topics[2]);
                // Beneficiary attribution: who receives the wallet's
                // bought token when it isn't the wallet itself.
                if Some(&log.address()) == token_out.as_ref() && to != wallet {
                    let amt = U256::from_be_slice(log.data().data.as_ref());
                    if best_beneficiary.map_or(true, |(_, a)| amt > a) {
                        best_beneficiary = Some((to, amt));
                    }
                }
                if from != wallet && to != wallet {
                    continue;
                }
                let amount = U256::from_be_slice(log.data().data.as_ref());
                let token = log.address();
                // f64 for report-scale numbers; raw deltas stay in JSONL.
                let raw = amount.to_string().parse::<f64>().unwrap_or(0.0)
                    * if to == wallet { 1.0 } else { -1.0 };
                *per_token_net.entry(token).or_default() += raw;
                if !dec_cache.contains_key(&token) {
                    let d = fetch_decimals(&endpoint, token).await;
                    dec_cache.insert(token, d);
                }
                tx_deltas.push((token, raw));
            }

            // First pass: value every priced leg; learn implied prices from
            // txs that trade exactly one unpriced token against priced legs.
            let mut priced_flow_usd = 0.0f64;
            let mut unpriced_legs: Vec<(Address, f64, u32)> = Vec::new();
            for &(token, raw) in &tx_deltas {
                let dec = dec_cache[&token];
                match priced_addrs.get(&token) {
                    Some(&price) => {
                        priced_flow_usd += raw / 10f64.powi(dec as i32) * price;
                    }
                    None => unpriced_legs.push((token, raw, dec)),
                }
            }
            if unpriced_legs.len() == 1 {
                let (token, raw, dec) = unpriced_legs[0];
                let qty = raw.abs() / 10f64.powi(dec as i32);
                let contra = priced_flow_usd.abs();
                if qty > 0.0 && contra > 0.0 {
                    implied_fills.entry(token).or_default().push(contra / qty);
                }
            }
            // Second pass: price unpriced legs at the token's median implied
            // fill when we have one.
            let mut tx_net_usd = priced_flow_usd;
            for (token, raw, dec) in unpriced_legs {
                if let Some(fills) = implied_fills.get(&token) {
                    let mut f = fills.clone();
                    f.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    let median = f[f.len() / 2];
                    tx_net_usd += raw / 10f64.powi(dec as i32) * median;
                } else {
                    tx_unpriced += 1;
                    unpriced_tokens.insert(token);
                }
            }
            if let Some((ben, _)) = best_beneficiary {
                *beneficiary_count.entry(ben).or_default() += 1;
            }
            let ben_str = best_beneficiary
                .map(|(a, _)| format!("{a:#x}"))
                .unwrap_or_else(|| "-".to_string());
            let net_after_gas = tx_net_usd - gas_usd;
            total_net_usd += tx_net_usd;
            if net_after_gas > 0.01 {
                wins += 1;
            } else if net_after_gas < -0.01 {
                losses += 1;
            } else {
                breakeven += 1;
            }
            println!(
                "LEADER_TX {h} gas_usd={gas_usd:.4} net_usd={tx_net_usd:.4} \
                 net_after_gas={net_after_gas:.4} unpriced_flows={tx_unpriced}                  beneficiary={ben_str}"
            );
        }

        let mut toks: Vec<_> = per_token_net.iter().collect();
        toks.sort_by(|a, b| b.1.abs().partial_cmp(&a.1.abs()).unwrap_or(std::cmp::Ordering::Equal));
        for (t, net) in toks.iter().take(5) {
            let px = match (priced_addrs.get(*t), dec_cache.get(*t)) {
                (Some(&p), Some(&d)) => format!("{:.4}usd", *net / 10f64.powi(d as i32) * p),
                _ => "UNPRICED".to_string(),
            };
            println!("LEADER_TOKEN {wallet_hex} {t} net_raw={net:.4} {px}");
        }

        let mut holdings_value = 0.0f64;
        let mut implied: Vec<_> = implied_fills.iter().collect();
        implied.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
        for (t, fills) in implied.iter().take(5) {
            let mut f = (*fills).clone();
            f.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let median = f[f.len() / 2];
            let last = *f.last().unwrap_or(&median);
            let qty = per_token_net.get(*t).copied().unwrap_or(0.0);
            let dec = dec_cache.get(*t).copied().unwrap_or(18);
            let hold_usd = qty / 10f64.powi(dec as i32) * last;
            if qty > 0.0 {
                holdings_value += hold_usd;
            }
            println!(
                "LEADER_PRICE {wallet_hex} {t} median_usd={median:.6}                  last_usd={last:.6} fills={} holdings_usd={hold_usd:.4}",
                f.len()
            );
        }

        let mut bens: Vec<_> = beneficiary_count.iter().collect();
        bens.sort_by(|a, b| b.1.cmp(a.1));
        for (b, n) in bens.iter().take(5) {
            println!("LEADER_BENEFICIARY {wallet_hex} {b:#x} receives_token_out={n}");
        }
        let win_rate = if mined > 0 { wins as f64 / mined as f64 } else { 0.0 };
        println!(
            "LEADER_PROFILE wallet={wallet_hex} mined={mined} reverted={reverted} \
             dropped={dropped} rpc_fail={rpc_fail} wins={wins} losses={losses} \
             breakeven={breakeven} win_rate={win_rate:.3} \
             total_net_usd={total_net_usd:.4} total_gas_usd={total_gas_usd:.4} \
             pnl_after_gas={:.4} holdings_value_usd={holdings_value:.4} \
             unpriced_tokens={}",
            total_net_usd - total_gas_usd,
            unpriced_tokens.len()
        );
    }
    Ok(())
}
