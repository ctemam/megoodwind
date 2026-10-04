use alloy::consensus::Transaction as TxTrait;
use alloy::eips::Encodable2718;
use alloy::network::TransactionResponse;
use alloy::providers::{Provider, ProviderBuilder, WsConnect};
use alloy_primitives::Address;
use anyhow::Result;
use futures::StreamExt;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::decoder::{DecodedSwap, TxDecoder};
use std::time::{Duration, Instant};

/// Spec: backpressure/decode latency above this drops the provider instantly.
const MAX_PROCESSING: Duration = Duration::from_millis(5);
/// Connect/subscribe budget per WSS candidate before cycling to the next.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// Rolling telemetry sample window (fixed buffer, no per-event alloc).
const WINDOW: usize = 4096;

/// One pending-transaction WSS source: a public node endpoint or a private
/// orderflow feed (bloXroute BDN, Eden, proprietary relays). `auth` is the
/// raw Authorization header value for feeds that take a key rather than a
/// URL-embedded user:pass.
#[derive(Debug, Clone)]
pub struct WssSource {
    pub url: String,
    pub auth: Option<String>,
}

impl WssSource {
    pub fn public(url: String) -> Self {
        Self { url, auth: None }
    }

    /// Log-safe form of the URL — `wss://user:pass@host` prints credentials
    /// raw, so userinfo is redacted before the string reaches any log line.
    pub fn label(&self) -> String {
        sanitize_url(&self.url)
    }
}

/// Strip URL userinfo (`scheme://user:pass@host/path` → `scheme://host/path`)
/// for log output; anything unparseable falls back to a fixed redaction.
fn sanitize_url(url: &str) -> String {
    let Some(rest) = url.split_once("://").map(|(s, r)| (s, r)) else {
        return "<redacted>".to_string();
    };
    let (scheme, rest) = rest;
    let host_start = match rest.find('@') {
        Some(at) if rest[..at].find('/').is_none() => at + 1,
        _ => 0,
    };
    format!("{}://{}", scheme, &rest[host_start..])
}

#[cfg(test)]
mod tests {
    use super::sanitize_url;

    #[test]
    fn sanitize_redacts_userinfo() {
        assert_eq!(
            sanitize_url("wss://user:secret@example.com/ws"),
            "wss://example.com/ws"
        );
        assert_eq!(
            sanitize_url("wss://example.com/ws"),
            "wss://example.com/ws"
        );
        assert_eq!(sanitize_url("wss://u:p@a.b/x@y"), "wss://a.b/x@y");
        assert_eq!(sanitize_url("garbage"), "<redacted>");
    }
}

#[derive(Debug, Clone)]
pub struct PendingSwap {
    pub tx_hash: alloy_primitives::B256,
    pub from: Address,
    pub to: Address,
    pub value: alloy_primitives::U256,
    pub decoded: DecodedSwap,
    pub raw_input: Vec<u8>,
    /// Full signed EIP-2718 bytes of the victim transaction — builders need
    /// this to order our backrun immediately after it in the same block.
    pub raw_tx: Vec<u8>,
    /// WSS arrival timestamp — measures end-to-end detection→submit latency.
    pub seen_at: Instant,
}

pub struct MempoolWatcher {
    /// Candidate WSS sources (public + private feeds), cycled on failure
    /// or sustained backpressure.
    sources: Vec<WssSource>,
    chain_id: u64,
    decoder: TxDecoder,
}

impl MempoolWatcher {
    pub fn new(wss_urls: &[String], chain_id: u64) -> Self {
        Self::with_sources(
            wss_urls.iter().cloned().map(WssSource::public).collect(),
            chain_id,
        )
    }

    /// Mixed-source watcher: public endpoints plus private-orderflow feeds
    /// carrying their own auth headers ([chain] private_mempool_wss /
    /// private_mempool_auth).
    pub fn with_sources(sources: Vec<WssSource>, chain_id: u64) -> Self {
        Self {
            sources,
            chain_id,
            decoder: TxDecoder::new(),
        }
    }

