use alloy_primitives::U256;
use tracing::trace;

use arb_core::types::*;
use arb_core::AmmQuoter;
use arb_paths::PathTemplate;
use arb_state::PoolStore;

/// Simulate a path at a given flash amount, returning the gross profit (or zero if unprofitable).
/// Cheap single-point profit eval — used to rank backrun candidates before
/// spending full ternary optimization on the most promising routes.
pub fn simulate_profit(path: &PathTemplate, amount: U256, store: &PoolStore) -> U256 {
    let mut current = amount;

    for hop in &path.hops {
        // Zero-copy borrow — cloning pool states here allocates on the heap.
        let pool_state = match store.get_ref(&hop.pool) {
            Some(r) => r,
            None => return U256::ZERO,
        };

        let out = match &*pool_state {
            PoolState::V2(s) => s.quote(hop.token_in, current).unwrap_or(U256::ZERO),
            PoolState::V3(s) => s.quote(hop.token_in, current).unwrap_or(U256::ZERO),
            PoolState::Curve(s) => s.quote(hop.token_in, current).unwrap_or(U256::ZERO),
            PoolState::Wombat(s) => s.quote(hop.token_in, current).unwrap_or(U256::ZERO),
            PoolState::Dodo(s) => s.quote(hop.token_in, current).unwrap_or(U256::ZERO),
            PoolState::AeroV2(s) => s.quote(hop.token_in, current).unwrap_or(U256::ZERO),
        };

        if out.is_zero() {
            return U256::ZERO;
        }
        current = out;
    }

    current.saturating_sub(amount)
}

/// Returns the maximum safe flash amount for a path, capped at `max_pool_pct` of the
/// smallest reserve (token_in side) across all hops. For V3/Slipstream pools where
/// we don't have simple reserves, falls back to `default_max`.
///
/// This prevents the ternary search from exploring amounts so large they'd drain a pool
/// and cause catastrophic slippage.
pub fn path_max_flash(
    path: &PathTemplate,
    store: &PoolStore,
    max_pool_pct: f64,
    default_max: U256,
) -> U256 {
    let mut min_cap = default_max;

    for hop in &path.hops {
        let reserve_in = match store.get_ref(&hop.pool).as_deref() {
            Some(PoolState::V2(s)) => {
                if hop.token_in == s.token0 { s.reserve0 } else { s.reserve1 }
            }
            Some(PoolState::AeroV2(s)) => {
                if hop.token_in == s.token0 { s.reserve0 } else { s.reserve1 }
            }
            Some(PoolState::Dodo(s)) => {
                if hop.token_in == s.base_token { s.base_reserve } else { s.quote_reserve }
            }
            Some(PoolState::V3(s)) => {
                if s.sqrt_price_x96.is_zero() || s.liquidity == 0 {
                    return U256::ZERO;
                }
                let l = U256::from(s.liquidity);
                let q96 = U256::from(1u128 << 96);
                if hop.token_in == s.token0 {
                    // reserve0 ≈ L * Q96 / sqrtPrice
                    l.checked_mul(q96)
                        .and_then(|v| v.checked_div(s.sqrt_price_x96))
                        .unwrap_or(U256::MAX)
                } else {
                    // reserve1 ≈ L * sqrtPrice / Q96
                    l.checked_mul(s.sqrt_price_x96)
                        .and_then(|v| v.checked_div(q96))
                        .unwrap_or(U256::MAX)
                }
            }
            Some(PoolState::Curve(_)) | Some(PoolState::Wombat(_)) | None => continue,
        };

        if reserve_in.is_zero() {
            return U256::ZERO;
        }

        // cap = reserve * max_pool_pct (e.g. 5%)
        // We multiply by 1000 and divide by 1000 to avoid float imprecision
        let pct_1000 = (max_pool_pct * 1000.0) as u64;
        let cap = (reserve_in * U256::from(pct_1000)) / U256::from(1000u32);

        if cap < min_cap {
            min_cap = cap;
        }
    }

    min_cap
}

