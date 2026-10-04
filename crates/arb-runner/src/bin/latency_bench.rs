// Measures per-endpoint RPC latency honestly: cold-connect vs warm keep-alive
// round-trips, eth_blockNumber floor vs a real batched eth_call, over both
// HTTPS and WSS transports. Usage:
//   latency_bench <config.toml> [state_reader_addr] [samples]
//
// If a StateReader address is given, the eth_call phase issues a real
// readV2 batch (up to 8 configured V2 pools) — the same call shape the
// production refresher makes. Otherwise it falls back to getReserves() on
// the first configured V2 pool.

use std::time::{Duration, Instant};

use alloy::providers::{DynProvider, Provider, ProviderBuilder, WsConnect};
use alloy::sol;
use alloy_primitives::{Address, Bytes};
use alloy_sol_types::SolCall;
use anyhow::Result;
use arb_core::types::Protocol;

sol! {
    #[sol(rpc)]
    interface IStateReader {
        struct V2State {
            address pool;
            address token0;
            address token1;
            uint112 reserve0;
            uint112 reserve1;
            uint32 fee;
        }
        function readV2(address[] calldata pools) external view returns (V2State[] memory);
    }
    #[sol(rpc)]
    interface IV2Pool {
        function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    }
}

#[path = "../config.rs"]
mod config;

const CALL_TIMEOUT: Duration = Duration::from_secs(8);
const TARGET_MS: f64 = 40.0;
const STRETCH_MS: f64 = 10.0;

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let i = ((sorted.len() as f64 - 1.0) * p / 100.0).round() as usize;
    sorted[i.min(sorted.len() - 1)]
}

async fn timed<F, T>(f: F) -> (f64, bool)
where
    F: std::future::Future<Output = Result<T, alloy::transports::TransportError>>,
{
    let t = Instant::now();
    match tokio::time::timeout(CALL_TIMEOUT, f).await {
        Ok(Ok(_)) => (t.elapsed().as_secs_f64() * 1000.0, true),
        Ok(Err(_)) | Err(_) => (t.elapsed().as_secs_f64() * 1000.0, false),
    }
}

struct Row {
    endpoint: String,
    transport: &'static str,
    cold_ms: f64,
    warm: Vec<f64>,
    call: Vec<f64>,
    note: String,
}

