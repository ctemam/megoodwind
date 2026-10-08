use std::collections::HashMap;

use alloy_primitives::{Address, U256};

use arb_core::types::*;
use arb_state::PoolStore;

use crate::decoder::{DecodedSwap, DirectSwap};

/// Project one swap hop's impact on a pool, returning the post-swap state and
/// an estimate of the amount the hop outputs (the input to the victim's next
/// hop). Exact for V2-family pools; a same-tick approximation for V3.
/// Returns (post-swap state, amount_out, move_frac) — move_frac is the
/// fractional price move this projection pushed, used downstream to
/// penalize same-tick approximations that walked far (crossed real ticks).
pub fn project_and_quote(
    pool_addr: Address,
    token_in: Address,
    amount_in: U256,
    store: &PoolStore,
) -> Option<(PoolState, U256, f64)> {
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

            let move_frac = if reserve_in.is_zero() {
                0.0
            } else {
                // fractional reserve shift — exact for constant-product
                amount_in.to_string().parse::<f64>().unwrap_or(0.0)
                    / (reserve_in.to_string().parse::<f64>().unwrap_or(1.0)
                        + amount_in.to_string().parse::<f64>().unwrap_or(0.0))
            };
            Some((PoolState::V2(state), amount_out, move_frac.min(1.0)))
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

                let ri = reserve_in.to_string().parse::<f64>().unwrap_or(0.0);
                let ai = amount_in.to_string().parse::<f64>().unwrap_or(0.0);
                let move_frac = if ri + ai > 0.0 { ai / (ri + ai) } else { 0.0 };
                Some((PoolState::AeroV2(state), amount_out, move_frac.min(1.0)))
            } else {
                // Stable pools: the AmmQuoter impl carries the exact
                // _f/_d/_get_y invariant math (fee already deducted inside).
                let amount_out = arb_core::AmmQuoter::quote(&state, token_in, amount_in).ok()?;
                let is_token0_in = token_in == state.token0;
                let (reserve_in, reserve_out) = if is_token0_in {
                    (&mut state.reserve0, &mut state.reserve1)
                } else {
                    (&mut state.reserve1, &mut state.reserve0)
                };
                *reserve_in = *reserve_in + amount_in;
                *reserve_out = reserve_out.checked_sub(amount_out)?;
                Some((PoolState::AeroV2(state), amount_out, 0.0))
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

            // Only the post-fee input moves the price — Uniswap v3 collects
            // `fee` hundredths of a bip on amountSpecified before the swap.
            // Projecting the gross input overstated the victim's price move
            // (up to 1% extra on the 10000-fee tier) and fabricated thin
            // phantom edges that died at the refreshed-state re-check.
            let fee = U256::from(if zero_for_one {
                state.fee
            } else {
                state.fee_otz.unwrap_or(state.fee)
            });
            let amount_eff = if fee.is_zero() {
                amount_in
            } else {
                let keep = U256::from(1_000_000u32) - fee;
                amount_in * keep / U256::from(1_000_000u32)
            };
            if amount_eff.is_zero() {
                return None;
            }

            let q96 = U256::from(1u128) << 96;
            let p0 = state.sqrt_price_x96;
            let amount_out;
            let move_frac;

            if zero_for_one {
                let product: U256 = amount_eff * p0 / q96;
                let denom: U256 = l + product;
                if denom.is_zero() {
                    return None;
                }
                let p1 = l * p0 / denom;
                state.sqrt_price_x96 = p1;
                // dy = L * (sqrtP0 - sqrtP1) / 2^96
                amount_out = l * (p0 - p1) / q96;
                // p1/p0 = L/(L+product): fractional move = product/(L+product)
                let lf = l.to_string().parse::<f64>().unwrap_or(0.0);
                let pf = product.to_string().parse::<f64>().unwrap_or(0.0);
                move_frac = if lf + pf > 0.0 { pf / (lf + pf) } else { 0.0 };
            } else {
                let delta = amount_eff * q96 / l;
                let p1 = p0 + delta;
                state.sqrt_price_x96 = p1;
                // dx = L * 2^96 * (1/sqrtP0 - 1/sqrtP1) = L * 2^96 * (p1 - p0) / (p0 * p1)
                // l * q96 * (p1 - p0) overflows U256 for real liquidity —
                // divide down before multiplying back up.
                if p0.is_zero() || p1.is_zero() {
                    return None;
                }
                let diff = p1.checked_sub(p0)?;
                let intermediate = l.checked_mul(diff)? / p1;
                amount_out = intermediate.checked_mul(q96)? / p0;
                let p0f = p0.to_string().parse::<f64>().unwrap_or(1.0);
                let p1f = p1.to_string().parse::<f64>().unwrap_or(0.0);
                move_frac = if p0f > 0.0 { (p1f - p0f) / p0f } else { 0.0 };
            }

            Some((PoolState::V3(state), amount_out, move_frac.min(1.0)))
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
///
/// Returns (projected store, moved pools, victim USD, max_move_frac) — the
/// last is the largest fractional price move any hop produced. Same-tick
/// V3 projections that pushed a pool >~25% walked across real ticks the
/// approximation cannot see; callers should scale confidence accordingly.
pub fn project_pending_path(
    store: &PoolStore,
    decoded: &DecodedSwap,
    amount_in: U256,
    pair_pools: &HashMap<(Address, Address), Vec<(Address, u32)>>,
    usd_prices: &HashMap<Address, f64>,
    decimals: &HashMap<Address, u32>,
) -> Option<(PoolStore, Vec<Address>, Option<f64>, f64)> {
    if let Some(direct) = &decoded.direct {
        return project_direct(store, direct, usd_prices, decimals);
    }

    let projected = PoolStore::new();
    for (addr, st) in store.get_all() {
        // Preserve the source freshness timestamp so a stale pool stays
        // stale inside the projected state.
        let ts = store.updated_at(&addr).unwrap_or(0);
        projected.update_at(addr, st, ts);
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
    let mut max_move = 0.0f64;
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
            if let Some((new_state, out, move_frac)) =
                project_and_quote(*pool_addr, *t_in, est_in, &projected)
            {
                if move_frac > max_move {
                    max_move = move_frac;
                }
                let ts = projected.updated_at(pool_addr).unwrap_or(0);
                projected.update_at(*pool_addr, new_state, ts);
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
        Some((projected, hit_pools, victim_usd, max_move))
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
) -> Option<(PoolStore, Vec<Address>, Option<f64>, f64)> {
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
        let ts = store.updated_at(&addr).unwrap_or(0);
        projected.update_at(addr, st, ts);
    }

    let (new_state, _, move_frac) = project_and_quote(pool, token_in, amount_in, &projected)?;
    let ts = projected.updated_at(&pool).unwrap_or(0);
    projected.update_at(pool, new_state, ts);

    let victim_usd = usd_value(amount_in, token_in, usd_prices, decimals);
    Some((projected, vec![pool], victim_usd, move_frac))
}

/// Pool-state sanity quarantine: a pool whose implied spot price diverges
/// from same-pair peers by more than `max_ratio` is broken (manipulated,
/// exhausted, or misread state) — paths through it fabricate phantom arb.
/// Returns the set of pool addresses to exclude from candidate evaluation.
///
/// Prices are normalized to units of pair token b per token a. V2 price =
/// reserve1/reserve0; V3 price = (sqrtP/2^96)^2 — both raw-unit ratios, so
/// decimal adjustment cancels across pools on the same pair.
pub fn quarantine_outlier_pools(
    store: &PoolStore,
    pair_pools: &HashMap<(Address, Address), Vec<(Address, u32)>>,
    pool_tokens: &HashMap<Address, (Address, Address)>,
    max_ratio: f64,
) -> std::collections::HashSet<Address> {
    let mut out = std::collections::HashSet::new();
    for ((a, b), pools) in pair_pools {
        if pools.len() < 2 {
            continue;
        }
        let mut priced: Vec<(Address, f64)> = Vec::new();
        for (pool, _) in pools {
            let Some((t0, _)) = pool_tokens.get(pool).copied() else { continue };
            let Some(state) = store.get(pool) else { continue };
            let p = match state {
                PoolState::V2(s) => {
                    let r0 = s.reserve0.to_string().parse::<f64>().unwrap_or(0.0);
                    let r1 = s.reserve1.to_string().parse::<f64>().unwrap_or(0.0);
                    if r0 <= 0.0 { continue }
                    r1 / r0
                }
                PoolState::V3(s) => {
                    let sp = s.sqrt_price_x96.to_string().parse::<f64>().unwrap_or(0.0);
                    if sp <= 0.0 { continue }
                    let q96 = (sp / 79228162514264337593543950336.0).powi(2);
                    q96
                }
                _ => continue,
            };
            // Normalize to token(b)-per-token(a): if the pool's token0 is
            // pair token b, the computed ratio is inverted.
            let p_norm = if t0 == *a { p } else if p > 0.0 { 1.0 / p } else { continue };
            if p_norm > 0.0 && p_norm.is_finite() {
                priced.push((*pool, p_norm));
            }
        }
        // Need >=3 priced pools: with only 2, either could be the broken
        // one and a two-point "median" is just the larger value — flagging
        // would hit the healthy pool and spare the outlier.
        if priced.len() < 3 {
            continue;
        }
        let mut vals: Vec<f64> = priced.iter().map(|(_, p)| *p).collect();
        vals.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
        // True middle for odd counts; lower-middle for even (conservative:
        // favours flagging high-side outliers over healthy pools).
        let median = vals[(vals.len() - 1) / 2];
        for (pool, p) in priced {
            if p > median * max_ratio || p < median / max_ratio {
                out.insert(pool);
            }
        }
    }
    out
}
