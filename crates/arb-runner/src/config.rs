use std::collections::HashMap;

use anyhow::Result;
use serde::Deserialize;

use arb_core::types::Protocol;
use arb_rpc::ChainConfig;

/// Compile-time spec primitives (docs/AGENTS_SPEC.md §2 + scoring matrix).
/// These are `const` so the compiler inlines/vectorizes the gate and math
/// expressions — no runtime config lookups inside the calculation cycle.
pub mod spec {
    /// Minimum margin threshold per execution (USD).
    /// Hard floor on accepted net profit. Under mandatory Pimlico
    /// sponsorship the engine pays no gas — the operator's only cost is
    /// sponsor credit (~$0.05-0.15/op on BSC/Base), so edges far below the
    /// legacy gas-era $1.50 are real profit.
    pub const MIN_NET_PROFIT_USD: f64 = 0.01;
    /// 3-hop depth limitation.
    pub const MAX_PATH_HOPS: usize = 3;
    /// Prioritize 0% borrow-fee venues.
    pub const BALANCER_FEE_ZERO: bool = true;
    pub const DODO_FEE_ZERO: bool = true;
    /// Core processing execution ceiling.
    pub const TARGET_MATH_LATENCY_MICROS: u64 = 5;
    /// Node failover switch time budget.
    pub const RPC_MAX_LATENCY_MS: u64 = 10;
    /// Seconds an RPC node is blacklisted after a 429/timeout.
    pub const RPC_BLACKLIST_SECS: u64 = 60;
    /// Mempool ingestion polling resolution.
    pub const MEMPOOL_POLL_INTERVAL_MS: u64 = 5;
    pub const BASE_CHAIN_ID: u64 = 8453;
    pub const BSC_CHAIN_ID: u64 = 56;
    /// Submission-routing deadlines (VenueRouter): private-builder RTT
    /// budget on BSC — tighter since the slot is ~450ms; Base gets
    /// sequencer slack on its 2s slot.
    pub const BSC_MEV_SUBMIT_TIMEOUT_MS: u64 = 8;
    pub const BASE_SUBMIT_TIMEOUT_MS: u64 = 250;
    /// Block-construction slot cutoffs: skip the submit fan-out entirely
    /// once this much of the slot has elapsed (bundle would land stale).
    pub const BSC_SLOT_BUDGET_MS: u64 = 400;
    pub const BASE_SLOT_BUDGET_MS: u64 = 1600;
    /// Base sequencer state-read tick granularity.
    pub const BASE_SEQUENCER_POLL_INTERVAL_MICROS: u64 = 800;
    /// Canonical Balancer Vault (same address on BSC and Base).
    pub const BALANCER_VAULT: &str = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
}

#[derive(Debug, Deserialize)]
pub struct AppConfig {
    pub chain: ChainConfig,
    pub wallet: WalletConfig,
    pub scanner: ScannerConfig,
    pub submission: SubmissionConfig,
    pub gate: GateConfig,
    pub pools: Vec<PoolEntry>,
    pub tokens: HashMap<String, String>,
    pub token_usd_prices: HashMap<String, f64>,
    /// `[leaders]` — optional leader-wallet observation registry
    /// (arb-leaders Phase 0/1; absent or empty = feature off).
    #[serde(default)]
    pub leaders: arb_leaders::LeadersConfig,
}

#[derive(Debug, Deserialize)]
pub struct WalletConfig {
    pub private_key_env: String,
    /// Optional signer rotation pool (stealth L1): env var names holding
    /// additional EOA keys. When set, submit calls round-robin across all
    /// signers so no single address fingerprints the operation. Each EOA
    /// must be funded independently — shared funding sources defeat the
    /// rotation (see docs/research/STEALTH_OPSEC.md L0).
    #[serde(default)]
    pub private_key_envs: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct ScannerConfig {
    pub flash_tokens: Vec<String>,
    pub flash_amounts: HashMap<String, u64>,
    #[serde(default)]
    pub flash_bounds: HashMap<String, FlashBounds>,
    pub min_profit_bps: u32,
    #[serde(default = "default_min_initial_bps")]
    pub min_initial_bps: u32,
    #[serde(default = "default_optimization_iterations")]
    pub optimization_iterations: usize,
    pub dry_run: bool,
}

#[derive(Debug, Deserialize, Clone)]
pub struct FlashBounds {
    pub min: u64,
    pub max: u64,
}

#[derive(Debug, Deserialize)]
pub struct GateConfig {
    #[serde(default = "default_min_profit_usd")]
    pub min_profit_usd: f64,
    #[serde(default = "default_safety_margin_bps")]
    pub safety_margin_bps: u32,
    #[serde(default = "default_stable_extra_margin")]
    pub stable_pool_extra_margin_bps: u32,
    /// Per-protocol extra safety margins (ported pattern: per-(chain,DEX)
    /// calibrated gates). Keys are PoolEntry protocol strings (e.g.
    /// "pcs_stable", "v3", "dodo"). The largest margin across a path's hops
    /// is added to safety_margin_bps. Values stay conservative until realized
    /// fills provide sim-vs-live divergence data to calibrate against.
    pub protocol_margins: Option<std::collections::HashMap<String, u32>>,
    /// Estimated gas used by one arb execution (flash-loan + swaps). Used
    /// with live `eth_gasPrice` to net execution cost out of the profit
    /// floor — gross sim profit ignores the tx's own gas, the dominant
    /// cost on cheap-fee chains. Conservative default 350k.
    #[serde(default = "default_est_tx_gas")]
    pub est_tx_gas: u64,
}

#[derive(Debug, Deserialize)]
pub struct SubmissionConfig {
    pub puissant_url: Option<String>,
    pub blockrazor_url: Option<String>,
    pub jetbldr_url: Option<String>,
    pub nodereal_url: Option<String>,
    pub blink_url: Option<String>,
    /// Minimum projected USD profit before using the paid Warp/Trader endpoint.
    /// Set high — every Warp call costs $0.15. Default is $50 if omitted.
    #[serde(default = "default_warp_threshold")]
    pub warp_threshold_usd: f64,
    /// Hard cap on Warp spend per runner session (USD). Bot will stop when exceeded.
    /// Default is $5.00. Override in config to suit your risk tolerance.
    #[serde(default = "default_warp_budget")]
    pub warp_budget_usd: f64,
    /// Enable the direct Growth-RPC fallback submitter.
    /// Defaults to FALSE — enabling this is safe (it uses the free endpoint),
    /// but it sends txs unprotected (no MEV/backrun protection).
    #[serde(default = "default_false")]
    pub direct_fallback: bool,

