//! leader_scan — outcome-driven leader discovery (EigenPhi-style).
//!
//! The mempool-frequency scorer finds RETAIL bots — real top wallets either
//! submit privately (never appearing in the pending stream) or trade too
//! rarely to score. This scans MINED blocks instead: every sender's net
//! ERC-20 Transfer deltas per tx are computed from block receipts and
//! ranked by realized USD. A wallet earns the "leader" title by measured
//! profit, not by looking bot-shaped in the mempool.
//!
//! Usage:
//!   leader_scan <config.toml> [--blocks N] [--top K] [--from BLOCK]
//!
//! Rows: LEADER_SCAN (per-wallet aggregate), LEADER_SCAN_TX (largest txs).

use std::collections::HashMap;

use alloy_primitives::{Address, B256, U256};
use anyhow::Result;

use arb_rpc::Endpoint;

#[path = "../config.rs"]
mod config;

/// keccak256("Transfer(address,address,uint256)") — verified on-chain.
const TRANSFER_SIG: B256 = alloy_primitives::b256!(
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
);

#[derive(Default)]
struct SenderAgg {
    net_usd: f64,
    gas_usd: f64,
    txs: u32,
    unpriced_flows: u32,
    /// Largest single-tx net — separates sustained profit from one lucky hit.
    best_tx_usd: f64,
    best_tx: Option<B256>,
    /// Tokens touched (arb bots trade many pairs; accumulators concentrate).
    tokens: std::collections::HashSet<Address>,
    /// Times this sender's profitable tx immediately followed a DIFFERENT
    /// sender's tx touching the same tokens — the backrun-bundle signature:
    /// the pair was co-submitted to a builder, i.e. this wallet uses a
    /// private channel invisible to the pending stream.
    private_hits: u32,
    /// Single-tx wins touching >=3 tokens — multi-hop atomic arb signature.
    atomic_txs: u32,
    /// Txs with BOTH an inflow and an outflow — real trades. Wallets whose
    /// only flows are inflows are receivers (payments/CEX withdrawals),
    /// not traders; they must not top a profit leaderboard.
    trade_txs: u32,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let args: Vec<String> = std::env::args().collect();
    let cfg_path = args.get(1).cloned().unwrap_or_else(|| "config/bsc.toml".into());
    let opt = |name: &str, def: usize| -> usize {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(def)
    };
    let n_blocks = opt("--blocks", 200);
    let top_k = opt("--top", 15);
    let from_block = opt("--from", 0) as u64;
    // --class atomic|bundle|any: restrict output/export to wallets matching
    // the proven leader profiles (atomic-arb contract traders and
    // bundle backrunners). Default 'any' = no filter.
    let class_filter = args
        .iter()
        .position(|a| a == "--class")
        .and_then(|i| args.get(i + 1).cloned())
        .unwrap_or_else(|| "any".into());
    let min_net: f64 = args
        .iter()
        .position(|a| a == "--min-net")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    let cfg = config::load_config(&cfg_path)?;
    let chain = cfg.chain.name.clone();

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

    let latest = endpoint.block_number().await?;
    let hi = if from_block > 0 { from_block } else { latest };
    let lo = hi.saturating_sub(n_blocks as u64);
    println!(
        "LEADER_SCAN chain={chain} scanning blocks {lo}..{hi} \
         priced_tokens={}",
        priced_addrs.len()
    );

    let mut senders: HashMap<Address, SenderAgg> = HashMap::new();
    let mut dec_cache: HashMap<Address, u32> = HashMap::new();
    let mut n_receipts = 0u64;

