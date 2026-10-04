use prometheus::{
    register_counter, register_counter_vec, register_gauge, register_gauge_vec, register_histogram,
    Counter, CounterVec, Gauge, GaugeVec, Histogram, Encoder, TextEncoder,
};
use tokio::task::JoinHandle;
use tracing::info;

lazy_static::lazy_static! {
    pub static ref PATHS_EVALUATED: Counter = register_counter!(
        "arb_paths_evaluated_total",
        "Total number of path evaluations"
    ).unwrap();

    pub static ref PROFITABLE_FOUND: Counter = register_counter!(
        "arb_profitable_found_total",
        "Total profitable paths found"
    ).unwrap();

    pub static ref GROSS_PROFIT_USD: Counter = register_counter!(
        "arb_gross_profit_usd_total",
        "Cumulative effective profit USD of profitable paths found"
    ).unwrap();

    pub static ref NET_PROFIT_USD: Counter = register_counter!(
        "arb_net_profit_usd_total",
        "Cumulative net profit USD of paths that passed the profit gate"
    ).unwrap();

    pub static ref SUBMIT_ATTEMPTS: Counter = register_counter!(
        "arb_submit_attempts_total",
        "Total bundle submission attempts"
    ).unwrap();

    pub static ref TOKEN_PROFIT_USD: CounterVec = register_counter_vec!(
        "arb_token_profit_usd_total",
        "Cumulative effective profit USD by flash token",
        &["token"]
    ).unwrap();

    pub static ref PROFITABLE_BY_TOKEN: CounterVec = register_counter_vec!(
        "arb_profitable_by_token_total",
        "Profitable paths found by flash token",
        &["token"]
    ).unwrap();

    pub static ref SUBMIT_BY_VENUE: CounterVec = register_counter_vec!(
        "arb_submit_by_venue_total",
        "Submission attempts by venue and tier",
        &["venue", "tier"]
    ).unwrap();

    pub static ref SUBMIT_LANDED: CounterVec = register_counter_vec!(
        "arb_submit_landed_total",
        "Tx landing outcomes",
        &["status"]
    ).unwrap();

    pub static ref WARP_SPEND_USD: Counter = register_counter!(
        "arb_warp_spend_usd_total",
        "Total USD spent on Warp/Trader calls at $0.15 each"
    ).unwrap();

    pub static ref SCAN_LATENCY: Histogram = register_histogram!(
        "arb_scan_latency_seconds",
        "Per-block scan latency in seconds",
        vec![0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0]
    ).unwrap();

    pub static ref STATE_REFRESH_LATENCY: Histogram = register_histogram!(
        "arb_state_refresh_seconds",
        "State refresh latency in seconds",
        vec![0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5]
    ).unwrap();

    /// Phase-1 latency budget: pending-swap receipt → first candidate
    /// evaluation, and pending receipt → bundle submit. These are the two
    /// numbers that decide whether we win the same-block backrun race.
    pub static ref PENDING_TO_EVAL: Histogram = register_histogram!(
        "arb_pending_to_eval_seconds",
        "Pending-swap receive to candidate evaluation latency in seconds",
        vec![0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]
    ).unwrap();

    pub static ref PENDING_TO_SUBMIT: Histogram = register_histogram!(
        "arb_pending_to_submit_seconds",
        "Pending-swap receive to backrun bundle submit latency in seconds",
        vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0]
    ).unwrap();

    pub static ref CURRENT_BLOCK: Gauge = register_gauge!(
        "arb_current_block",
        "Latest block number processed"
    ).unwrap();

    pub static ref POOL_COUNT: Gauge = register_gauge!(
        "arb_pool_count",
        "Number of pools being monitored"
    ).unwrap();

    pub static ref GAS_SPENT_WEI: Counter = register_counter!(
        "arb_gas_spent_wei_total",
        "Total gas spent in wei"
    ).unwrap();

    pub static ref PATH_SUPPRESSED: Counter = register_counter!(
        "arb_path_suppressed_total",
        "Paths suppressed by circuit breaker"
    ).unwrap();

    pub static ref BAIT_SUSPECT: Counter = register_counter!(
        "arb_bait_suspect_total",
        "Pools suppressed by bait telemetry (repeated gate-pass-then-revert signature)"
    ).unwrap();

    pub static ref STALE_SUPPRESSED: Counter = register_counter!(
        "arb_stale_suppressed_total",
        "Candidate paths suppressed for containing pools whose state refresh is stale"
    ).unwrap();

    pub static ref BUILDER_SIM_REJECT: Counter = register_counter!(
        "arb_builder_sim_reject_total",
        "Builder simulation rejections (pre-revert signal)"
    ).unwrap();

    pub static ref GATE_REJECTS: CounterVec = register_counter_vec!(
        "arb_gate_rejects_total",
        "Profit-gate rejections by reason (below_min_bps|below_safety_margin|below_min_usd|optimizer_none|no_profit_default)",
        &["reason"]
    ).unwrap();

    pub static ref GATE_EFFECTIVE_USD: Histogram = register_histogram!(
        "arb_gate_effective_usd",
        "Effective USD of gate-evaluated candidates (accepted + rejected)",
        vec![0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 1.5, 2.0, 5.0, 10.0, 50.0]
    ).unwrap();

    /// Candidates the profit gate ACCEPTED — the "would have submitted"
    /// count in dry-run, the pre-submission count live.
    pub static ref GATE_ACCEPTS: Counter = register_counter!(
        "arb_gate_accepts_total",
        "Profit-gate accepted candidates (resting + backrun)"
    ).unwrap();

    /// Cumulative projected net USD of gate-accepted candidates — the
    /// pipeline's projected P&L before execution, resting + backrun.
    pub static ref ACCEPTED_PROFIT_USD: Counter = register_counter!(
        "arb_accepted_profit_usd_total",
        "Cumulative projected net USD of profit-gate accepted candidates"
    ).unwrap();

    /// 1 when the runner is in dry-run (measure mode: full pipeline, no
    /// on-chain submission), 0 when live. Lets dashboards show the mode.
    pub static ref DRY_RUN: Gauge = register_gauge!(
        "arb_dry_run",
        "1 = dry-run measure mode, 0 = live submission"
    ).unwrap();

    pub static ref SPONSORSHIP_REJECTS: CounterVec = register_counter_vec!(
        "arb_sponsorship_rejects_total",
        "Sponsored UserOperation rejections by reason (gasless mode)",
        &["reason"]
    ).unwrap();

    pub static ref BACKRUN_CANDIDATES: Counter = register_counter!(
        "arb_backrun_candidates_total",
        "Pending swaps matched for backrun evaluation"
    ).unwrap();

    /// Backrun bundles that found no ordering-aware venue to carry them
    /// (e.g. strict_4337 leaves only the UserOp bundler, which cannot order
    /// after a victim tx).
    pub static ref BACKRUN_NO_VENUE: Counter = register_counter!(
        "arb_backrun_no_venue_total",
        "Backrun bundles dropped: no bundle-capable submit venue configured"
    ).unwrap();

    pub static ref BACKRUN_SUBMITTED: Counter = register_counter!(
        "arb_backrun_submitted_total",
        "Backrun bundles submitted"
    ).unwrap();

    /// Settlement feedback: submissions tracked to an on-chain outcome,
    /// labeled by realized result (settled/revert/dropped).
    pub static ref SETTLEMENTS: CounterVec = register_counter_vec!(
        "arb_settlements_total",
        "Submissions settled on-chain by outcome",
        &["chain", "outcome"]
    ).unwrap();

    /// Cumulative realized P&L after gas, USD. A gauge because realized
    /// losses decrement it — this is the number the whole engine exists for.
    pub static ref SETTLED_NET_USD: GaugeVec = register_gauge_vec!(
        "arb_settled_net_usd",
        "Cumulative realized net P&L after gas, USD",
        &["chain"]
    ).unwrap();
}

async fn metrics_handler() -> String {
    let encoder = TextEncoder::new();
    let mut buf = Vec::new();
    encoder.encode(&prometheus::gather(), &mut buf).unwrap();
    String::from_utf8(buf).unwrap()
}

pub fn start_metrics_server(port: u16) -> JoinHandle<()> {
    // Register all lazy counters up front so exporters emit zero-valued
    // series before the first event — dashboards rely on key presence.
    let _ = GROSS_PROFIT_USD.get();
    let _ = NET_PROFIT_USD.get();
    let _ = GATE_ACCEPTS.get();
    let _ = ACCEPTED_PROFIT_USD.get();
    let _ = DRY_RUN.get();
    tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/metrics", axum::routing::get(metrics_handler))
            .route("/health", axum::routing::get(|| async { "ok" }));

        let listener = match tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(port, error = %e, "Failed to bind metrics port, metrics HTTP disabled");
                loop { tokio::time::sleep(std::time::Duration::from_secs(3600)).await; }
            }
        };
        info!(port, "Prometheus /metrics HTTP server listening");
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(error = %e, "Metrics server failed");
        }
    })
}