    /// ERC-4337 gasless venue (allbrightA Account Abstraction Rule): wraps the
    /// arb call in a UserOperation and submits via the Pimlico bundler.
    /// Defaults to FALSE.
    #[serde(default = "default_false")]
    pub pimlico_enabled: bool,
    /// e.g. "https://api.pimlico.io/v2/binance/rpc?apikey=${PIMLICO_API_KEY}"
    /// Chain slugs: "base" for 8453, "binance" for 56.
    pub pimlico_bundler_url: Option<String>,
    /// EntryPoint override; defaults to canonical v0.6 (0x5FF1...2789).
    pub entry_point: Option<String>,
    /// Smart account factory override; defaults to SimpleAccountFactory v0.6.
    pub account_factory: Option<String>,
    /// Name of the env var holding the Pimlico sponsorship policy (sp_...).
    /// When unset or empty the smart account pays its own gas.
    pub sponsor_policy_id_env: Option<String>,
    /// CREATE2 salt for the counterfactual smart account. Default 0.
    pub smart_account_salt: Option<u64>,
    /// Spec Account Abstraction Rule: when true and the Pimlico venue is
    /// available, legacy bundle/direct venues are disabled and ALL execution
    /// routes through the ERC-4337 UserOperation assembler. Default FALSE.
    #[serde(default = "default_false")]
    pub strict_4337: bool,
}

/// Effective profit floor: the spec's compile-time constant is the hard
/// floor; TOML can only raise it, never lower it.
pub fn min_profit_usd_floor(cfg_value: f64) -> f64 {
    cfg_value.max(spec::MIN_NET_PROFIT_USD)
}

fn default_warp_threshold() -> f64 { 50.0 }
fn default_warp_budget() -> f64 { 5.0 }
fn default_false() -> bool { false }
fn default_est_tx_gas() -> u64 { 350_000 }
fn default_min_profit_usd() -> f64 { 0.50 }
fn default_safety_margin_bps() -> u32 { 30 }
fn default_stable_extra_margin() -> u32 { 50 }
fn default_min_initial_bps() -> u32 { 1 }
fn default_optimization_iterations() -> usize { 30 }

#[derive(Debug, Deserialize)]
pub struct PoolEntry {
    #[allow(dead_code)]
    pub name: String,
    pub address: String,
    pub protocol: String,
    pub token0: String,
    pub token1: String,
    pub fee_bps: u32,
}

impl PoolEntry {
    pub fn parse_protocol(&self) -> Protocol {
        parse_protocol_name(&self.protocol)
    }
}

/// Protocol-name string -> Protocol (config key space, e.g. "v3", "pcs_stable").
/// Shared by PoolEntry::parse_protocol and gate protocol-margin parsing.
pub fn parse_protocol_name(s: &str) -> Protocol {
    match s {
            "v2" | "uniswap_v2" | "pancake_v2" | "biswap" => Protocol::UniswapV2,
            "v3" | "uniswap_v3" | "pancake_v3" => Protocol::UniswapV3,
            "v4" | "uniswap_v4" => Protocol::UniswapV4,
            "pcs_stable" | "curve" => Protocol::PancakeStable,
            "wombat" => Protocol::Wombat,
            "dodo_v2" | "dodo" => Protocol::DodoV2,
            "algebra" | "thena" => Protocol::Algebra,
            "aero_v2" | "aerodrome" | "velodrome" => Protocol::AerodromeV2,
            "aero_slipstream" | "slipstream" => Protocol::AerodromeSlipstream,
            _ => Protocol::UniswapV2,
    }
}

pub fn load_config(path: &str) -> Result<AppConfig> {
    let contents = std::fs::read_to_string(path)?;
    let expanded = expand_env_vars(&contents);
    let config: AppConfig = toml::from_str(&expanded)?;
    Ok(config)
}

fn expand_env_vars(input: &str) -> String {
    let mut result = input.to_string();
    for (key, value) in std::env::vars() {
        result = result.replace(&format!("${{{key}}}"), &value);
        result = result.replace(&format!("${key}"), &value);
    }
    result
}
