use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct ChainConfig {
    pub chain_id: u64,
    pub name: String,
    /// Free/cheap Growth endpoint — used for ALL reads (state refresh, block number, nonce, gas price)
    pub rpc_https: String,
    /// Additional free read endpoints for the failover pool (round-robin,
    /// 60s blacklist on 429/timeout). Empty = rpc_https only.
    #[serde(default)]
    pub rpc_https_pool: Vec<String>,
    /// WSS provider pool for the mempool stream — watcher cycles to the next
    /// entry on stream failure or >5ms backpressure. Falls back to rpc_wss.
    #[serde(default)]
    pub rpc_wss_pool: Vec<String>,
    pub rpc_wss: String,
    /// Expensive Trader/Warp endpoint — used ONLY for eth_sendRawTransaction.
    /// On Chainstack Trader nodes each call costs ~$0.15, so never use this for reads.
    pub trader_rpc: Option<String>,
    pub arb_contract: String,
    pub state_reader: String,
    pub block_time_ms: u64,
    pub scan_budget_ms: u64,
    /// Per-read RPC deadline (state refresh / probes). Default 400ms — raise
    /// for chains whose public endpoints answer batches slower (ETH/Polygon).
    #[serde(default)]
    pub call_deadline_ms: Option<u64>,
    /// Uniswap V4 / PancakeSwap Infinity CLAMM PoolManager singleton address.
    /// Required only when `[[pools]]` contains v4 entries — V4 state is read
    /// via `extsload` against this contract.
    #[serde(default)]
    pub v4_pool_manager: Option<String>,
    /// Private-orderflow mempool feeds (e.g. bloXroute BDN, Eden network,
    /// proprietary relays). Same pending-tx protocol as the public stream;
    /// merged with rpc_wss_pool sources — the watcher cycles all of them.
    /// Use `${VAR}` to keep credentials out of the file.
    #[serde(default)]
    pub private_mempool_wss: Vec<String>,
    /// Optional `Authorization` header value sent verbatim (raw string — for
    /// feeds that take a key rather than a URL-embedded user:pass) on the
    /// private-feed WSS connect. Use `${VAR}` for the secret.
    #[serde(default)]
    pub private_mempool_auth: Option<String>,
}
