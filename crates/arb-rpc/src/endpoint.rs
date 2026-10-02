use std::sync::Mutex;
use std::time::{Duration, Instant};

use alloy::providers::{Provider, ProviderBuilder};
use alloy::transports::{RpcError, TransportErrorKind};
use alloy_primitives::{Address, Bytes, U256};
use anyhow::Result;
use tracing::{debug, info, warn};

type HttpProvider = alloy::providers::fillers::FillProvider<
    alloy::providers::fillers::JoinFill<
        alloy::providers::Identity,
        alloy::providers::fillers::JoinFill<
            alloy::providers::fillers::GasFiller,
            alloy::providers::fillers::JoinFill<
                alloy::providers::fillers::BlobGasFiller,
                alloy::providers::fillers::JoinFill<
                    alloy::providers::fillers::NonceFiller,
                    alloy::providers::fillers::ChainIdFiller,
                >,
            >,
        >,
    >,
    alloy::providers::RootProvider,
>;

/// Seconds an endpoint is benched after a transport failure (429/timeout/conn).
const BLACKLIST_SECS: u64 = 60;

struct PoolState {
    /// Per-endpoint: instant until which it is blacklisted.
    blacklist_until: Vec<Option<Instant>>,
    /// Round-robin cursor for read distribution.
    rr_cursor: usize,
}

impl PoolState {
    /// Pick the next non-blacklisted index; falls back to the cursor if all are benched.
    fn pick(&mut self, n: usize) -> usize {
        let now = Instant::now();
        for off in 0..n {
            let idx = (self.rr_cursor + off) % n;
            if self.blacklist_until[idx].is_none_or(|t| t <= now) {
                self.rr_cursor = (idx + 1) % n;
                return idx;
            }
        }
        let idx = self.rr_cursor % n;
        self.rr_cursor = (idx + 1) % n;
        idx
    }
}

/// True when a JSON-RPC error is a transport failure (429, timeout, conn refused)
/// worth benching the endpoint for — as opposed to a valid RPC-level response
/// (execution revert, bad params) which says nothing about endpoint health.
pub fn is_transport_error<E>(e: &RpcError<TransportErrorKind, E>) -> bool {
    matches!(e, RpcError::Transport(_))
}

/// Same check for errors returned by `sol!` contract calls (e.g. StateReader).
pub fn is_contract_transport_error(e: &alloy::contract::Error) -> bool {
    matches!(
        e,
        alloy::contract::Error::TransportError(RpcError::Transport(_))
    )
}

pub struct Endpoint {
    read_urls: Vec<String>,
    wss_url: String,
    /// Free/public endpoints for ALL reads — round-robin, 60s blacklist on transport errors.
    read_pool: Vec<HttpProvider>,
    pool_state: Mutex<PoolState>,
    /// Optional Trader/Warp endpoint ONLY for eth_sendRawTransaction.
    /// Falls back to read_pool if not set.
    trader_provider: Option<HttpProvider>,
    #[allow(dead_code)]
    trader_url: Option<String>,
    chain_id: u64,
    /// Cached nonce: None = cold start (needs RPC fetch).
    /// Incremented locally after each submit to avoid rapid-fire nonce collisions.
    nonce_cache: Mutex<Option<u64>>,
}

impl Endpoint {
    /// Single-endpoint constructor (backwards compatible).
    pub async fn new(
        http_url: &str,
        wss_url: &str,
        trader_url: Option<&str>,
        chain_id: u64,
    ) -> Result<Self> {
        Self::new_pooled(&[http_url], wss_url, trader_url, chain_id).await
    }

