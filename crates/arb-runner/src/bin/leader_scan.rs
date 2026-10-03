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
    /// Strategy deconstruction: per-tx nets (capped), contracts called,
    /// and winning-tx count — everything needed to score forge targets.
    tx_nets: Vec<f64>,
    contracts: HashMap<Address, u32>,
    wins: u32,
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
    // Contracts observed as tx targets across the scan — used to label
    // route counterparties (router vs pool/other).
    let mut s_contracts: std::collections::HashSet<Address> =
        std::collections::HashSet::new();
    // Counterparty addresses seen inside profitable txs, with hit counts —
    // candidate pools for auto-import.
    let mut pool_candidates: HashMap<Address, u32> = HashMap::new();
    let _ = &mut s_contracts;
    let senders_unused = ();
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
            if let Some(to) = receipt.to {
                s_contracts.insert(to);
            }
            let mut net_usd = 0.0f64;
            let mut counterparties: std::collections::HashSet<Address> =
                std::collections::HashSet::new();
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
                if from != sender {
                    counterparties.insert(from);
                }
                if to != sender {
                    counterparties.insert(to);
                }
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
            if net_usd > 0.0 {
                for c in &counterparties {
                    if *c != sender {
                        *pool_candidates.entry(*c).or_default() += 1;
                    }
                }
            }
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
            if agg.tx_nets.len() < 10_000 {
                agg.tx_nets.push(net_usd);
            }
            if let Some(to) = receipt.to {
                *agg.contracts.entry(to).or_default() += 1;
            }
            if net_usd > 0.0 {
                agg.wins += 1;
            }
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
    // ---- Deconstruction + composite score ----
    // score = ln(1+net) * (0.5 + 0.3*win_rate + 0.2*freq) * forge_weight
    // forge_weight: bundle_backrunner 1.0 (our mechanism exists),
    // atomic_arb 0.8 (needs path coverage), trader 0.4 (unverified).
    let mut scored: Vec<(Address, f64, f64, f64, f64, &'static str, String)> = Vec::new();
    for (addr, net_after_gas, s) in &ranked {
        if *net_after_gas <= 0.0 || s.trade_txs == 0 {
            continue;
        }
        let class = if s.atomic_txs > 0 {
            "atomic_arb"
        } else if s.private_hits > 0 {
            "bundle_backrunner"
        } else {
            "trader"
        };
        let forge_w = match class {
            "bundle_backrunner" => 1.0,
            "atomic_arb" => 0.8,
            _ => 0.4,
        };
        let wins_pos: Vec<f64> = s
            .tx_nets
            .iter()
            .copied()
            .filter(|&n| n > 0.0)
            .collect();
        let median_win = {
            let mut w = wins_pos.clone();
            w.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            if w.is_empty() { 0.0 } else { w[w.len() / 2] }
        };
        let win_rate = if s.trade_txs > 0 {
            s.wins as f64 / s.txs as f64
        } else {
            0.0
        };
        let freq = (s.trade_txs as f64 / 20.0).min(1.0);
        let score =
            (1.0 + net_after_gas).ln() * (0.5 + 0.3 * win_rate + 0.2 * freq) * forge_w;
        let top_contracts = {
            let mut cs: Vec<_> = s.contracts.iter().collect();
            cs.sort_by(|a, b| b.1.cmp(a.1));
            cs.iter()
                .take(3)
                .map(|(a, n)| format!("{a:#x}x{n}"))
                .collect::<Vec<_>>()
                .join(",")
        };
        println!(
            "LEADER_STRAT {addr:#x} class={class} win_rate={win_rate:.2} \
             median_win={median_win:.2} trades={} contracts={top_contracts}",
            s.trade_txs
        );
        scored.push((*addr, score, *net_after_gas, win_rate, median_win, class, top_contracts));
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    for (i, (addr, score, net, wr, mw, class, contracts)) in scored.iter().take(top_k).enumerate() {
        println!(
            "LEADER_RANK #{} {addr:#x} score={score:.2} net={net:.2} \
             win_rate={wr:.2} median_win={mw:.2} class={class} via={contracts}",
            i + 1
        );
    }

    // ---- Route reconstruction: ordered Transfer legs of each top wallet's
    // best tx reveal the actual swap path (pools = counterparties that are
    // neither the wallet nor other EOAs' wallet legs).
    for (addr, _score, _net, _wr, _mw, class, _c) in scored.iter().take(5) {
        let s = &senders_unused;
        let _ = s;
        let Some(wallet) = ranked.iter().find(|(a, _, _)| a == addr) else {
            continue;
        };
        let Some(best_tx) = wallet.2.best_tx else { continue };
        let Ok(Some(receipt)) = endpoint.get_receipt(best_tx).await else {
            continue;
        };
        let mut hop = 0u32;
        for log in receipt.inner.logs() {
            let topics = log.topics();
            if topics.len() != 3 || topics[0] != TRANSFER_SIG {
                continue;
            }
            hop += 1;
            let token = log.address();
            let from = Address::from_word(topics[1]);
            let to = Address::from_word(topics[2]);
            let amount = U256::from_be_slice(log.data().data.as_ref());
            let label = |a: Address| -> String {
                if a == *addr {
                    "WALLET".into()
                } else if s_contracts.contains(&a) {
                    format!("router:{a:#x}")
                } else {
                    format!("pool:{a:#x}")
                }
            };
            println!(
                "LEADER_ROUTE {addr:#x} class={class} tx={best_tx:#x} \
                 hop={hop} token={token:#x} {} -> {} amt={amount}",
                label(from),
                label(to)
            );
        }
    }

    // ---- Pool auto-import: probe the most-hit counterparties on-chain to
    // classify V2 (getReserves 0x0902f1ac) vs V3 (slot0 0x3850c7bd) and emit
    // ready-to-merge [[pools]] entries growing our coverage toward the
    // leaders' route set.
    let mut cand: Vec<_> = pool_candidates
        .iter()
        .filter(|(a, _)| !s_contracts.contains(*a) && !tokens.values().any(|t| t == *a))
        .map(|(a, n)| (*a, *n))
        .collect();
    cand.sort_by(|a, b| b.1.cmp(&a.1));
    let mut pools_toml = String::from(
        "# auto-discovered pools from leader routes — merge into config [[pools]]\n",
    );
    let mut n_v2 = 0u32;
    let mut n_v3 = 0u32;
    let addr_of = |sel: [u8; 4]| alloy_primitives::Bytes::from(sel.to_vec());
    let mut new_tokens: Vec<String> = Vec::new();
    for (addr, hits) in cand.iter().take(80) {
        let v3 = endpoint
            .eth_call_timed(*addr, addr_of([0x38, 0x50, 0xc7, 0xbd]))
            .await
            .map(|(o, _)| o.len() >= 32 * 7)
            .unwrap_or(false);
        let v2 = !v3
            && endpoint
                .eth_call_timed(*addr, addr_of([0x09, 0x02, 0xf1, 0xac]))
                .await
                .map(|(o, _)| o.len() >= 32 * 3)
                .unwrap_or(false);
        if !v2 && !v3 {
            continue;
        }
        let kind = if v3 { "v3" } else { "v2" };
        if v3 { n_v3 += 1 } else { n_v2 += 1 }
        // token0()/token1() + v3 fee() resolved on-chain — merge-ready rows.
        let t0 = endpoint
            .eth_call_timed(*addr, addr_of([0x0d, 0xfe, 0x16, 0x81]))
            .await
            .ok()
            .and_then(|(o, _)| o.get(12..32).map(|b| Address::from_slice(b)));
        let t1 = endpoint
            .eth_call_timed(*addr, addr_of([0xd2, 0x12, 0x20, 0xa7]))
            .await
            .ok()
            .and_then(|(o, _)| o.get(12..32).map(|b| Address::from_slice(b)));
        let fee_bps = if v3 {
            endpoint
                .eth_call_timed(*addr, addr_of([0xdd, 0xca, 0x3f, 0x43]))
                .await
                .ok()
                .and_then(|(o, _)| {
                    o.get(..32).map(|b| U256::from_be_slice(b).to::<u32>() / 100)
                })
                .unwrap_or(30)
        } else {
            25
        };
        let mut sym = |a: Option<Address>| -> String {
            match a {
                Some(a) => {
                    if let Some((sym, _)) =
                        tokens.iter().find(|(_, t)| **t == a)
                    {
                        sym.clone()
                    } else {
                        let s = format!("TK_{:#x}", a);
                        new_tokens.push(format!("{s} = \"{a:#x}\""));
                        s
                    }
                }
                None => "UNK".into(),
            }
        };
        let s0 = sym(t0);
        let s1 = sym(t1);
        println!(
            "LEADER_POOL {addr:#x} protocol={kind} hits={hits} {s0}/{s1} fee_bps={fee_bps}"
        );
        pools_toml.push_str(&format!(
            "[[pools]]\nname = \"AUTO_{s0}_{s1}_{fee_bps}\"\n\
             address = \"{addr:#x}\"\nprotocol = \"{kind}\"\n\
             token0 = \"{s0}\"\ntoken1 = \"{s1}\"\nfee_bps = {fee_bps}\n\n"
        ));
    }
    if !new_tokens.is_empty() {
        new_tokens.sort();
        new_tokens.dedup();
        let tokens_path = format!("{data_dir}/_tokens.toml");
        std::fs::write(
            &tokens_path,
            format!(
                "# merge under [tokens]\n{}\n",
                new_tokens.join("\n")
            ),
        )?;
        println!("LEADER_TOKENS exported {} -> {tokens_path}", new_tokens.len());
    }
    let pools_path = format!("{data_dir}/_pools.toml");
    std::fs::write(&pools_path, &pools_toml)?;
    println!(
        "LEADER_POOLS exported v2={n_v2} v3={n_v3} -> {pools_path}"
    );

    let path = format!("{data_dir}/_scanned.jsonl");
    let n_targets = export.lines().count();
    if n_targets > 0 {
        std::fs::write(&path, &export)?;
    }
    println!("LEADER_SCAN exported {n_targets} targeted wallets -> {path}");
    Ok(())
}