    for block in (lo..=hi).rev() {
        let Some(receipts) = endpoint.get_block_receipts(block).await? else {
            continue;
        };
        n_receipts += receipts.len() as u64;
        // (sender, tokens touched) of the previous in-block tx, for
        // cross-sender bundle fingerprinting.
        let mut prev: Option<(Address, std::collections::HashSet<Address>)> = None;
        for receipt in &receipts {
            if !receipt.status() {
                continue;
            }
            let sender = receipt.from;
            let mut net_usd = 0.0f64;
            let mut unpriced = 0u32;
            let mut had_in = false;
            let mut had_out = false;
            let mut tx_tokens: std::collections::HashSet<Address> =
                std::collections::HashSet::new();
            for log in receipt.inner.logs() {
                let topics = log.topics();
                if topics.len() != 3 || topics[0] != TRANSFER_SIG {
                    continue;
                }
                let from = Address::from_word(topics[1]);
                let to = Address::from_word(topics[2]);
                if from != sender && to != sender {
                    continue;
                }
                let token = log.address();
                tx_tokens.insert(token);
                let amount = U256::from_be_slice(log.data().data.as_ref());
                if to == sender { had_in = true } else { had_out = true }
                let raw = amount.to_string().parse::<f64>().unwrap_or(0.0)
                    * if to == sender { 1.0 } else { -1.0 };
                if !dec_cache.contains_key(&token) {
                    let d = fetch_decimals(&endpoint, token).await;
                    dec_cache.insert(token, d);
                }
                match priced_addrs.get(&token) {
                    Some(&price) => {
                        net_usd += raw / 10f64.powi(dec_cache[&token] as i32) * price;
                    }
                    None => unpriced += 1,
                }
                senders.entry(sender).or_default().tokens.insert(token);
            }
            let cur_tokens = tx_tokens.clone();
            if tx_tokens.is_empty() {
                prev = Some((sender, tx_tokens));
                continue; // no token flow — plain transfer/contract call
            }
            // Bundle fingerprint: this tx profited while sharing tokens with
            // the immediately preceding tx from a different sender.
            let mut private_hit = false;
            if net_usd > 0.0 {
                if let Some((ps, ptoks)) = &prev {
                    if *ps != sender && ptoks.iter().any(|t| tx_tokens.contains(t)) {
                        private_hit = true;
                    }
                }
            }
            prev = Some((sender, cur_tokens));
            let gas_usd =
                receipt.gas_used as f64 * receipt.effective_gas_price as f64 / 1e18 * native_usd;
            let agg = senders.entry(sender).or_default();
            if private_hit {
                agg.private_hits += 1;
            }
            if net_usd > 0.0 && tx_tokens.len() >= 3 {
                agg.atomic_txs += 1;
            }
            if had_in && had_out {
                agg.trade_txs += 1;
            }
            agg.txs += 1;
            agg.gas_usd += gas_usd;
            agg.net_usd += net_usd;
            agg.unpriced_flows += unpriced;
            if net_usd > agg.best_tx_usd {
                agg.best_tx_usd = net_usd;
                agg.best_tx = Some(receipt.transaction_hash);
            }
        }
    }

    // Rank by realized net after gas — profit is the metric, not volume.
    let mut ranked: Vec<_> = senders
        .into_iter()
        .map(|(a, s)| (a, s.net_usd - s.gas_usd, s))
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    println!("LEADER_SCAN receipts={n_receipts} senders_with_flows={} class={class_filter}", ranked.len());
    let data_dir = format!("data/leaders/{chain}");
    let _ = std::fs::create_dir_all(&data_dir);
    let mut export = String::new();
    let mut shown = 0usize;
    for (addr, net_after_gas, s) in ranked.iter() {
        let class = if s.atomic_txs > 0 {
            "atomic_arb"
        } else if s.private_hits > 0 {
            "bundle_backrunner"
        } else {
            "trader"
        };
        if class_filter != "any" && !class.starts_with(&class_filter) {
            continue;
        }
        if *net_after_gas < min_net {
            continue;
        }
        // Auto-target: profitable wallets of the two proven profiles are
        // exported for the observation registry (observe -> replay -> forge).
        if *net_after_gas > 0.0 && (s.atomic_txs > 0 || s.private_hits > 0) {
            export.push_str(&format!(
                "{{\"address\":\"{addr:#x}\",\"class\":\"{class}\",\
                 \"net_after_gas_usd\":{net_after_gas:.4},\
                 \"atomic_txs\":{},\"private_hits\":{},\
                 \"best_tx\":\"{}\"}}\n",
                s.atomic_txs,
                s.private_hits,
                s.best_tx.map(|h| format!("{h:#x}")).unwrap_or_default()
            ));
        }
        if shown >= top_k {
            continue;
        }
        shown += 1;
        let best = s
            .best_tx
            .map(|h| format!("{h:#x}"))
            .unwrap_or_else(|| "-".into());
        println!(
            "LEADER_SCAN {addr:#x} net_after_gas={net_after_gas:.4} \
             net_usd={:.4} gas_usd={:.4} txs={} tokens={} best_tx_usd={:.4} \
             best={best} unpriced={} private_hits={} atomic={} trades={} class={class}",
            s.net_usd, s.gas_usd, s.txs, s.tokens.len(), s.best_tx_usd,
            s.unpriced_flows, s.private_hits, s.atomic_txs, s.trade_txs
        );
    }
    let path = format!("{data_dir}/_scanned.jsonl");
    let n_targets = export.lines().count();
    if n_targets > 0 {
        std::fs::write(&path, &export)?;
    }
    println!("LEADER_SCAN exported {n_targets} targeted wallets -> {path}");
    Ok(())
}