    /// Pooled constructor: connects to every URL, validates chain id on each that
    /// answers, benches the rest. Bails only if no endpoint is usable.
    pub async fn new_pooled(
        read_urls: &[&str],
        wss_url: &str,
        trader_url: Option<&str>,
        chain_id: u64,
    ) -> Result<Self> {
        let n = read_urls.len().max(1);
        let mut read_pool = Vec::with_capacity(n);
        let mut blacklist = Vec::with_capacity(n);
        let mut kept_urls = Vec::with_capacity(n);

        // Parallel handshake probe — sequential probing stalls startup for big pools.
        let probes: Vec<_> = read_urls
            .iter()
            .map(|url| {
                let url = url.to_string();
                async move {
                    match url.parse() {
                        Ok(parsed) => {
                            let provider = ProviderBuilder::new().connect_http(parsed);
                            let result = tokio::time::timeout(
                                Duration::from_secs(5),
                                provider.get_chain_id(),
                            )
                            .await;
                            (url, Some(provider), result.ok().and_then(|r| r.ok()))
                        }
                        Err(_) => (url, None, None),
                    }
                }
            })
            .collect();
        for (url, provider, detected) in futures::future::join_all(probes).await {
            match detected {
                Some(d) if d == chain_id => {
                    read_pool.push(provider.unwrap());
                    blacklist.push(None);
                    kept_urls.push(url);
                }
                Some(d) => warn!(endpoint = %url, expected = chain_id, got = d, "Read endpoint dropped: chain id mismatch"),
                None => warn!(endpoint = %url, "Read endpoint unreachable at startup — skipped"),
            }
        }

        if read_pool.is_empty() {
            anyhow::bail!("No usable read endpoint for chain {chain_id}");
        }
        info!(chain_id, pool_size = read_pool.len(), "RPC read pool ready");

        let trader_provider = if let Some(turl) = trader_url {
            if turl.is_empty() {
                info!("No trader endpoint configured, will use read endpoint for tx submission");
                None
            } else {
                let tp = ProviderBuilder::new()
                    .connect_http(turl.parse()?);
                let trader_chain = tp.get_chain_id().await?;
                if trader_chain != chain_id {
                    anyhow::bail!(
                        "Chain ID mismatch on trader endpoint: expected {chain_id}, got {trader_chain}"
                    );
                }
                info!(chain_id, endpoint = turl, "Trader endpoint connected (tx submission only)");
                Some(tp)
            }
        } else {
            info!("No trader endpoint configured, will use read endpoint for tx submission");
            None
        };

        Ok(Self {
            read_urls: kept_urls,
            wss_url: wss_url.to_string(),
            read_pool,
            pool_state: Mutex::new(PoolState {
                blacklist_until: blacklist,
                rr_cursor: 0,
            }),
            trader_provider,
            trader_url: trader_url.map(String::from),
            chain_id,
            nonce_cache: Mutex::new(None),
        })
    }

    fn pick_index(&self) -> usize {
        self.pool_state.lock().unwrap().pick(self.read_pool.len())
    }

    /// Currently-healthy read provider (round-robin across the pool).
    /// Cheap: each call is an O(pool) cursor check — provider is a cheap clone.
    pub fn provider(&self) -> HttpProvider {
        self.read_pool[self.pick_index()].clone()
    }

    /// Pick a provider and return its pool index so the caller can report a
    /// transport failure back via `blacklist_read` and re-pick for a retry.
    pub fn pool_pick(&self) -> (usize, HttpProvider) {
        let idx = self.pick_index();
        (idx, self.read_pool[idx].clone())
    }

    /// Bench a read endpoint for 60s after a transport failure (429/timeout).
    /// Failover is just a provider swap — sub-millisecond, no paused cycle.
    pub fn blacklist_read(&self, idx: usize) {
        let mut s = self.pool_state.lock().unwrap();
        let now = Instant::now();
        if s.blacklist_until[idx].is_none_or(|t| t <= now) {
            s.blacklist_until[idx] = Some(now + Duration::from_secs(BLACKLIST_SECS));
            warn!(
                chain_id = self.chain_id,
                endpoint = %self.read_urls[idx],
                "RPC read endpoint blacklisted for {BLACKLIST_SECS}s (transport failure)"
            );
        }
    }

    pub fn read_pool_size(&self) -> usize {
        self.read_pool.len()
    }

    pub fn http_url(&self) -> &str {
        &self.read_urls[0]
    }

    pub fn wss_url(&self) -> &str {
        &self.wss_url
    }

    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    pub fn has_trader_endpoint(&self) -> bool {
        self.trader_provider.is_some()
    }

