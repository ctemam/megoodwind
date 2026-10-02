use std::collections::HashSet;
use std::time::Duration;

use alloy_primitives::Address;
use tracing::{info, warn};

/// GoPlus Token Security API — free public endpoint, no key.
const GOPLUS_URL: &str = "https://api.gopluslabs.io/api/v1/token_security";
const BATCH_SIZE: usize = 100;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Reject transfer taxes above 10% — arb math can't price hidden
/// transfer-fee drag on the leg.
const MAX_TAX: f64 = 0.10;

/// Returns the set of tokens GoPlus flags as unsafe to route through:
/// honeypots, sell-blocked contracts, or heavy transfer taxes.
/// Fail-open: if the API is unreachable, nothing is blocked (the pool
/// graph must not die on a third-party metadata outage).
pub async fn screen_tokens(chain_id: u64, tokens: &HashSet<Address>) -> HashSet<Address> {
    if tokens.is_empty() {
        return HashSet::new();
    }
    let client = reqwest::Client::new();
    let mut blocked = HashSet::new();
    let addrs: Vec<Address> = tokens.iter().copied().collect();

    for chunk in addrs.chunks(BATCH_SIZE) {
        let joined = chunk
            .iter()
            .map(|a| format!("{a:?}"))
            .collect::<Vec<_>>()
            .join(",");
        let url = format!("{GOPLUS_URL}/{chain_id}?contract_addresses={joined}");
        let body: serde_json::Value = match tokio::time::timeout(
            REQUEST_TIMEOUT,
            client.get(&url).send(),
        )
        .await
        {
            Ok(Ok(resp)) => match resp.json().await {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = %e, "GoPlus response undecodable — screen skipped");
                    return HashSet::new();
                }
            },
            Ok(Err(e)) => {
                warn!(error = %e, "GoPlus unreachable — screen skipped (fail-open)");
                return HashSet::new();
            }
            Err(_) => {
                warn!("GoPlus timed out — screen skipped (fail-open)");
                return HashSet::new();
            }
        };

        let Some(results) = body["result"].as_object() else {
            continue;
        };
        for (addr, info) in results {
            if is_dangerous(info) {
                if let Ok(a) = addr.parse::<Address>() {
                    blocked.insert(a);
                }
            }
        }
    }

    if !blocked.is_empty() {
        info!(blocked = blocked.len(), "GoPlus flagged dangerous tokens");
    }
    blocked
}

/// Dangerous vectors per GoPlus field semantics:
/// - `is_honeypot` / `cannot_sell_all`: tokens that trap buys — lethal to
///   any arb leg that must sell.
/// - `sell_tax`/`buy_tax` > MAX_TAX: hidden transfer-fee drag the AMM math
///   does not model.
fn is_dangerous(info: &serde_json::Value) -> bool {
    fn flag(v: &serde_json::Value, k: &str) -> bool {
        v[k].as_str() == Some("1")
    }
    if flag(info, "is_honeypot") || flag(info, "cannot_sell_all") {
        return true;
    }
    let tax = |k: &str| {
        info[k]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .or_else(|| info[k].as_f64())
            .unwrap_or(0.0)
    };
    tax("sell_tax") > MAX_TAX || tax("buy_tax") > MAX_TAX
}
