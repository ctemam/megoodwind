use std::collections::HashMap;
use std::time::Duration;

use alloy_primitives::Address;
use tracing::{debug, info, warn};

/// Canonical token-list sources per chain (Uniswap Token Lists spec:
/// JSON-schema `tokens[]` entries with chainId, address, symbol, decimals).
/// Base uses the Superchain list (covers chainId 8453); BSC uses the
/// PancakeSwap extended list.
fn list_url(chain_id: u64) -> Option<&'static str> {
    match chain_id {
        8453 => Some("https://static.optimism.io/optimism.tokenlist.json"),
        56 => Some("https://tokens.pancakeswap.finance/pancakeswap-extended.json"),
        _ => None,
    }
}

/// (symbol → address, address → decimals) for tokens on this chain.
pub struct CanonicalRegistry {
    pub by_symbol: HashMap<String, Address>,
    pub decimals: HashMap<Address, u32>,
}

/// Fetch the chain's canonical token list. Fail-open: on any fetch/parse
/// error we keep local config (lists are metadata, not liveness).
pub async fn fetch_registry(chain_id: u64) -> Option<CanonicalRegistry> {
    let url = list_url(chain_id)?;
    let body: serde_json::Value = match tokio::time::timeout(
        Duration::from_secs(10),
        reqwest::Client::new().get(url).send(),
    )
    .await
    {
        Ok(Ok(resp)) => resp.json().await.ok()?,
        Ok(Err(e)) => {
            warn!(error = %e, url, "Token list fetch failed — using local config");
            return None;
        }
        Err(_) => {
            warn!(url, "Token list fetch timed out — using local config");
            return None;
        }
    };

    let mut by_symbol = HashMap::new();
    let mut decimals = HashMap::new();
    for t in body["tokens"].as_array().into_iter().flatten() {
        if t["chainId"].as_u64() != Some(chain_id) {
            continue;
        }
        let (Ok(addr), Some(sym)) = (
            t["address"].as_str().unwrap_or("").parse::<Address>(),
            t["symbol"].as_str(),
        ) else {
            continue;
        };
        by_symbol.entry(sym.to_string()).or_insert(addr);
        if let Some(d) = t["decimals"].as_u64() {
            decimals.insert(addr, d as u32);
        }
    }
    info!(tokens = by_symbol.len(), chain_id, "Canonical token list loaded");
    Some(CanonicalRegistry { by_symbol, decimals })
}

/// Cross-check local `[tokens]` config against the canonical list:
/// warn on symbol→address mismatches and fix decimals where the local
/// hardcoded guess disagrees with canonical metadata.
pub fn reconcile(
    registry: &CanonicalRegistry,
    local: &HashMap<String, Address>,
    token_decimals: &mut HashMap<Address, u32>,
) {
    for (sym, &local_addr) in local {
        match registry.by_symbol.get(sym) {
            Some(&canon) if canon != local_addr => warn!(
                symbol = %sym,
                local = ?local_addr,
                canonical = ?canon,
                "Token address mismatch vs canonical list"
            ),
            Some(&canon) => {
                if let Some(&d) = registry.decimals.get(&canon) {
                    if token_decimals.get(&canon) != Some(&d) {
                        debug!(symbol = %sym, decimals = d, "Correcting decimals from canonical list");
                        token_decimals.insert(canon, d);
                    }
                }
            }
            None => {}
        }
    }
}
