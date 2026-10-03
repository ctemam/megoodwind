use std::collections::HashMap;

use alloy_primitives::{Address, U256};

use arb_core::types::*;
use arb_state::PoolStore;

use crate::decoder::{DecodedSwap, DirectSwap};

/// Project one swap hop's impact on a pool, returning the post-swap state and
/// an estimate of the amount the hop outputs (the input to the victim's next
/// hop). Exact for V2-family pools; a same-tick approximation for V3.
pub fn project_and_quote(
    pool_addr: Address,
    token_in: Address,
    amount_in: U256,
    store: &PoolStore,
) -> Option<(PoolState, U256)> {
    let current = store.get(&pool_addr)?;

    match current {
        PoolState::V2(mut state) => {
            let is_token0_in = token_in == state.token0;
            let (reserve_in, reserve_out) = if is_token0_in {
                (&mut state.reserve0, &mut state.reserve1)
            } else {
                (&mut state.reserve1, &mut state.reserve0)
            };

            let amount_out = arb_core::v2::get_amount_out(
                amount_in,
                *reserve_in,
                *reserve_out,
                state.fee_bps,
            )
            .ok()?;

            *reserve_in = *reserve_in + amount_in;
            *reserve_out = reserve_out.checked_sub(amount_out)?;

            Some((PoolState::V2(state), amount_out))
        }
        PoolState::AeroV2(mut state) => {
            // For volatile Aerodrome pools, same constant-product math
            if !state.stable {
                let is_token0_in = token_in == state.token0;
                let (reserve_in, reserve_out) = if is_token0_in {
                    (&mut state.reserve0, &mut state.reserve1)
                } else {
                    (&mut state.reserve1, &mut state.reserve0)
                };

                let fee_amount = amount_in * U256::from(state.fee_bps) / U256::from(10000u32);
                let amount_after_fee = amount_in - fee_amount;
                let amount_out = (amount_after_fee * *reserve_out) / (*reserve_in + amount_after_fee);

                *reserve_in = *reserve_in + amount_in;
                *reserve_out = reserve_out.checked_sub(amount_out)?;

                Some((PoolState::AeroV2(state), amount_out))
            } else {
                // For stable pools, recompute is complex — for now skip projection
                None
            }
        }
        PoolState::V3(mut state) => {
            // For V3 pools, approximation: shift sqrt_price by the swap impact
            // within the current tick range — exact would require tick-walking.
            // Good enough for "is there an arb opportunity" screening.
            let zero_for_one = token_in == state.token0;
            let l = U256::from(state.liquidity);
            if l.is_zero() {
                return None;
            }

            let q96 = U256::from(1u128) << 96;
            let p0 = state.sqrt_price_x96;
            let amount_out;

            if zero_for_one {
                let product = amount_in * p0 / q96;
                let denom: U256 = l + product;
                if denom.is_zero() {
                    return None;
                }
                let p1 = l * p0 / denom;
                state.sqrt_price_x96 = p1;
                // dy = L * (sqrtP0 - sqrtP1) / 2^96
                amount_out = l * (p0 - p1) / q96;
            } else {
                let delta = amount_in * q96 / l;
                let p1 = p0 + delta;
                state.sqrt_price_x96 = p1;
                // dx = L * 2^96 * (1/sqrtP0 - 1/sqrtP1) = L * 2^96 * (p1 - p0) / (p0 * p1)
                if p0.is_zero() || p1.is_zero() {
                    return None;
                }
                amount_out = l * q96 * (p1 - p0) / (p0 * p1);
            }

            Some((PoolState::V3(state), amount_out))
        }
        _ => None,
    }
}

fn usd_value(amount: U256, token: Address,
             prices: &HashMap<Address, f64>, decimals: &HashMap<Address, u32>) -> Option<f64> {
    let p = *prices.get(&token)?;
    let d = *decimals.get(&token)?;
    if !(p > 0.0) { return None; }
    let v: u128 = amount.try_into().ok()?;
    Some(v as f64 / 10f64.powi(d as i32) * p)
}

fn usd_to_units(usd: f64, token: Address,
                prices: &HashMap<Address, f64>, decimals: &HashMap<Address, u32>) -> Option<U256> {
    let p = *prices.get(&token)?;
    let d = *decimals.get(&token)?;
    if !(p > 0.0) || !usd.is_finite() || usd <= 0.0 { return None; }
    let v = usd / p * 10f64.powi(d as i32);
    if !(v > 0.0) || !v.is_finite() || v > u128::MAX as f64 { return None; }
    Some(U256::from(v as u128))
}