/// Find the trade amount that maximizes gross profit for a path using ternary search.
///
/// The profit curve is unimodal for AMM arbs: zero at x=0, increases as the spread
/// is captured, peaks at the optimal trade size, then decreases as slippage dominates.
/// Ternary search finds the peak in O(log n) iterations.
///
/// Returns `Some((optimal_amount, max_gross_profit))` if profitable, `None` otherwise.
pub fn find_optimal_amount(
    path: &PathTemplate,
    store: &PoolStore,
    min_amount: U256,
    max_amount: U256,
    iterations: usize,
) -> Option<(U256, U256)> {
    if min_amount >= max_amount {
        return None;
    }

    let mut lo = min_amount;
    let mut hi = max_amount;

    // Track the best actually-observed point: thin edges are profitable only
    // over a narrow amount range, and a converged (lo+hi)/2 landing in a dead
    // region must not discard profit seen at earlier probes.
    let mut best: Option<(U256, U256)> = None;
    let mut record = |amount: U256, profit: U256, best: &mut Option<(U256, U256)>| {
        if !profit.is_zero() && best.map_or(true, |(_, p)| profit > p) {
            *best = Some((amount, profit));
        }
    };
    record(min_amount, simulate_profit(path, min_amount, store), &mut best);
    record(max_amount, simulate_profit(path, max_amount, store), &mut best);

    for _ in 0..iterations {
        if hi - lo <= U256::from(2u32) {
            break;
        }

        let third = (hi - lo) / U256::from(3u32);
        let m1 = lo + third;
        let m2 = hi - third;

        let p1 = simulate_profit(path, m1, store);
        let p2 = simulate_profit(path, m2, store);
        record(m1, p1, &mut best);
        record(m2, p2, &mut best);

        if p1 < p2 {
            lo = m1;
        } else {
            hi = m2;
        }
    }

    let optimal = (lo + hi) / U256::from(2u32);
    record(optimal, simulate_profit(path, optimal, store), &mut best);

    let (optimal, profit) = best?;

    trace!(
        path_id = path.id,
        optimal_amount = %optimal,
        gross_profit = %profit,
        "Optimal amount found"
    );

    Some((optimal, profit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simulate_profit_returns_zero_for_empty_store() {
        let store = PoolStore::new();
        let path = PathTemplate {
            id: 0,
            flash_token: alloy_primitives::Address::ZERO,
            flash_amount: U256::from(1000u32),
            hops: vec![],
        };
        let profit = simulate_profit(&path, U256::from(1000u32), &store);
        assert_eq!(profit, U256::ZERO);
    }

    /// Two V2 pools with inverted prices: profit exists on the A→B→A loop.
    /// The optimizer must return the best point it actually observed — a
    /// converged midpoint landing in a dead region must not return None.
    #[test]
    fn test_optimizer_keeps_best_observed_probe() {
        use alloy_primitives::address;
        use arb_core::types::V2PoolState;
        use arb_paths::HopTemplate;

        let token_a = address!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let token_b = address!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        let pool1 = address!("1111111111111111111111111111111111111111");
        let pool2 = address!("2222222222222222222222222222222222222222");

        let store = PoolStore::new();
        // B is cheap on pool1 (1M A : 1.05M B), expensive on pool2 (0.95M B : 1M A).
        store.update(pool1, PoolState::V2(V2PoolState {
            address: pool1, token0: token_a, token1: token_b,
            reserve0: U256::from(1_000_000u64) * U256::from(10u64).pow(U256::from(18u32)),
            reserve1: U256::from(1_050_000u64) * U256::from(10u64).pow(U256::from(18u32)),
            fee_bps: 30,
        }));
        store.update(pool2, PoolState::V2(V2PoolState {
            address: pool2, token0: token_b, token1: token_a,
            reserve0: U256::from(950_000u64) * U256::from(10u64).pow(U256::from(18u32)),
            reserve1: U256::from(1_000_000u64) * U256::from(10u64).pow(U256::from(18u32)),
            fee_bps: 30,
        }));

        let path = PathTemplate {
            id: 0,
            flash_token: token_a,
            flash_amount: U256::from(1000u32),
            hops: vec![
                HopTemplate { protocol: Protocol::UniswapV2, pool: pool1, token_in: token_a, token_out: token_b },
                HopTemplate { protocol: Protocol::UniswapV2, pool: pool2, token_in: token_b, token_out: token_a },
            ],
        };

        let one = U256::from(10u64).pow(U256::from(18u32));
        let min = one;
        let max = U256::from(50_000u64) * one;

        let (amount, profit) = find_optimal_amount(&path, &store, min, max, 30)
            .expect("optimizer must return the best observed probe, not None");
        assert!(profit > U256::ZERO);
        // Best-of-probes: result is at least as good as the smallest probe.
        assert!(profit >= simulate_profit(&path, min, &store));
        // Result amount stays inside the requested bounds.
        assert!(amount >= min && amount <= max);
    }
}
