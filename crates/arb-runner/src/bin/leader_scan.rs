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

use std::collections::{HashMap, HashSet};

use alloy_primitives::{Address, B256, U256};
use alloy_provider::Provider as _;
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
    /// Hashes of this sender's txs in the window (capped) — the route
    /// decode unions pool counterparties across a wallet's sibling txs,
    /// because executor-intermediary leaders keep their arb legs in txs
    /// other than the profit-taking one.
    tx_hashes: Vec<B256>,
    /// The wallet's most profitable tx hashes in the window (net, hash),
    /// decoded first during route reconstruction.
    top_txs: Vec<(f64, B256)>,
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
    // --merge: write provenance-passed pools + new tokens straight into the
    // chain config so the next scan/runner covers them (closes the
    // export -> manual-merge gap that left leader routes untracked).
    let merge_config = args.iter().any(|a| a == "--merge");
    // --merge-only: skip scanning entirely and merge the persisted
    // data/leaders/<chain>/_pools.toml + _tokens.toml exports into the
    // config. For exports produced by earlier runs (before --merge existed).
    let merge_only = args.iter().any(|a| a == "--merge-only");
    // --loop SECONDS: keep rescanning — the persisted cursor makes every
    // pass cover only new blocks, so _strategies.jsonl/_opportunities.jsonl
    // stay fresh without a cron. Run under pm2 (auto-restart covers a
    // transient RPC failure exiting the process). 0 = single run.
    let loop_secs: u64 = args
        .iter()
        .position(|a| a == "--loop")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let cfg = config::load_config(&cfg_path)?;
    let chain = cfg.chain.name.clone();

    if merge_only {
        let data_dir = format!("data/leaders/{chain}");
        let pools_toml = std::fs::read_to_string(format!("{data_dir}/_pools.toml"))?;
        let new_tokens: Vec<String> = std::fs::read_to_string(format!("{data_dir}/_tokens.toml"))
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(String::from)
            .collect();
        let (p, t) = merge_into_config(&cfg_path, &pools_toml, &new_tokens)?;
        println!("LEADER_MERGE merged pools={p} tokens={t} -> {cfg_path}");
        return Ok(());
    }

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

    loop {
    let latest = endpoint.block_number().await?;
    let hi = if from_block > 0 { from_block } else { latest };
    // Incremental scanning: with no explicit --from, resume one block past
    // the persisted cursor so each pass covers only new ground.
    let lo = if from_block > 0 {
        hi.saturating_sub(n_blocks as u64)
    } else {
        arb_leaders::StrategyRegistry::load_cursor(&chain)
            .map(|c| c + 1)
            .unwrap_or_else(|| hi.saturating_sub(n_blocks as u64))
            .min(hi)
    };
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
    // Reverse index tx.to -> [(tx_hash, sender)] — executor-intermediary
    // leaders' arb legs live in txs sent TO their executor contracts by
    // other EOAs, so route decode must follow the executor.
    let mut to_index: HashMap<Address, Vec<(B256, Address)>> = HashMap::new();
    // Counterparty addresses seen inside profitable txs, with hit counts —
    // candidate pools for auto-import.
    let mut pool_candidates: HashMap<Address, u32> = HashMap::new();
    // Pools confirmed inside decoded leader routes — first-class import
    // candidates regardless of hit count or s_contracts membership (a wallet
    // calling a pair directly puts the pool into s_contracts too).
    let mut route_pool_addrs: HashSet<Address> = HashSet::new();
    let _ = &mut s_contracts;
    let senders_unused = ();
    let mut dec_cache: HashMap<Address, u32> = HashMap::new();
    let mut n_receipts = 0u64;
    let mut n_skipped_receipts = 0u64;

    for block in (lo..=hi).rev() {
        let (receipts, skipped) = endpoint.get_block_receipts_lenient(block).await?;
        n_skipped_receipts += skipped;
        n_receipts += receipts.len() as u64;
        // (sender, tokens touched) of the previous in-block tx, for
        // cross-sender bundle fingerprinting.
        let mut prev: Option<(Address, std::collections::HashSet<Address>)> = None;
        for receipt in &receipts {
            if !receipt.status() {
                continue;
            }
            let sender = receipt.from;
            // Record every successful tx per sender (capped) BEFORE the
            // token-flow skip below — an executor-intermediary leader's arb
            // txs often show zero wallet-touching transfers (profit stays
            // on the executor until a harvest tx), and those are exactly
            // the receipts that carry the real pool legs.
            {
                let agg = senders.entry(sender).or_default();
                if agg.tx_hashes.len() < 24 {
                    agg.tx_hashes.push(receipt.transaction_hash);
                }
            }
            if let Some(to) = receipt.to {
                s_contracts.insert(to);
                let v = to_index.entry(to).or_default();
                if v.len() < 96 {
                    v.push((receipt.transaction_hash, sender));
                }
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
            if net_usd > 0.0 {
                agg.top_txs.push((net_usd, receipt.transaction_hash));
                agg.top_txs.sort_by(|a, b| {
                    b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
                });
                agg.top_txs.truncate(8);
            }
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

    println!("LEADER_SCAN receipts={n_receipts} skipped_undecodable={n_skipped_receipts} senders_with_flows={} class={class_filter}", ranked.len());
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
            let wins_pos_n = s.tx_nets.iter().filter(|&&n| n > 0.0).count();
            let win_rate_e = if s.txs > 0 {
                s.wins as f64 / s.txs as f64
            } else {
                0.0
            };
            let mut wv: Vec<f64> = s
                .tx_nets
                .iter()
                .copied()
                .filter(|&n| n > 0.0)
                .collect();
            wv.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let median_win_e = if wv.is_empty() { 0.0 } else { wv[wv.len() / 2] };
            let _ = wins_pos_n;
            export.push_str(&format!(
                "{{\"address\":\"{addr:#x}\",\"class\":\"{class}\",\
                 \"net_after_gas_usd\":{net_after_gas:.4},\"txs\":{},\
                 \"trade_txs\":{},\"win_rate\":{win_rate_e:.4},\
                 \"median_win_usd\":{median_win_e:.4},\
                 \"atomic_txs\":{},\"private_hits\":{},\
                 \"best_tx\":\"{}\"}}\n",
                s.txs,
                s.trade_txs,
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
    // neither the wallet nor other EOAs' wallet legs). Phase-3 shadow: each
    // leg's counterparty is checked against our tracked pool registry —
    // covered vs uncovered directly measures the coverage gap.
    let tracked: std::collections::HashSet<Address> = cfg
        .pools
        .iter()
        .filter_map(|p| p.address.parse::<Address>().ok())
        .collect();
    let mut sh_pools_total = 0usize;
    let mut sh_pools_tracked = 0usize;
    let mut shadow_routes: HashMap<Address, (f64, Vec<String>)> = HashMap::new();
    for (addr, _score, _net, _wr, _mw, class, _c) in scored.iter().take(10) {
        let Some(wallet) = ranked.iter().find(|(a, _, _)| a == addr) else {
            continue;
        };
        let Some(best_tx) = wallet.2.best_tx else { continue };
        // Decode up to 12 of the wallet's txs in the window — its most
        // profitable first. Executor-intermediary leaders park the arb legs
        // in sibling txs and settle profit in a separate harvest tx; the
        // union of pool counterparties across the window reconstructs the
        // real route set that a single-tx decode misses entirely.
        let mut decode_txs: Vec<B256> = wallet
            .2
            .top_txs
            .iter()
            .map(|(_, h)| *h)
            .collect();
        for h in &wallet.2.tx_hashes {
            if decode_txs.len() >= 12 {
                break;
            }
            if !decode_txs.contains(h) {
                decode_txs.push(*h);
            }
        }
        // Collect the transfer legs first, then probe every non-wallet
        // counterparty on-chain: slot0/getReserves resolves only on real
        // pools. The previous heuristic (exclude any contract ever used as
        // a tx target) mislabeled DIRECT-CALLED pools as routers — the
        // executor-intermediary leaders call pools straight, so their
        // routes decoded to nothing.
        let mut legs: Vec<(B256, Address, Address, Address, U256)> = Vec::new();
        let mut cand_addrs: std::collections::HashSet<Address> =
            std::collections::HashSet::new();
        let mut first_token = String::new();
        let mut last_token = String::new();
        let mut src_block = 0u64;
        let mut src_index: Option<u64> = None;
        for tx_hash in &decode_txs {
        let Ok(Some(receipt)) = endpoint.get_receipt(*tx_hash).await else {
            continue;
        };
        if *tx_hash == best_tx {
            src_block = receipt.block_number.unwrap_or(0);
            src_index = receipt.transaction_index;
        }
        for log in receipt.inner.logs() {
            let topics = log.topics();
            if topics.len() != 3 || topics[0] != TRANSFER_SIG {
                continue;
            }
            let token = log.address();
            let from = Address::from_word(topics[1]);
            let to = Address::from_word(topics[2]);
            let amount = U256::from_be_slice(log.data().data.as_ref());
            for a in [from, to] {
                if a != *addr && a != token {
                    cand_addrs.insert(a);
                }
            }
            legs.push((*tx_hash, token, from, to, amount));
            if first_token.is_empty() {
                first_token = format!("{token:#x}");
            }
            last_token = format!("{token:#x}");
        }
        }
        // Probe candidates: v3 slot0 (0x3850c7bd) or v2 getReserves
        // (0x0902f1ac) must resolve — routers, executors and sham
        // contracts answer neither.
        let mut is_pool: std::collections::HashSet<Address> =
            std::collections::HashSet::new();
        let mut probed: std::collections::HashSet<Address> =
            std::collections::HashSet::new();
        async fn probe_pool(
            ep: &Endpoint,
            c: Address,
            tracked: &std::collections::HashSet<Address>,
        ) -> bool {
            if tracked.contains(&c) {
                return true;
            }
            let slot0 = ep
                .eth_call_timed(c, alloy_primitives::Bytes::from_static(&[
                    0x38, 0x50, 0xc7, 0xbd,
                ]))
                .await
                .ok()
                .map(|(o, _)| o.len() >= 32 * 7)
                .unwrap_or(false);
            let v2 = !slot0 && ep
                .eth_call_timed(c, alloy_primitives::Bytes::from_static(&[
                    0x09, 0x02, 0xf1, 0xac,
                ]))
                .await
                .ok()
                .map(|(o, _)| o.len() >= 32 * 3)
                .unwrap_or(false);
            slot0 || v2
        }
        for c in &cand_addrs {
            probed.insert(*c);
            if probe_pool(&endpoint, *c, &tracked).await {
                is_pool.insert(*c);
            }
        }
        // Executor-intermediary follow-through: when the wallet's own txs
        // touch no real pool, its arb legs live in txs sent TO its
        // executor contract by other EOAs — harvest legs reveal the
        // executor (the contract paying the wallet). Decode up to 12 txs
        // targeting it and union their pool counterparties.
        let leg_hits_pool = legs.iter().any(|(_, _, f, t, _)| {
            is_pool.contains(f) || is_pool.contains(t)
        });
        if !leg_hits_pool && !legs.is_empty() {
            let mut exec_counts: HashMap<Address, u32> = HashMap::new();
            for (_, _, f, t, _) in &legs {
                if *t == *addr {
                    *exec_counts.entry(*f).or_default() += 1;
                }
            }
            if let Some((&exec, &n_exec)) =
                exec_counts.iter().max_by_key(|(_, c)| *c)
            {
                println!(
                    "EXECUTOR {addr:#x} class={class} exec={exec:#x} harvests={n_exec}"
                );
                let mut seen_txs: std::collections::HashSet<B256> =
                    decode_txs.iter().copied().collect();
                // Level 1: txs sent TO the hub executor.
                let mut pending: Vec<B256> = Vec::new();
                for (h, s) in to_index
                    .get(&exec)
                    .map(|v| v.as_slice())
                    .unwrap_or(&[])
                {
                    if *s != *addr && seen_txs.insert(*h) && pending.len() < 12 {
                        pending.push(*h);
                    }
                }
                let mut level = 0u8;
                loop {
                    for h in &pending {
                        let Ok(Some(receipt)) = endpoint.get_receipt(*h).await else {
                            continue;
                        };
                        for log in receipt.inner.logs() {
                            let topics = log.topics();
                            if topics.len() != 3 || topics[0] != TRANSFER_SIG {
                                continue;
                            }
                            let token = log.address();
                            let from = Address::from_word(topics[1]);
                            let to = Address::from_word(topics[2]);
                            let amount =
                                U256::from_be_slice(log.data().data.as_ref());
                            for a in [from, to] {
                                if a != *addr && a != token {
                                    cand_addrs.insert(a);
                                }
                            }
                            legs.push((*h, token, from, to, amount));
                        }
                    }
                    for c in &cand_addrs {
                        if probed.contains(c) {
                            continue;
                        }
                        probed.insert(*c);
                        if probe_pool(&endpoint, *c, &tracked).await {
                            is_pool.insert(*c);
                        }
                    }
                    if level == 1
                        || legs.iter().any(|(_, _, f, t, _)| {
                            is_pool.contains(f) || is_pool.contains(t)
                        })
                    {
                        break;
                    }
                    level = 1;
                    // Hub-and-spoke fleet: executor txs are single-leg
                    // payouts from per-strategy WORKER contracts. The arb
                    // legs live one level deeper — txs sent to the workers.
                    // Follow the top workers by payout frequency.
                    let mut workers: HashMap<Address, u32> = HashMap::new();
                    for (_, _, f, t, _) in &legs {
                        if *t == exec && *f != *addr {
                            *workers.entry(*f).or_default() += 1;
                        }
                    }
                    let mut w_sorted: Vec<(Address, u32)> =
                        workers.into_iter().collect();
                    // Deterministic tie-break on count — equal-count workers
                    // must not reorder between runs (HashMap iteration is
                    // per-process random).
                    w_sorted.sort_by(|(a, ca), (b, cb)| {
                        cb.cmp(ca).then_with(|| a.cmp(b))
                    });
                    pending.clear();
                    for (w, _) in w_sorted.into_iter().take(16) {
                        println!(
                            "EXEC_WORKER {addr:#x} exec={exec:#x} worker={w:#x}"
                        );
                        for (h, _) in to_index
                            .get(&w)
                            .map(|v| v.as_slice())
                            .unwrap_or(&[])
                        {
                            if pending.len() >= 384 {
                                break;
                            }
                            if seen_txs.insert(*h) {
                                pending.push(*h);
                            }
                        }
                    }
                    if pending.is_empty() {
                        break;
                    }
                }
            }
        }
        let mut hop = 0u32;
        let mut route_pools: std::collections::HashSet<Address> =
            std::collections::HashSet::new();
        let mut ordered_pools: Vec<Address> = Vec::new();
        for (tx_hash, token, from, to, amount) in &legs {
            hop += 1;
            let label = |a: Address| -> String {
                if a == *addr {
                    "WALLET".into()
                } else if is_pool.contains(&a) {
                    format!("pool:{a:#x}")
                } else {
                    format!("router:{a:#x}")
                }
            };
            for a in [*from, *to] {
                if is_pool.contains(&a) {
                    if route_pools.insert(a) {
                        ordered_pools.push(a);
                    }
                }
            }
            println!(
                "LEADER_ROUTE {addr:#x} class={class} tx={tx_hash:#x} \
                 hop={hop} token={token:#x} {} -> {} amt={amount}",
                label(*from),
                label(*to)
            );
        }
        let covered = route_pools.iter().filter(|p| tracked.contains(*p)).count();
        let missing: Vec<String> = route_pools
            .iter()
            .filter(|p| !tracked.contains(*p))
            .map(|p| format!("{p:#x}"))
            .collect();
        // Close the loop: shadow-missing counterparties go straight into the
        // probe set even when their raw hit count ranks below the top-80 cut.
        for p in &route_pools {
            route_pool_addrs.insert(*p);
            if !tracked.contains(p) {
                pool_candidates.entry(*p).or_insert(1);
            }
        }
        sh_pools_total += route_pools.len();
        sh_pools_tracked += covered;
        shadow_routes.insert(
            *addr,
            (
                if route_pools.is_empty() {
                    0.0
                } else {
                    covered as f64 / route_pools.len() as f64
                },
                route_pools.iter().map(|p| format!("{p:#x}")).collect(),
            ),
        );
        println!(
            "SHADOW {addr:#x} class={class} route_pools={} covered={covered} \
             missing=[{}]",
            route_pools.len(),
            missing.join(",")
        );

        // ---- Actionable opportunity record (Commander directive): the
        // intelligence product is an executable opportunity, not a wallet
        // scorecard. Geometry + victim context + leader outcome land here;
        // our own simulator completes allbright_net/reproducibility in the
        // profiler's verify pass.
        let mut opp = arb_core::opportunity::ActionableOpportunity::new(
            &chain,
            &format!("{addr:#x}/{class}"),
            &format!("{addr:#x}"),
            &format!("{best_tx:#x}"),
            ordered_pools.iter().map(|p| format!("{p:#x}")).collect(),
        );
        opp.target_block = src_block;
        opp.leader_net_usd = wallet.2.best_tx_usd;
        opp.token_in = first_token;
        opp.token_out = last_token;
        if let Some(idx) = src_index {
            if idx > 0 {
                if let Ok(Some(v)) =
                    endpoint.get_tx_hash_at_index(opp.target_block, idx - 1).await
                {
                    opp.victim_tx = format!("{v:#x}");
                }
            }
        }
        if opp.victim_tx.is_empty() {
            opp.rejection_reason = "no_victim_context".into();
        } else if covered < route_pools.len() {
            opp.rejection_reason = "route_untracked".into();
        }
        println!(
            "LEADER_OPPORTUNITY {} victim={} pools={} leader_net_usd={:.1} \
             sim=pending reason={}",
            opp.opportunity_id,
            if opp.victim_tx.is_empty() { "—" } else { &opp.victim_tx },
            opp.route_pools.len(),
            opp.leader_net_usd,
            if opp.rejection_reason.is_empty() { "none" } else { &opp.rejection_reason },
        );
        arb_leaders::OPPORTUNITY_TOTAL
            .with_label_values(&[chain.as_str(), "decoded"])
            .inc();
        if !opp.rejection_reason.is_empty() {
            arb_leaders::OPPORTUNITY_REJECTED
                .with_label_values(&[chain.as_str(), opp.rejection_reason.as_str()])
                .inc();
        }
        let _ = opp.append_jsonl(&data_dir);
    }
    if sh_pools_total > 0 {
        println!(
            "SHADOW_COVERAGE tracked={}% ({}/{}) — leader route pools inside our registry",
            sh_pools_tracked * 100 / sh_pools_total,
            sh_pools_tracked,
            sh_pools_total
        );
    }

    // ---- Strategy registry: persist outcome evidence per scored wallet.
    // Observe -> Replay on evidence thresholds; Replay -> Shadow on full
    // route coverage; BoundedLive stays ops-only. Stale entries expire.
    let mut strat = arb_leaders::StrategyRegistry::load(&chain, 20_000);
    let th = arb_leaders::PromoteThresholds::default();
    for (addr, _score, net, wr, mw, class, contracts) in &scored {
        let wallet_hex = format!("{addr:#x}");
        let top_c = contracts.split(',').next().unwrap_or("");
        let family = match top_c.rfind('x') {
            Some(i) if i > 2 => top_c[..i].to_string(),
            _ => top_c.to_string(),
        };
        let (cov, pools) = shadow_routes
            .get(addr)
            .cloned()
            .unwrap_or((0.0, Vec::new()));
        let txs = ranked
            .iter()
            .find(|(a, _, _)| a == addr)
            .map(|(_, _, s)| s.trade_txs)
            .unwrap_or(0);
        let (state, is_new) = strat.upsert_evidence(
            &wallet_hex, class, *net, txs, *wr, *mw, &family, pools, hi, &th,
        );
        strat.mark_coverage(&wallet_hex, class, cov);
        if is_new || state != arb_leaders::StrategyState::Observe {
            println!(
                "STRATEGY {wallet_hex} class={class} state={state:?} \
                 net={net:.2} win_rate={wr:.2} coverage={cov:.2}{}",
                if is_new { " NEW" } else { "" }
            );
        }
    }
    let expired = strat.expire_stale(hi);
    for id in &expired {
        println!("STRATEGY_EXPIRED {id}");
    }
    let _ = strat.save();
    let _ = arb_leaders::StrategyRegistry::save_cursor(&chain, hi);
    // Scan window metadata so consumers (dashboard) can derive honest
    // frequency metrics instead of assuming a window.
    let _ = std::fs::write(
        format!("{data_dir}/_scanmeta.json"),
        serde_json::json!({
            "from_block": lo,
            "to_block": hi,
            "scanned_blocks": hi.saturating_sub(lo) + 1,
            "at": chrono::Utc::now().to_rfc3339(),
        })
        .to_string(),
    );
    let n_live = strat
        .records
        .values()
        .filter(|r| r.state != arb_leaders::StrategyState::Expired)
        .count();
    println!(
        "STRATEGY_REGISTRY active={n_live} expired={} -> data/leaders/{chain}/_strategies.jsonl",
        expired.len()
    );

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
    // Route-discovered pools are probed first — a pool inside a decoded
    // leader route outranks any transfer-graph counterparty, and s_contracts
    // membership can't exclude it (the on-chain provenance gate below is the
    // real filter).
    let mut seen: HashSet<Address> = HashSet::new();
    let mut probe_list: Vec<(Address, u32)> = Vec::new();
    for a in &route_pool_addrs {
        if !tracked.contains(a)
            && !tokens.values().any(|t| t == a)
            && seen.insert(*a)
        {
            probe_list.push((*a, *pool_candidates.get(a).unwrap_or(&1)));
        }
    }
    for (a, n) in cand {
        if probe_list.len() >= 80 {
            break;
        }
        if seen.insert(a) {
            probe_list.push((a, n));
        }
    }
    probe_list.truncate(80);
    let mut pools_toml = String::from(
        "# auto-discovered pools from leader routes — merge into config [[pools]]\n",
    );
    let mut n_v2 = 0u32;
    let mut n_v3 = 0u32;
    let mut n_thin = 0u32;
    let addr_of = |sel: [u8; 4]| alloy_primitives::Bytes::from(sel.to_vec());
    let mut new_tokens: Vec<String> = Vec::new();
    for (addr, hits) in probe_list.iter() {
        let slot0 = endpoint
            .eth_call_timed(*addr, addr_of([0x38, 0x50, 0xc7, 0xbd]))
            .await
            .ok()
            .map(|(o, _)| o);
        let reserves = endpoint
            .eth_call_timed(*addr, addr_of([0x09, 0x02, 0xf1, 0xac]))
            .await
            .ok()
            .map(|(o, _)| o);
        let v3 = slot0.as_ref().map(|o| o.len() >= 32 * 7).unwrap_or(false);
        let v2 = !v3 && reserves.as_ref().map(|o| o.len() >= 32 * 3).unwrap_or(false);
        if !v2 && !v3 {
            continue;
        }
        // Provenance gate (counterfeit-pool defense): sham/honeypot pools
        // typically hold dust liquidity on one side. V2: both reserves must
        // clear a raw floor; V3: liquidity() must be non-trivial.
        // Sham-pool check first: bait contracts answer getReserves/slot0 with
        // fabricated data but skip the rest of the pair ABI. A real V2 pool is
        // an ERC20 LP token (totalSupply resolves) deployed by a factory
        // (factory() resolves nonzero); a real V3 pool resolves factory() too.
        // Selector set: factory()=0xc45a0155, totalSupply()=0x18160ddd.
        let factory_ok = endpoint
            .eth_call_timed(*addr, addr_of([0xc4, 0x5a, 0x01, 0x55]))
            .await
            .ok()
            .and_then(|(o, _)| o.get(12..32).map(|b| Address::from_slice(b)))
            .map(|f| f != Address::ZERO)
            .unwrap_or(false);
        let prov = if v3 {
            let liq_deep = endpoint
                .eth_call_timed(*addr, addr_of([0x1a, 0x68, 0x65, 0x02]))
                .await
                .ok()
                .and_then(|(o, _)| o.get(..32).map(|b| U256::from_be_slice(b)))
                .map(|liq| if liq > U256::from(10_000u64) { "deep" } else { "thin" })
                .unwrap_or("suspect");
            if factory_ok { liq_deep } else { "suspect" }
        } else {
            let reserve_depth = reserves
                .as_ref()
                .and_then(|o| {
                    let r0 = o.get(0..32).map(|b| U256::from_be_slice(b));
                    let r1 = o.get(32..64).map(|b| U256::from_be_slice(b));
                    r0.zip(r1)
                })
                .map(|(r0, r1)| {
                    if r0 > U256::from(100_000u64) && r1 > U256::from(100_000u64) {
                        "deep"
                    } else {
                        "thin"
                    }
                })
                .unwrap_or("suspect");
            let lp_ok = endpoint
                .eth_call_timed(*addr, addr_of([0x18, 0x16, 0x0d, 0xdd]))
                .await
                .ok()
                .and_then(|(o, _)| o.get(..32).map(|b| U256::from_be_slice(b)))
                .map(|ts| ts > U256::ZERO)
                .unwrap_or(false);
            if factory_ok && lp_ok { reserve_depth } else { "suspect" }
        };
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
        // Token sanity: a pool side pointing at a non-contract address means a
        // counterfeit or malformed pair — never import those.
        let mut prov = prov;
        for t in [t0, t1].into_iter().flatten() {
            let code = endpoint
                .pool_pick()
                .1
                .get_code_at(t)
                .await
                .map(|c| c.len() > 100)
                .unwrap_or(false);
            if !code {
                prov = "suspect";
            }
        }
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
            "LEADER_POOL {addr:#x} protocol={kind} hits={hits} prov={prov} {s0}/{s1} fee_bps={fee_bps}"
        );
        if prov != "deep" {
            n_thin += 1;
            continue;
        }
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
        "LEADER_POOLS exported v2={n_v2} v3={n_v3} thin_or_suspect={n_thin} -> {pools_path}"
    );
    if merge_config {
        match merge_into_config(&cfg_path, &pools_toml, &new_tokens) {
            Ok((p, t)) => println!(
                "LEADER_MERGE merged pools={p} tokens={t} -> {cfg_path}"
            ),
            Err(e) => eprintln!("LEADER_MERGE failed: {e:#}"),
        }
    }

    let path = format!("{data_dir}/_scanned.jsonl");
    let n_targets = export.lines().count();
    if n_targets > 0 {
        std::fs::write(&path, &export)?;
    }
    println!("LEADER_SCAN exported {n_targets} targeted wallets -> {path}");

    if loop_secs == 0 {
        return Ok(());
    }
    println!("LEADER_LOOP sleeping {loop_secs}s — cursor resumes at block {}", hi + 1);
    tokio::time::sleep(std::time::Duration::from_secs(loop_secs)).await;
    }
}

/// Merge provenance-passed `[[pools]]` blocks and `[tokens]` rows into the
/// chain config. Textual edit — preserves comments/formatting. Dedupes by
/// pool address (case-insensitive) and token symbol/address. Returns
/// (pools_added, tokens_added).
fn merge_into_config(
    cfg_path: &str,
    pools_toml: &str,
    new_tokens: &[String],
) -> Result<(usize, usize)> {
    let mut cfg_text = std::fs::read_to_string(cfg_path)?;
    let lower = cfg_text.to_lowercase();

    // Insert missing tokens FIRST (at the end of the [tokens] table, i.e.
    // before the next section header) so appended [[pools]] blocks can't
    // swallow bare keys. Symbol = text before '='; address = quoted value.
    let mut n_tokens = 0usize;
    if !new_tokens.is_empty() {
        let mut insert_at: Option<usize> = None;
        let mut in_tokens = false;
        let mut found_tokens = false;
        for (i, line) in cfg_text.lines().enumerate() {
            let t = line.trim();
            if t.starts_with('[') {
                if in_tokens {
                    insert_at = Some(i);
                    break;
                }
                in_tokens = t == "[tokens]";
                found_tokens |= in_tokens;
            }
        }
        let mut added = String::new();
        // No [tokens] section at all: a bare key at EOF would land inside the
        // last [[pools]] element — open a fresh [tokens] table instead.
        if !found_tokens {
            added.push_str("[tokens]\n");
        }
        for tok in new_tokens {
            let sym = tok.split('=').next().unwrap_or("").trim().to_string();
            let addr = tok
                .split('"')
                .nth(1)
                .unwrap_or("")
                .to_lowercase();
            if sym.is_empty()
                || addr.is_empty()
                || lower.contains(&format!("{sym} ="))
                || lower.contains(&addr)
            {
                continue;
            }
            added.push_str(tok);
            added.push('\n');
            n_tokens += 1;
        }
        if n_tokens > 0 {
            if found_tokens && insert_at.is_none() {
                // [tokens] is the last section — append at EOF.
                if !cfg_text.ends_with('\n') {
                    cfg_text.push('\n');
                }
                cfg_text.push_str(&added);
            } else {
                let lines: Vec<&str> = cfg_text.lines().collect();
                let byte_off: usize = insert_at
                    .map(|i| lines[..i].iter().map(|l| l.len() + 1).sum())
                    .unwrap_or(cfg_text.len());
                cfg_text.insert_str(byte_off, &added);
            }
        }
    }

    // Split pools_toml into [[pools]] blocks; keep only ones whose address is
    // not already configured.
    let mut pool_blocks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in pools_toml.lines() {
        if line.trim_start().starts_with("[[pools]]") {
            if !cur.trim().is_empty() {
                pool_blocks.push(std::mem::take(&mut cur));
            }
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() {
        pool_blocks.push(cur);
    }
    let mut n_pools = 0usize;
    for block in &pool_blocks {
        let Some(addr) = block
            .lines()
            .find_map(|l| {
                let l = l.trim();
                l.strip_prefix("address")
                    .and_then(|r| r.split('=').nth(1))
                    .map(|v| v.trim().trim_matches('"').to_lowercase())
            })
        else {
            continue;
        };
        if lower.contains(&addr) {
            continue;
        }
        if !cfg_text.ends_with('\n') {
            cfg_text.push('\n');
        }
        cfg_text.push_str(block);
        cfg_text.push('\n');
        n_pools += 1;
    }

    if n_pools > 0 || n_tokens > 0 {
        std::fs::write(cfg_path, &cfg_text)?;
    }
    Ok((n_pools, n_tokens))
}