/// Clone `store` and project every hop of a decoded pending swap's token path
/// onto the tracked pools each pair touches. Returns the projected store and
/// the pools that were moved, or None when no hop hits a tracked pool.
///
/// The victim's exact per-hop inputs are unknowable from calldata alone. The
/// amount entering hop k+1 is estimated as hop k's projected output when the
/// intermediate pool is tracked, carried as a USD value and re-denominated
/// into the next hop's input token via `usd_prices` — carrying raw units
/// across tokens fabricates huge impacts when the tokens' unit values differ.
/// Hops whose input token is unpriced are skipped (the estimate would be a
/// guess).
///
/// `pair_pools` maps an ordered (token0, token1) key to (pool_addr, fee_bps)
/// entries — the same index the runner builds from pool configs. When the
/// decoder recovered a V3 fee for a hop (`hop_fees`), prefer the matching fee
/// tier; if none matches, project onto all pools on the pair.
pub fn project_pending_path(
    store: &PoolStore,
    decoded: &DecodedSwap,
    amount_in: U256,
    pair_pools: &HashMap<(Address, Address), Vec<(Address, u32)>>,
    usd_prices: &HashMap<Address, f64>,
    decimals: &HashMap<Address, u32>,
) -> Option<(PoolStore, Vec<Address>, Option<f64>)> {
    if let Some(direct) = &decoded.direct {
        return project_direct(store, direct, usd_prices, decimals);
    }

    let projected = PoolStore::new();
    for (addr, st) in store.get_all() {
        projected.update(addr, st);
    }

    let hops: Vec<(Address, Address)> = if decoded.path.len() >= 2 {
        decoded.path.windows(2).map(|w| (w[0], w[1])).collect()
    } else if let (Some(t_in), Some(t_out)) = (decoded.token_in, decoded.token_out) {
        vec![(t_in, t_out)]
    } else {
        return None;
    };

    let mut hit_pools: Vec<Address> = Vec::new();
    // USD value of the victim's input — bounds what a backrun can extract.
    let victim_usd = hops
        .first()
        .and_then(|(t_in, _)| usd_value(amount_in, *t_in, usd_prices, decimals));
    let mut est_usd = victim_usd;
    for (k, (t_in, t_out)) in hops.iter().enumerate() {
        let key = if t_in < t_out { (*t_in, *t_out) } else { (*t_out, *t_in) };
        let Some(pools) = pair_pools.get(&key) else { continue };

        // Amount entering this hop: exact `amount_in` for hop 0; for later
        // hops, the USD value carried through the chain re-denominated into
        // this hop's input token.
        let est_in = if k == 0 {
            amount_in
        } else {
            match est_usd.and_then(|u| usd_to_units(u, *t_in, usd_prices, decimals)) {
                Some(a) => a,
                None => continue,
            }
        };

        let fee_bps = decoded
            .hop_fees
            .get(k)
            .copied()
            .or(if k == 0 { decoded.first_hop_fee } else { None })
            .map(|f| f / 100);
        let matched: Vec<Address> = match fee_bps {
            Some(f) if f != 0 => {
                let exact: Vec<Address> = pools
                    .iter()
                    .filter(|(_, pb)| *pb == f)
                    .map(|(a, _)| *a)
                    .collect();
                if exact.is_empty() {
                    pools.iter().map(|(a, _)| *a).collect()
                } else {
                    exact
                }
            }
            _ => pools.iter().map(|(a, _)| *a).collect(),
        };

        // When several pools match the pair (fee tiers), only the first
        // successful projection chains its output — projecting onto all of
        // them is a screen; chaining an ambiguous one would guess the venue.
        let mut chained = false;
        for pool_addr in &matched {
            if let Some((new_state, out)) =
                project_and_quote(*pool_addr, *t_in, est_in, &projected)
            {
                projected.update(*pool_addr, new_state);
                if !chained {
                    // Convert the hop's output to USD for the next hop; when
                    // the output token is unpriced, keep the carried value
                    // (fees are a small drag on the approximation).
                    est_usd = usd_value(out, *t_out, usd_prices, decimals).or(est_usd);
                    chained = true;
                }
                if !hit_pools.contains(pool_addr) {
                    hit_pools.push(*pool_addr);
                }
            }
        }
    }

    if hit_pools.is_empty() {
        None
    } else {
        Some((projected, hit_pools, victim_usd))
    }
}

/// Project a swap() call made directly on a pool contract. The callee is the
/// pool itself, so there is no pair/fee ambiguity — if `to` is a tracked pool
/// the projection is exact (V2 input recovered via `get_amount_in`; V3 input
/// carried in calldata).
fn project_direct(
    store: &PoolStore,
    direct: &DirectSwap,
    usd_prices: &HashMap<Address, f64>,
    decimals: &HashMap<Address, u32>,
) -> Option<(PoolStore, Vec<Address>, Option<f64>)> {
    let (pool, token_in, amount_in) = match direct {
        DirectSwap::V2 {
            pool,
            amount0_out,
            amount1_out,
        } => {
            // The nonzero output side picks the direction; the input is what
            // the reserves demand for that exact output.
            match store.get(pool)? {
                PoolState::V2(s) => {
                    let (token_in, reserve_in, reserve_out, out) = if amount0_out.is_zero() {
                        (s.token0, s.reserve0, s.reserve1, *amount1_out)
                    } else {
                        (s.token1, s.reserve1, s.reserve0, *amount0_out)
                    };
                    let amount_in =
                        arb_core::v2::get_amount_in(out, reserve_in, reserve_out, s.fee_bps).ok()?;
                    (*pool, token_in, amount_in)
                }
                PoolState::AeroV2(s) if !s.stable => {
                    let (token_in, reserve_in, reserve_out, out) = if amount0_out.is_zero() {
                        (s.token0, s.reserve0, s.reserve1, *amount1_out)
                    } else {
                        (s.token1, s.reserve1, s.reserve0, *amount0_out)
                    };
                    let amount_in =
                        arb_core::v2::get_amount_in(out, reserve_in, reserve_out, s.fee_bps).ok()?;
                    (*pool, token_in, amount_in)
                }
                _ => return None,
            }
        }
        DirectSwap::V3 {
            pool,
            zero_for_one,
            amount_in,
        } => match store.get(pool)? {
            PoolState::V3(s) => (
                *pool,
                if *zero_for_one { s.token0 } else { s.token1 },
                *amount_in,
            ),
            _ => return None,
        },
    };

    let projected = PoolStore::new();
    for (addr, st) in store.get_all() {
        projected.update(addr, st);
    }

    let (new_state, _) = project_and_quote(pool, token_in, amount_in, &projected)?;
    projected.update(pool, new_state);

    let victim_usd = usd_value(amount_in, token_in, usd_prices, decimals);
    Some((projected, vec![pool], victim_usd))
}
