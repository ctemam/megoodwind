use std::collections::HashMap;

use alloy_primitives::{Address, U256};

use arb_core::types::Protocol;
use arb_paths::PathTemplate;

use crate::SimResult;

#[derive(Debug, Clone)]
pub struct Decision {
    pub accept: bool,
    pub effective_profit_usd: f64,
    pub reject_reason: Option<&'static str>,
}

pub struct ProfitGate {
    pub min_profit_bps: u32,
    pub min_profit_usd: f64,
    pub safety_margin_bps: u32,
    pub stable_pool_extra_margin_bps: u32,
    /// Per-protocol extra margins (per-(chain,DEX) calibration point).
    /// The largest margin across a path's hops is added to safety_margin_bps.
    /// stable_pool_extra_margin_bps is applied as the PancakeStable entry
    /// unless the map supplies an explicit PancakeStable value.
    pub protocol_margins: HashMap<Protocol, u32>,
    pub token_usd_prices: HashMap<Address, f64>,
    pub token_decimals: HashMap<Address, u32>,
    /// USD cost of one execution tx's gas (gas_price * est_tx_gas *
    /// native_price), set from the runner each block. The min_profit_usd
    /// floor applies to profit NET of this cost — gross sim profit
    /// otherwise ignores the tx's own gas, the dominant cost on cheap
    /// chains. 0.0 until the first gas-price read.
    pub tx_gas_cost_usd: f64,
}

impl ProfitGate {
    pub fn new(
        min_profit_bps: u32,
        min_profit_usd: f64,
        safety_margin_bps: u32,
        stable_pool_extra_margin_bps: u32,
        token_usd_prices: HashMap<Address, f64>,
        token_decimals: HashMap<Address, u32>,
    ) -> Self {
        Self::with_protocol_margins(
            min_profit_bps,
            min_profit_usd,
            safety_margin_bps,
            stable_pool_extra_margin_bps,
            HashMap::new(),
            token_usd_prices,
            token_decimals,
        )
    }

    pub fn with_protocol_margins(
        min_profit_bps: u32,
        min_profit_usd: f64,
        safety_margin_bps: u32,
        stable_pool_extra_margin_bps: u32,
        mut protocol_margins: HashMap<Protocol, u32>,
        token_usd_prices: HashMap<Address, f64>,
        token_decimals: HashMap<Address, u32>,
    ) -> Self {
        protocol_margins
            .entry(Protocol::PancakeStable)
            .or_insert(stable_pool_extra_margin_bps);
        Self {
            min_profit_bps,
            min_profit_usd,
            safety_margin_bps,
            stable_pool_extra_margin_bps,
            protocol_margins,
            token_usd_prices,
            token_decimals,
            tx_gas_cost_usd: 0.0,
        }
    }

    /// Update the per-execution gas cost used for the net-profit floor.
    /// Guards non-finite/non-positive input (a bad gas-price read must not
    /// poison the gate with NaN).
    pub fn set_gas_cost_usd(&mut self, usd: f64) {
        if usd.is_finite() && usd > 0.0 {
            self.tx_gas_cost_usd = usd;
        }
    }