async fn bench_endpoint(url: &str, calldata: Bytes, call_to: Address, samples: usize) -> Row {
    let mut row = Row {
        endpoint: url.to_string(),
        transport: if url.starts_with("wss") {
            "wss"
        } else {
            "https"
        },
        cold_ms: f64::NAN,
        warm: Vec::new(),
        call: Vec::new(),
        note: String::new(),
    };

    let provider: DynProvider = match (url.parse::<url::Url>(), url.starts_with("wss")) {
        (Ok(u), false) => ProviderBuilder::new().connect_http(u).erased(),
        (Ok(_), true) => match ProviderBuilder::new().connect_ws(WsConnect::new(url)).await {
            Ok(p) => p.erased(),
            Err(e) => {
                row.note = format!("ws connect failed: {e}");
                return row;
            }
        },
        _ => {
            row.note = "unparseable url (unset env var?)".to_string();
            return row;
        }
    };

    // First request on a fresh connection = TCP+TLS+WS handshake included.
    let (cold, ok) = timed(provider.get_block_number()).await;
    row.cold_ms = cold;
    if !ok {
        row.note = "cold eth_blockNumber failed/timeout".to_string();
        return row;
    }

    for _ in 0..samples {
        let (ms, ok) = timed(provider.get_block_number()).await;
        if ok {
            row.warm.push(ms);
        }
    }
    row.warm.sort_by(|a, b| a.partial_cmp(b).unwrap());

    for _ in 0..samples {
        let tx = alloy::rpc::types::TransactionRequest::default()
            .to(call_to)
            .input(calldata.clone().into());
        let (ms, ok) = timed(async { provider.call(tx).await }).await;
        if ok {
            row.call.push(ms);
        }
    }
    row.call.sort_by(|a, b| a.partial_cmp(b).unwrap());

    if row.call.is_empty() {
        row.note = "eth_call failed every sample".to_string();
    }
    row
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let mut args = std::env::args().skip(1);
    let cfg_path = args
        .next()
        .expect("usage: latency_bench <config> [state_reader] [samples]");
    let reader_arg = args.next().unwrap_or_default();
    let samples: usize = args.next().map(|s| s.parse().unwrap_or(10)).unwrap_or(10);

    let cfg = config::load_config(&cfg_path)?;
    let reader: Address = reader_arg
        .parse()
        .or_else(|_| cfg.chain.state_reader.parse::<Address>())
        .unwrap_or(Address::ZERO);

    // Probe calldata: real readV2 batch when a reader is deployed, else a
    // single getReserves on the first configured V2 pool.
    let mut v2_pools: Vec<Address> = cfg
        .pools
        .iter()
        .filter(|p| p.parse_protocol() == Protocol::UniswapV2)
        .filter_map(|p| p.address.parse().ok())
        .take(8)
        .collect();
    let (call_to, calldata, call_desc) = if !reader.is_zero() && !v2_pools.is_empty() {
        (
            reader,
            Bytes::from(IStateReader::readV2Call::new((v2_pools.clone(),)).abi_encode()),
            format!("readV2({} pools)", v2_pools.len()),
        )
    } else if let Some(p) = v2_pools.pop() {
        (
            p,
            Bytes::from(IV2Pool::getReservesCall::new(()).abi_encode()),
            "getReserves".to_string(),
        )
    } else {
        anyhow::bail!("no V2 pool in config for the eth_call probe");
    };

    let mut urls: Vec<String> = cfg.chain.rpc_https_pool.clone();
    if urls.is_empty() {
        urls.push(cfg.chain.rpc_https.clone());
    }
    let mut wss: Vec<String> = cfg.chain.rpc_wss_pool.clone();
    if wss.is_empty() {
        wss.push(cfg.chain.rpc_wss.clone());
    }

    println!(
        "chain={} probe={call_desc} samples={samples}",
        cfg.chain.name
    );
    println!(
        "{:<52} {:>4} {:>9} {:>9} {:>9} {:>9} {:>9}  note",
        "endpoint", "kind", "cold_ms", "bn_p50", "bn_p99", "call_p50", "call_p99"
    );

    let mut best_warm_p50 = f64::MAX;
    let mut best_call_p50 = f64::MAX;
    for url in urls.iter().chain(wss.iter()) {
        let r = bench_endpoint(url, calldata.clone(), call_to, samples).await;
        let bn50 = pct(&r.warm, 50.0);
        let bn99 = pct(&r.warm, 99.0);
        let c50 = pct(&r.call, 50.0);
        let c99 = pct(&r.call, 99.0);
        println!(
            "{:<52} {:>4} {:>9.1} {:>9.1} {:>9.1} {:>9.1} {:>9.1}  {}",
            r.endpoint, r.transport, r.cold_ms, bn50, bn99, c50, c99, r.note
        );
        if !r.warm.is_empty() {
            best_warm_p50 = best_warm_p50.min(bn50);
        }
        if !r.call.is_empty() {
            best_call_p50 = best_call_p50.min(c50);
        }
    }

    println!();
    println!("best warm eth_blockNumber p50 = {:.1}ms", best_warm_p50);
    println!("best warm probe-call p50     = {:.1}ms", best_call_p50);
    println!(
        "<{}ms per call on public RPC: {}",
        TARGET_MS as u64,
        if best_call_p50 < TARGET_MS {
            "ACHIEVED (p50)"
        } else {
            "not achieved from this vantage point"
        }
    );
    println!(
        "<{}ms per call on public RPC: {}",
        STRETCH_MS as u64,
        if best_call_p50 < STRETCH_MS {
            "ACHIEVED (p50)"
        } else {
            "not achieved — local/co-located node required"
        }
    );
    Ok(())
}