    /// Run `f` against the read pool with failover: on transport error the
    /// endpoint is blacklisted for 60s and `f` is retried on the next one,
    /// without pausing execution. RPC-level errors (reverts) return immediately.
    async fn with_failover<T, E, F, Fut>(&self, mut f: F) -> Result<T, RpcError<TransportErrorKind, E>>
    where
        F: FnMut(HttpProvider) -> Fut,
        Fut: std::future::Future<Output = Result<T, RpcError<TransportErrorKind, E>>>,
    {
        let attempts = self.read_pool.len();
        let mut last_err = None;
        for _ in 0..attempts {
            let (idx, provider) = self.pool_pick();
            match f(provider).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    if is_transport_error(&e) {
                        self.blacklist_read(idx);
                        last_err = Some(e);
                        continue;
                    }
                    return Err(e);
                }
            }
        }
        Err(last_err.expect("at least one attempt was made"))
    }

    /// eth_call against the read pool. Used for state refresh, simulations, etc.
    pub async fn eth_call_timed(
        &self,
        to: Address,
        data: Bytes,
    ) -> Result<(Bytes, Duration)> {
        let start = Instant::now();

        let data2 = data.clone();
        let result = self
            .with_failover(|provider| {
                let data = data2.clone();
                async move {
                    let tx = alloy::rpc::types::TransactionRequest::default()
                        .to(to)
                        .input(data.into());
                    provider.call(tx).await
                }
            })
            .await?;
        let elapsed = start.elapsed();

        debug!(
            chain_id = self.chain_id,
            latency_ms = elapsed.as_millis(),
            "eth_call completed (read endpoint)"
        );

        Ok((result, elapsed))
    }

    /// Block number from the read pool.
    pub async fn block_number(&self) -> Result<u64> {
        Ok(self.with_failover(|p| async move { p.get_block_number().await }).await?)
    }

    /// Nonce: returns cached value if warm, otherwise fetches from chain.
    /// Call `bump_nonce()` after each successful submit to keep the cache ahead.
    pub async fn get_nonce(&self, address: Address) -> Result<u64> {
        {
            let guard = self.nonce_cache.lock().unwrap();
            if let Some(n) = *guard {
                return Ok(n);
            }
        }
        let chain_nonce = self
            .with_failover(|p| async move { p.get_transaction_count(address).await })
            .await?;
        let mut guard = self.nonce_cache.lock().unwrap();
        *guard = Some(chain_nonce);
        debug!(chain_id = self.chain_id, nonce = chain_nonce, "Nonce fetched from chain (cold start)");
        Ok(chain_nonce)
    }

    /// Increment the cached nonce after a successful submit.
    pub fn bump_nonce(&self) {
        let mut guard = self.nonce_cache.lock().unwrap();
        if let Some(ref mut n) = *guard {
            *n += 1;
        }
    }

    /// Force-refresh nonce from chain (e.g. after a "nonce too low" error).
    pub async fn refresh_nonce(&self, address: Address) -> Result<u64> {
        let chain_nonce = self
            .with_failover(|p| async move { p.get_transaction_count(address).await })
            .await?;
        let mut guard = self.nonce_cache.lock().unwrap();
        let old = *guard;
        *guard = Some(chain_nonce);
        warn!(
            chain_id = self.chain_id,
            old_nonce = ?old,
            new_nonce = chain_nonce,
            "Nonce refreshed from chain"
        );
        Ok(chain_nonce)
    }

    /// Gas price from the read pool.
    pub async fn gas_price(&self) -> Result<u128> {
        Ok(self.with_failover(|p| async move { p.get_gas_price().await }).await?)
    }

    /// Get transaction receipt from the read pool.
    pub async fn get_receipt(&self, tx_hash: alloy_primitives::B256) -> Result<Option<alloy::rpc::types::TransactionReceipt>> {
        Ok(self
            .with_failover(|p| async move { p.get_transaction_receipt(tx_hash).await })
            .await?)
    }

    /// Get native balance from the read pool.
    pub async fn get_balance(&self, address: Address) -> Result<U256> {
        Ok(self.with_failover(|p| async move { p.get_balance(address).await }).await?)
    }

    /// Send raw transaction via the TRADER endpoint (costs $0.15/call on Chainstack Trader).
    /// Falls back to the read pool only if no trader is configured.
    ///
    /// IMPORTANT: Only call this from `WarpSubmitter`. Every call to this function
    /// that reaches a real Trader endpoint costs $0.15 — this is tracked in metrics.
    /// Use `send_raw_tx_free()` for all other submission venues.
    pub async fn send_raw_tx(&self, raw_tx: Bytes) -> Result<alloy_primitives::B256> {
        let start = Instant::now();
        let pending = match &self.trader_provider {
            Some(trader) => trader.send_raw_transaction(&raw_tx).await?,
            None => {
                self.with_failover(|p| {
                    let raw_tx = raw_tx.clone();
                    async move { p.send_raw_transaction(&raw_tx).await }
                })
                .await?
            }
        };
        let elapsed = start.elapsed();

        if self.trader_provider.is_some() {
            warn!(
                chain_id = self.chain_id,
                latency_ms = elapsed.as_millis(),
                tx_hash = %pending.tx_hash(),
                "PAID Warp tx sent ($0.15)"
            );
        } else {
            info!(
                chain_id = self.chain_id,
                endpoint = "read-pool",
                latency_ms = elapsed.as_millis(),
                tx_hash = %pending.tx_hash(),
                "Transaction sent"
            );
        }

        Ok(*pending.tx_hash())
    }

    /// Send raw transaction via the read pool ONLY.
    /// Never touches the Trader endpoint regardless of configuration.
    /// Use this for DirectSubmitter and any other "free" venue.
    pub async fn send_raw_tx_free(&self, raw_tx: Bytes) -> Result<alloy_primitives::B256> {
        let start = Instant::now();
        let pending = self
            .with_failover(|p| {
                let raw_tx = raw_tx.clone();
                async move { p.send_raw_transaction(&raw_tx).await }
            })
            .await?;
        let elapsed = start.elapsed();

        info!(
            chain_id = self.chain_id,
            endpoint = "read-pool",
            latency_ms = elapsed.as_millis(),
            tx_hash = %pending.tx_hash(),
            "Transaction sent (free endpoint)"
        );

        Ok(*pending.tx_hash())
    }
}