    /// Stream pending txs forever, cycling providers on failure/backpressure.
    /// Never returns under normal operation — caller supervises via task abort.
    pub async fn start(self, tx: mpsc::Sender<PendingSwap>) -> Result<()> {
        let mut events: u64 = 0;
        let mut dropped: u64 = 0;
        let mut samples = [0u64; WINDOW]; // processing micros ring buffer
        let mut wi = 0usize;
        let mut provider_idx = 0usize;

        loop {
            let src = &self.sources[provider_idx % self.sources.len()];
            provider_idx = provider_idx.wrapping_add(1);
            let url = src.label();
            info!(url = %url, chain_id = self.chain_id, "Connecting to mempool WSS");

            let (_provider, stream) =
                match tokio::time::timeout(CONNECT_TIMEOUT, Self::connect(src)).await {
                    Ok(Ok(pair)) => pair,
                    Ok(Err(e)) => {
                        warn!(url = %url, error = %e, "WSS subscribe failed — cycling provider");
                        continue;
                    }
                    Err(_) => {
                        warn!(url = %url, "WSS connect timed out — cycling provider");
                        continue;
                    }
                };
            // `_provider` keeps alloy's pubsub frontend task alive for the
            // duration of this connection — dropping it ends the stream.
            futures::pin_mut!(stream);

            let mut provider_events: u64 = 0;
            while let Some(pending_tx) = stream.next().await {
                let arrival = Instant::now();
                let to_addr = match pending_tx.to() {
                    Some(addr) => addr,
                    None => continue,
                };
                let input = pending_tx.input();
                if input.len() < 4 {
                    continue;
                }
                let Some(decoded) = self.decoder.decode(to_addr, pending_tx.value(), input) else {
                    continue;
                };
                let swap = PendingSwap {
                    tx_hash: pending_tx.tx_hash(),
                    from: pending_tx.from(),
                    to: to_addr,
                    value: pending_tx.value(),
                    decoded,
                    raw_input: input.to_vec(),
                    raw_tx: pending_tx.inner.encoded_2718(),
                    seen_at: arrival,
                };

                // Bounded send: queue pressure >5ms = backpressure → cycle provider.
                match tokio::time::timeout(MAX_PROCESSING, tx.send(swap)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => {
                        warn!("Mempool channel closed, stopping watcher");
                        return Ok(());
                    }
                    Err(_) => {
                        dropped += 1;
                        warn!(
                            url = %url, dropped,
                            "Backpressure >5ms on mempool queue — cycling provider"
                        );
                        break;
                    }
                }

                let micros = arrival.elapsed().as_micros() as u64;
                samples[wi % WINDOW] = micros;
                wi += 1;
                events += 1;
                provider_events += 1;
                if micros > MAX_PROCESSING.as_micros() as u64 {
                    warn!(url = %url, micros, "Ingest latency above 5ms budget");
                }
                debug!(micros, "mempool ingest latency");

                // Rolling telemetry every 500 events (no alloc — ring buffer).
                if events % 500 == 0 {
                    let n = wi.min(WINDOW);
                    let mut sorted: std::vec::Vec<u64> =
                        samples[..n].to_vec();
                    sorted.sort_unstable();
                    let p50 = sorted[n / 2];
                    let p99 = sorted[n * 99 / 100];
                    info!(
                        url = %url,
                        events,
                        provider_events,
                        p50_us = p50,
                        p99_us = p99,
                        "Mempool ingest telemetry"
                    );
                }
            }
            warn!(url = %url, "Mempool stream ended — cycling provider");
            // Throttle reconnects when a provider yields nothing — avoids
            // hammering rate-limited endpoints in a tight loop.
            if provider_events == 0 {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }

    /// Connect + subscribe; returns the provider as a keep-alive guard —
    /// dropping it tears down the pubsub frontend and ends the stream.
    async fn connect(
        src: &WssSource,
    ) -> Result<(
        impl Provider + 'static,
        impl futures::Stream<Item = alloy::rpc::types::Transaction>,
    )> {
        let ws = WsConnect::new(src.url.clone())
            .with_auth_opt(src.auth.clone().map(alloy::transports::Authorization::Raw));
        let provider = ProviderBuilder::new().connect_ws(ws).await?;
        let sub = provider.subscribe_full_pending_transactions().await?;
        Ok((provider, sub.into_stream()))
    }
}