    pub fn should_submit(&self, result: &SimResult, path: &PathTemplate) -> Decision {
        // Data-corruption guard: no legitimate cross-pool arb shows
        // 1,000%+ — beyond this the pool state is corrupt (e.g. swapped
        // token order, dead pool), and submitting would burn a sponsor call.
        const MAX_PLAUSIBLE_BPS: u32 = 100_000;
        if result.profit_bps > MAX_PLAUSIBLE_BPS {
            return Decision {
                accept: false,
                effective_profit_usd: 0.0,
                reject_reason: Some("implausible"),
            };
        }

        if result.profit_bps < self.min_profit_bps {
            return Decision {
                accept: false,
                effective_profit_usd: 0.0,
                reject_reason: Some("below_min_bps"),
            };
        }

        // Extra margin for protocols with approximate off-chain math.
        // PancakeStable (Curve-style) has complex Newton iteration that may differ from on-chain.
        // AerodromeV2 volatile pools are wei-exact (validated). Aerodrome stable pools are also
        // wei-exact after the _f/_d/_get_y fix. Per-protocol margins come from
        // config; the least-exact hop sets the margin (max, not sum).
        let protocol_extra = path
            .hops
            .iter()
            .filter_map(|h| self.protocol_margins.get(&h.protocol))
            .copied()
            .max()
            .unwrap_or(0);

        let total_margin = self.safety_margin_bps + protocol_extra;

        if result.profit_bps <= total_margin {
            return Decision {
                accept: false,
                effective_profit_usd: 0.0,
                reject_reason: Some("below_safety_margin"),
            };
        }

        let effective_bps = result.profit_bps - total_margin;

        // Convert gross profit to USD
        let token_price = self
            .token_usd_prices
            .get(&result.flash_token)
            .copied()
            .unwrap_or(1.0);

        let decimals = self.token_decimals
            .get(&result.flash_token)
            .copied()
            .unwrap_or_else(|| {
                if result.flash_amount >= U256::from(1_000_000_000_000u64) { 18 } else { 6 }
            });
        let decimals_factor = 10f64.powi(decimals as i32);

        let gross_profit_f64: f64 = result
            .gross_profit
            .try_into()
            .map(|v: u128| v as f64 / decimals_factor)
            .unwrap_or(f64::MAX);

        let profit_usd = gross_profit_f64 * token_price;
        let effective_profit_usd =
            profit_usd * (effective_bps as f64 / result.profit_bps as f64);

        // Net the execution tx's own gas cost out of the floor — a path
        // that sims +$0.60 gross but pays $0.55 gas loses money live.
        let net_profit_usd = effective_profit_usd - self.tx_gas_cost_usd;

        if net_profit_usd < self.min_profit_usd {
            return Decision {
                accept: false,
                effective_profit_usd: net_profit_usd,
                reject_reason: Some(if self.tx_gas_cost_usd > 0.0
                    && effective_profit_usd >= self.min_profit_usd
                {
                    "below_gas_net"
                } else {
                    "below_min_usd"
                }),
            };
        }

        Decision {
            accept: true,
            effective_profit_usd: net_profit_usd,
            reject_reason: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, U256};
    use arb_paths::{HopTemplate, PathTemplate};

    fn make_gate(
        min_bps: u32,
        min_usd: f64,
        safety_bps: u32,
        stable_extra_bps: u32,
        prices: Vec<(Address, f64)>,
        decimals: Vec<(Address, u32)>,
    ) -> ProfitGate {
        ProfitGate::new(
            min_bps,
            min_usd,
            safety_bps,
            stable_extra_bps,
            prices.into_iter().collect(),
            decimals.into_iter().collect(),
        )
    }

    fn make_result(flash_token: Address, flash_amount: U256, gross_profit: U256, profit_bps: u32) -> SimResult {
        SimResult {
            path_id: 1,
            flash_token,
            flash_amount,
            final_amount: flash_amount + gross_profit,
            gross_profit,
            profit_bps,
        }
    }

    fn simple_path(protocol: Protocol) -> PathTemplate {
        let token_a = address!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let token_b = address!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        PathTemplate {
            id: 1,
            flash_token: token_a,
            flash_amount: U256::from(1_000_000_000_000_000_000u64),
            hops: vec![
                HopTemplate {
                    protocol,
                    pool: address!("1111111111111111111111111111111111111111"),
                    token_in: token_a,
                    token_out: token_b,
                },
                HopTemplate {
                    protocol: Protocol::UniswapV2,
                    pool: address!("2222222222222222222222222222222222222222"),
                    token_in: token_b,
                    token_out: token_a,
                },
            ],
        }
    }

    #[test]
    fn test_explicit_decimals_used() {
        let token = address!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let gate = make_gate(0, 0.0, 0, 0, vec![(token, 1.0)], vec![(token, 18)]);
        let profit = U256::from(1_000_000_000_000_000_000u64);
        let result = make_result(token, U256::from(100_000_000_000_000_000_000u128), profit, 100);
        let path = simple_path(Protocol::UniswapV2);
        let decision = gate.should_submit(&result, &path);
        assert!(decision.accept);
        let expected_usd = 1.0;
        assert!((decision.effective_profit_usd - expected_usd).abs() < 0.001);
    }

    #[test]
    fn test_fallback_heuristic_large_amount() {
        let token = address!("cccccccccccccccccccccccccccccccccccccccc");
        let gate = make_gate(0, 0.0, 0, 0, vec![(token, 1.0)], vec![]);
        let flash = U256::from(10_000_000_000_000_000u64);
        let profit = U256::from(1_000_000_000_000_000_000u64);
        let result = make_result(token, flash, profit, 100);
        let path = simple_path(Protocol::UniswapV2);
        let decision = gate.should_submit(&result, &path);
        assert!(decision.accept);
        let expected_usd = 1.0;
        assert!((decision.effective_profit_usd - expected_usd).abs() < 0.001);
    }

    #[test]
    fn test_fallback_heuristic_small_amount() {
        let token = address!("cccccccccccccccccccccccccccccccccccccccc");
        let gate = make_gate(0, 0.0, 0, 0, vec![(token, 1.0)], vec![]);
        let flash = U256::from(500_000u64);
        let profit = U256::from(1_000_000u64);
        let result = make_result(token, flash, profit, 100);
        let path = simple_path(Protocol::UniswapV2);
        let decision = gate.should_submit(&result, &path);
        assert!(decision.accept);
        let expected_usd = 1.0;
        assert!((decision.effective_profit_usd - expected_usd).abs() < 0.001);
    }

    #[test]
    fn test_below_min_bps_rejected() {
        let token = address!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let gate = make_gate(50, 0.0, 0, 0, vec![(token, 1.0)], vec![(token, 18)]);
        let result = make_result(token, U256::from(1_000_000_000_000_000_000u64), U256::from(1u64), 30);
        let path = simple_path(Protocol::UniswapV2);
        let decision = gate.should_submit(&result, &path);
        assert!(!decision.accept);
        assert_eq!(decision.reject_reason, Some("below_min_bps"));
    }

    #[test]
    fn test_below_safety_margin_rejected() {
        let token = address!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let gate = make_gate(10, 0.0, 20, 0, vec![(token, 1.0)], vec![(token, 18)]);
        let result = make_result(token, U256::from(1_000_000_000_000_000_000u64), U256::from(1u64), 20);
        let path = simple_path(Protocol::UniswapV2);
        let decision = gate.should_submit(&result, &path);
        assert!(!decision.accept);
        assert_eq!(decision.reject_reason, Some("below_safety_margin"));
    }

    #[test]
    fn test_above_min_usd_accepted() {
        let token = address!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let gate = make_gate(10, 0.50, 5, 0, vec![(token, 300.0)], vec![(token, 18)]);
        let profit = U256::from(10_000_000_000_000_000u64);
        let result = make_result(token, U256::from(1_000_000_000_000_000_000u64), profit, 100);
        let path = simple_path(Protocol::UniswapV2);
        let decision = gate.should_submit(&result, &path);
        assert!(decision.accept);
        assert!(decision.effective_profit_usd > 0.50);
    }

    #[test]
    fn test_stable_pool_extra_margin() {
        let token = address!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let gate = make_gate(10, 0.0, 5, 30, vec![(token, 1.0)], vec![(token, 18)]);
        let result = make_result(token, U256::from(1_000_000_000_000_000_000u64), U256::from(1u64), 25);
        let path = simple_path(Protocol::PancakeStable);
        let decision = gate.should_submit(&result, &path);
        assert!(!decision.accept);
        assert_eq!(decision.reject_reason, Some("below_safety_margin"));

        let path_no_stable = simple_path(Protocol::UniswapV2);
        let decision2 = gate.should_submit(&result, &path_no_stable);
        assert!(decision2.accept);
    }
}
