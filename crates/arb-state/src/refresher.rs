use std::sync::Arc;
use std::time::Instant;

use alloy::sol;
use alloy_primitives::{Address, U256};
use anyhow::Result;
use tracing::{debug, warn};

use arb_core::types::*;
use arb_rpc::Endpoint;

use crate::pool_store::PoolStore;

sol! {
    #[sol(rpc)]
    interface IStateReader {
        struct V2State {
            address pool;
            address token0;
            address token1;
            uint112 reserve0;
            uint112 reserve1;
            uint32 fee;
        }

        struct V3State {
            address pool;
            address token0;
            address token1;
            uint160 sqrtPriceX96;
            int24 tick;
            uint128 liquidity;
            uint24 fee;
            bool unlocked;
        }

        struct AlgebraState {
            address pool;
            address token0;
            address token1;
            uint160 sqrtPriceX96;
            int24 tick;
            uint128 liquidity;
            uint16 feeZto;
            uint16 feeOtz;
            bool unlocked;
        }

        struct AeroV2State {
            address pool;
            address token0;
            address token1;
            uint256 reserve0;
            uint256 reserve1;
            bool stable;
            uint256 decimals0;
            uint256 decimals1;
            uint32 fee;
        }

        struct PcsStableState {
            address pool;
            address token0;
            address token1;
            uint256 balance0;
            uint256 balance1;
            uint256 A;
            uint256 fee;
            uint256 adminFee;
        }

        struct DodoV2State {
            address pool;
            address baseToken;
            address quoteToken;
            uint256 baseReserve;
            uint256 quoteReserve;
            uint256 baseTarget;
            uint256 quoteTarget;
            uint8 rState;
            uint256 k;
            uint256 lpFeeRate;
            uint256 mtFeeRate;
        }

        struct WombatState {
            address pool;
            address token0;
            address token1;
            uint256 cash0;
            uint256 cash1;
            uint256 liability0;
            uint256 liability1;
            uint256 ampFactor;
            uint256 haircutRate;
        }

        function readV2(address[] calldata pools) external view returns (V2State[] memory);
        function readV3(address[] calldata pools) external view returns (V3State[] memory);
        function readAlgebra(address[] calldata pools) external view returns (AlgebraState[] memory);
        function readAeroV2(address[] calldata pools) external view returns (AeroV2State[] memory);
        function readPcsStable(address[] calldata pools) external view returns (PcsStableState[] memory);
        function readDodoV2(address[] calldata pools) external view returns (DodoV2State[] memory);
        function readWombat(address[] calldata pools, address[] calldata token0s, address[] calldata token1s) external view returns (WombatState[] memory);
    }
}

sol! {
    #[sol(rpc)]
    interface IMulticall3 {
        struct Call3 {
            address target;
            bool allowFailure;
            bytes callData;
        }
        struct Result3 {
            bool success;
            bytes returnData;
        }
        function aggregate3(Call3[] calldata calls) external payable returns (Result3[] memory returnData);
    }

    #[sol(rpc)]
    interface IV2Pool {
        function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
        function token0() external view returns (address);
        function token1() external view returns (address);
    }

    #[sol(rpc)]
    interface IV3Pool {
        function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked);
        function liquidity() external view returns (uint128);
        function fee() external view returns (uint24);
        function token0() external view returns (address);
        function token1() external view returns (address);
    }
}

/// Canonical Multicall3 — deployed at the same address on BSC and Base.
/// READ-PATH ONLY: never used to wrap execution calldata (flash-loan
/// callbacks must land on our executor contract, not Multicall3).
pub const MULTICALL3_ADDR: Address = alloy_primitives::address!("cA11bde05977b3631167028862bE2a173976CA11");

pub struct PoolConfig {
    pub address: Address,
    pub protocol: Protocol,
    pub fee_bps: u32,
    pub token0: Option<Address>,
    pub token1: Option<Address>,
}

/// Curated factory-address → default fee table. Used when the on-chain reader
/// returns fee=0 (i.e., the pool contract doesn't expose its fee).
fn default_fee_for_factory(factory: Address, chain_id: u64) -> Option<u32> {
    match chain_id {
        56 => {
            let factory_str = format!("{:?}", factory).to_lowercase();
            match factory_str.as_str() {
                // PancakeSwap V2
                s if s.contains("ca143ce32fe78f1f7019d7d551a6402fc5350c73") => Some(25),
                // BiSwap
                s if s.contains("858e3312ed3a876947ea49d572a7c42de08af7ee") => Some(10),
                // MDEX
                s if s.contains("3cd1c46068daea5ebb0d3f55f6915b10648062b8") => Some(30),
                // ApeSwap
                s if s.contains("0841bd0b734e4f5853f0dd8d7ea989891dbdcfb5") => Some(20),
                _ => None,
            }
        }
        8453 => {
            let factory_str = format!("{:?}", factory).to_lowercase();
            match factory_str.as_str() {
                // BaseSwap V2
                s if s.contains("fda619b6d20975be80a10332cd39b9a4b0faa8bb") => Some(25),
                // SushiSwap V2
                s if s.contains("71524b4f93c58fcbf659783284e38825f0622859") => Some(30),
                _ => None,
            }
        }
        _ => None,
    }
}

fn partition_pools(configs: &[PoolConfig]) -> (Vec<Address>, Vec<Address>, Vec<Address>, Vec<Address>,
                                                Vec<Address>, Vec<Address>, Vec<Address>) {
    let mut v2 = Vec::new();
    let mut v3 = Vec::new();
    let mut algebra = Vec::new();
    let mut aero = Vec::new();
    let mut pcs_stable = Vec::new();
    let mut wombat = Vec::new();
    let mut dodo = Vec::new();

    for pc in configs {
        match pc.protocol {
            Protocol::UniswapV2 => v2.push(pc.address),
            Protocol::UniswapV3 | Protocol::AerodromeSlipstream => v3.push(pc.address),
            Protocol::UniswapV4 => {}
            Protocol::Algebra => algebra.push(pc.address),
            Protocol::AerodromeV2 => aero.push(pc.address),
            Protocol::PancakeStable => pcs_stable.push(pc.address),
            Protocol::Wombat => wombat.push(pc.address),
            Protocol::DodoV2 => dodo.push(pc.address),
        }
    }

    (v2, v3, algebra, aero, pcs_stable, wombat, dodo)
}

pub struct StateRefresher {
    endpoint: Arc<Endpoint>,
    state_reader_addr: Address,
    pool_configs: Vec<PoolConfig>,
    chain_id: u64,
}

impl StateRefresher {
    const CHUNK_SIZE: usize = 50;

    pub fn new(
        endpoint: Arc<Endpoint>,
        state_reader_addr: Address,
        pool_configs: Vec<PoolConfig>,
        chain_id: u64,
    ) -> Self {
        Self {
            endpoint,
            state_reader_addr,
            pool_configs,
            chain_id,
        }
    }

    /// Multicall3 read for V2 pools: reserves + token addresses in ONE
    /// aggregate3 (single network round-trip), allowFailure per call so a
    /// dead pool can't sink the batch — unlike the all-or-nothing
    /// IStateReader chunk reads.
    async fn multicall_v2(&self, pools: &[Address]) -> Vec<(Address, U256, U256, Address, Address)> {
        use alloy_sol_types::SolCall;
        let calls: Vec<IMulticall3::Call3> = pools
            .iter()
            .flat_map(|&p| {
                [
                    IV2Pool::getReservesCall::new(()).abi_encode().into(),
                    IV2Pool::token0Call::new(()).abi_encode().into(),
                    IV2Pool::token1Call::new(()).abi_encode().into(),
                ]
                .map(|call_data| IMulticall3::Call3 { target: p, allowFailure: true, callData: call_data })
            })
            .collect();
        let provider = self.endpoint.provider();
        let mc = IMulticall3::new(MULTICALL3_ADDR, provider);
        let results = match mc.aggregate3(calls).call().await {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "Multicall3 V2 read failed");
                return Vec::new();
            }
        };
        pools
            .iter()
            .enumerate()
            .filter_map(|(i, &p)| {
                let base = i * 3;
                let res = &results[base];
                let t0 = &results[base + 1];
                let t1 = &results[base + 2];
                if !(res.success && t0.success && t1.success) {
                    return None;
                }
                let reserves = IV2Pool::getReservesCall::abi_decode_returns(&res.returnData[..]).ok()?;
                let token0 = IV2Pool::token0Call::abi_decode_returns(&t0.returnData[..]).ok()?;
                let token1 = IV2Pool::token1Call::abi_decode_returns(&t1.returnData[..]).ok()?;
                Some((
                    p,
                    U256::from(reserves.reserve0),
                    U256::from(reserves.reserve1),
                    token0,
                    token1,
                ))
            })
            .collect()
    }

    /// Multicall3 read for V3 pools: slot0 + liquidity + fee + tokens in
    /// ONE aggregate3 round-trip, allowFailure per call.
    async fn multicall_v3(&self, pools: &[Address]) -> Vec<(Address, U256, i32, u128, u32, Address, Address)> {
        use alloy_sol_types::SolCall;
        let calls: Vec<IMulticall3::Call3> = pools
            .iter()
            .flat_map(|&p| {
                [
                    IV3Pool::slot0Call::new(()).abi_encode().into(),
                    IV3Pool::liquidityCall::new(()).abi_encode().into(),
                    IV3Pool::feeCall::new(()).abi_encode().into(),
                    IV3Pool::token0Call::new(()).abi_encode().into(),
                    IV3Pool::token1Call::new(()).abi_encode().into(),
                ]
                .map(|call_data| IMulticall3::Call3 { target: p, allowFailure: true, callData: call_data })
            })
            .collect();
        let provider = self.endpoint.provider();
        let mc = IMulticall3::new(MULTICALL3_ADDR, provider);
        let results = match mc.aggregate3(calls).call().await {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "Multicall3 V3 read failed");
                return Vec::new();
            }
        };
        pools
            .iter()
            .enumerate()
            .filter_map(|(i, &p)| {
                let base = i * 5;
                let s = results.get(base)?;
                let l = results.get(base + 1)?;
                let f = results.get(base + 2)?;
                let t0 = results.get(base + 3)?;
                let t1 = results.get(base + 4)?;
                if !(s.success && l.success && f.success && t0.success && t1.success) {
                    return None;
                }
                let slot0 = IV3Pool::slot0Call::abi_decode_returns(&s.returnData[..]).ok()?;
                let liq = IV3Pool::liquidityCall::abi_decode_returns(&l.returnData[..]).ok()?;
                let fee = IV3Pool::feeCall::abi_decode_returns(&f.returnData[..]).ok()?;
                let token0 = IV3Pool::token0Call::abi_decode_returns(&t0.returnData[..]).ok()?;
                let token1 = IV3Pool::token1Call::abi_decode_returns(&t1.returnData[..]).ok()?;
                Some((
                    p,
                    U256::from(slot0.sqrtPriceX96),
                    slot0.tick.as_i32(),
                    liq,
                    fee.to::<u32>(),
                    token0,
                    token1,
                ))
            })
            .collect()
    }

    pub async fn refresh(&self, store: &PoolStore) -> Result<(usize, std::time::Duration)> {
        let start = Instant::now();
        let mut updated = 0;

        let (v2_addrs, v3_addrs, algebra_addrs, aero_addrs,
             pcs_stable_addrs, wombat_addrs, dodo_addrs) = self.partition_by_type();

        // Each async block picks its own provider from the read pool and fails
        // over to the next healthy endpoint on a transport error (429/timeout).
        macro_rules! chunk_loop {
            ($label:literal, $chunks:expr, $call:ident) => {{
                let mut all = Vec::new();
                let (mut idx, provider) = self.endpoint.pool_pick();
                let mut reader = IStateReader::new(self.state_reader_addr, provider);
                for chunk in &$chunks {
                    match reader.$call(chunk.clone()).call().await {
                        Ok(states) => all.extend(states),
                        Err(e) => {
                            warn!(chunk_size = chunk.len(), "{} chunk read failed: {}", $label, e);
                            if arb_rpc::is_contract_transport_error(&e) {
                                self.endpoint.blacklist_read(idx);
                                let (nidx, np) = self.endpoint.pool_pick();
                                idx = nidx;
                                reader = IStateReader::new(self.state_reader_addr, np);
                                match reader.$call(chunk.clone()).call().await {
                                    Ok(states) => all.extend(states),
                                    Err(e2) => warn!(chunk_size = chunk.len(), "{} chunk retry failed: {}", $label, e2),
                                }
                            }
                        }
                    }
                }
                all
            }};
        }

        let v2_chunks: Vec<_> = v2_addrs.chunks(Self::CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        let v3_chunks: Vec<_> = v3_addrs.chunks(Self::CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        let algebra_chunks: Vec<_> = algebra_addrs.chunks(Self::CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        let aero_chunks: Vec<_> = aero_addrs.chunks(Self::CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        let pcs_chunks: Vec<_> = pcs_stable_addrs.chunks(Self::CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        let dodo_chunks: Vec<_> = dodo_addrs.chunks(Self::CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();

        let wombat_data: Vec<(Address, Address, Address)> = wombat_addrs.iter()
            .filter_map(|addr| {
                let cfg = self.pool_configs.iter().find(|c| c.address == *addr)?;
                Some((*addr, cfg.token0?, cfg.token1?))
            })
            .collect();
        let wombat_pools: Vec<Address> = wombat_data.iter().map(|d| d.0).collect();
        let wombat_t0s: Vec<Address> = wombat_data.iter().map(|d| d.1).collect();
        let wombat_t1s: Vec<Address> = wombat_data.iter().map(|d| d.2).collect();

        // When no bespoke state_reader is configured (zero address), skip the
        // reader path entirely — Multicall3 covers V2/V3 reads deployless.
        let reader_live = !self.state_reader_addr.is_zero();
        if !reader_live {
            debug!("state_reader unset — Multicall3 fallback mode (V2/V3 reads only)");
        }

        let (v2_results, v3_results, algebra_results, aero_results,
             pcs_results, dodo_results, wombat_results) = if !reader_live {
            (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new())
        } else {
            tokio::join!(
            async { chunk_loop!("V2", v2_chunks, readV2) },
            async { chunk_loop!("V3", v3_chunks, readV3) },
            async { chunk_loop!("Algebra", algebra_chunks, readAlgebra) },
            async { chunk_loop!("AeroV2", aero_chunks, readAeroV2) },
            async { chunk_loop!("PCS Stable", pcs_chunks, readPcsStable) },
            async { chunk_loop!("DODO", dodo_chunks, readDodoV2) },
            async {
                if wombat_pools.is_empty() {
                    return Vec::new();
                }
                let (idx, provider) = self.endpoint.pool_pick();
                let reader = IStateReader::new(self.state_reader_addr, provider);
                match reader.readWombat(wombat_pools.clone(), wombat_t0s.clone(), wombat_t1s.clone()).call().await {
                    Ok(states) => states,
                    Err(e) => {
                        warn!("Wombat read failed: {e}");
                        if arb_rpc::is_contract_transport_error(&e) {
                            self.endpoint.blacklist_read(idx);
                            let (_, np) = self.endpoint.pool_pick();
                            let retry = IStateReader::new(self.state_reader_addr, np);
                            match retry.readWombat(wombat_pools.clone(), wombat_t0s.clone(), wombat_t1s.clone()).call().await {
                                Ok(states) => states,
                                Err(e2) => {
                                    warn!("Wombat retry failed: {e2}");
                                    Vec::new()
                                }
                            }
                        } else {
                            Vec::new()
                        }
                    }
                }
            },
        )
        };

        for s in &v2_results {
            let onchain_fee = s.fee as u32;
            let fee_bps = if onchain_fee > 0 {
                onchain_fee
            } else {
                self.fee_for_pool(&s.pool)
            };
            store.update(
                s.pool,
                PoolState::V2(V2PoolState {
                    address: s.pool,
                    token0: s.token0,
                    token1: s.token1,
                    reserve0: U256::from(s.reserve0),
                    reserve1: U256::from(s.reserve1),
                    fee_bps,
                }),
            );
            updated += 1;
        }

        for s in &v3_results {
            if s.sqrtPriceX96.is_zero() {
                continue;
            }
            store.update(
                s.pool,
                PoolState::V3(V3PoolState {
                    address: s.pool,
                    token0: s.token0,
                    token1: s.token1,
                    sqrt_price_x96: U256::from(s.sqrtPriceX96),
                    tick: s.tick.as_i32(),
                    liquidity: s.liquidity,
                    fee: s.fee.to::<u32>(),
                    fee_otz: None,
                }),
            );
            updated += 1;
        }

        for s in &algebra_results {
            if s.sqrtPriceX96.is_zero() {
                continue;
            }
            store.update(
                s.pool,
                PoolState::V3(V3PoolState {
                    address: s.pool,
                    token0: s.token0,
                    token1: s.token1,
                    sqrt_price_x96: U256::from(s.sqrtPriceX96),
                    tick: s.tick.as_i32(),
                    liquidity: s.liquidity,
                    fee: s.feeZto as u32,
                    fee_otz: Some(s.feeOtz as u32),
                }),
            );
            updated += 1;
        }

        for s in &aero_results {
            let fee_bps = if s.fee > 0 {
                s.fee
            } else {
                self.fee_for_pool(&s.pool)
            };
            store.update(
                s.pool,
                PoolState::AeroV2(AeroV2PoolState {
                    address: s.pool,
                    token0: s.token0,
                    token1: s.token1,
                    reserve0: s.reserve0,
                    reserve1: s.reserve1,
                    stable: s.stable,
                    fee_bps,
                    decimals0: s.decimals0,
                    decimals1: s.decimals1,
                }),
            );
            updated += 1;
        }

        for s in &pcs_results {
            if s.balance0.is_zero() && s.balance1.is_zero() {
                continue;
            }
            store.update(
                s.pool,
                PoolState::Curve(CurvePoolState {
                    address: s.pool,
                    tokens: vec![s.token0, s.token1],
                    balances: vec![s.balance0, s.balance1],
                    amp: s.A,
                    fee: s.fee,
                }),
            );
            updated += 1;
        }

        for s in &dodo_results {
            if s.baseReserve.is_zero() && s.quoteReserve.is_zero() {
                continue;
            }
            store.update(
                s.pool,
                PoolState::Dodo(DodoPoolState {
                    address: s.pool,
                    base_token: s.baseToken,
                    quote_token: s.quoteToken,
                    base_reserve: s.baseReserve,
                    quote_reserve: s.quoteReserve,
                    base_target: s.baseTarget,
                    quote_target: s.quoteTarget,
                    r_state: s.rState,
                    k: s.k,
                    lp_fee_rate: s.lpFeeRate,
                    mt_fee_rate: s.mtFeeRate,
                }),
            );
            updated += 1;
        }

        for s in &wombat_results {
            if s.cash0.is_zero() && s.cash1.is_zero() {
                continue;
            }
            store.update(
                s.pool,
                PoolState::Wombat(WombatPoolState {
                    address: s.pool,
                    token_in: s.token0,
                    token_out: s.token1,
                    cash_in: s.cash0,
                    cash_out: s.cash1,
                    liability_in: s.liability0,
                    liability_out: s.liability1,
                    amp: s.ampFactor,
                    haircut_rate: s.haircutRate,
                }),
            );
            updated += 1;
        }

        // Multicall3 salvage: pools the reader missed (reverted chunks — the
        // constant "chunk read failed" noise) or ALL V2/V3 pools in
        // deployless mode. One aggregate3 per CHUNK_SIZE pools; per-pool
        // allowFailure so dead pools drop out instead of sinking the batch.
        {
            use std::collections::HashSet;
            let seen_v2: HashSet<Address> = v2_results.iter().map(|s| s.pool).collect();
            let missing_v2: Vec<Address> =
                v2_addrs.iter().copied().filter(|a| !seen_v2.contains(a)).collect();
            if !missing_v2.is_empty() {
                let mut salvaged = 0usize;
                for chunk in missing_v2.chunks(Self::CHUNK_SIZE) {
                    for (pool, r0, r1, t0, t1) in self.multicall_v2(chunk).await {
                        store.update(
                            pool,
                            PoolState::V2(V2PoolState {
                                address: pool,
                                token0: t0,
                                token1: t1,
                                reserve0: r0,
                                reserve1: r1,
                                fee_bps: self.fee_for_pool(&pool),
                            }),
                        );
                        updated += 1;
                        salvaged += 1;
                    }
                }
                if salvaged > 0 {
                    debug!(salvaged, missing = missing_v2.len(), "Multicall3 V2 salvage");
                }
            }

            let seen_v3: HashSet<Address> = v3_results.iter().map(|s| s.pool).collect();
            let missing_v3: Vec<Address> =
                v3_addrs.iter().copied().filter(|a| !seen_v3.contains(a)).collect();
            if !missing_v3.is_empty() {
                let mut salvaged = 0usize;
                for chunk in missing_v3.chunks(Self::CHUNK_SIZE) {
                    for (pool, sqrt_p, tick, liq, fee, t0, t1) in self.multicall_v3(chunk).await {
                        if sqrt_p.is_zero() {
                            continue;
                        }
                        store.update(
                            pool,
                            PoolState::V3(V3PoolState {
                                address: pool,
                                token0: t0,
                                token1: t1,
                                sqrt_price_x96: sqrt_p,
                                tick,
                                liquidity: liq,
                                fee,
                                fee_otz: None,
                            }),
                        );
                        updated += 1;
                        salvaged += 1;
                    }
                }
                if salvaged > 0 {
                    debug!(salvaged, missing = missing_v3.len(), "Multicall3 V3 salvage");
                }
            }
        }

        let block = self.endpoint.block_number().await.unwrap_or(0);
        store.set_block(block);

        let elapsed = start.elapsed();
        debug!(
            updated,
            elapsed_ms = elapsed.as_millis(),
            block,
            "State refresh completed"
        );

        Ok((updated, elapsed))
    }

    fn partition_by_type(&self) -> (Vec<Address>, Vec<Address>, Vec<Address>, Vec<Address>,
                                     Vec<Address>, Vec<Address>, Vec<Address>) {
        partition_pools(&self.pool_configs)
    }

    fn fee_for_pool(&self, pool: &Address) -> u32 {
        self.pool_configs
            .iter()
            .find(|pc| pc.address == *pool)
            .map(|pc| pc.fee_bps)
            .unwrap_or(30)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(b: u8) -> Address {
        Address::with_last_byte(b)
    }

    #[test]
    fn test_default_fee_pancakeswap_v2_bsc() {
        let factory: Address = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73".parse().unwrap();
        assert_eq!(default_fee_for_factory(factory, 56), Some(25));
    }

    #[test]
    fn test_default_fee_biswap_bsc() {
        let factory: Address = "0x858E3312ed3A876947EA49d572A7C42DE08af7EE".parse().unwrap();
        assert_eq!(default_fee_for_factory(factory, 56), Some(10));
    }

    #[test]
    fn test_default_fee_mdex_bsc() {
        let factory: Address = "0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062b8".parse().unwrap();
        assert_eq!(default_fee_for_factory(factory, 56), Some(30));
    }

    #[test]
    fn test_default_fee_apeswap_bsc() {
        let factory: Address = "0x0841BD0B734E4F5853f0dD8d7Ea989891DBdcFb5".parse().unwrap();
        assert_eq!(default_fee_for_factory(factory, 56), Some(20));
    }

    #[test]
    fn test_default_fee_baseswap_base() {
        let factory: Address = "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB".parse().unwrap();
        assert_eq!(default_fee_for_factory(factory, 8453), Some(25));
    }

    #[test]
    fn test_default_fee_sushiswap_base() {
        let factory: Address = "0x71524B4f93c58fcbF659783284E38825f0622859".parse().unwrap();
        assert_eq!(default_fee_for_factory(factory, 8453), Some(30));
    }

    #[test]
    fn test_default_fee_unknown_factory() {
        assert_eq!(default_fee_for_factory(addr(99), 56), None);
        assert_eq!(default_fee_for_factory(addr(99), 8453), None);
    }

    #[test]
    fn test_default_fee_unknown_chain() {
        let factory: Address = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73".parse().unwrap();
        assert_eq!(default_fee_for_factory(factory, 1), None);
    }

    #[test]
    fn test_partition_routes_correctly() {
        let configs = vec![
            PoolConfig { address: addr(1), protocol: Protocol::UniswapV2, fee_bps: 25, token0: None, token1: None },
            PoolConfig { address: addr(2), protocol: Protocol::UniswapV3, fee_bps: 0, token0: None, token1: None },
            PoolConfig { address: addr(3), protocol: Protocol::Algebra, fee_bps: 0, token0: None, token1: None },
            PoolConfig { address: addr(4), protocol: Protocol::AerodromeV2, fee_bps: 30, token0: None, token1: None },
            PoolConfig { address: addr(5), protocol: Protocol::PancakeStable, fee_bps: 0, token0: None, token1: None },
            PoolConfig { address: addr(6), protocol: Protocol::Wombat, fee_bps: 0, token0: Some(addr(10)), token1: Some(addr(11)) },
            PoolConfig { address: addr(7), protocol: Protocol::DodoV2, fee_bps: 0, token0: None, token1: None },
            PoolConfig { address: addr(8), protocol: Protocol::UniswapV4, fee_bps: 0, token0: None, token1: None },
            PoolConfig { address: addr(9), protocol: Protocol::AerodromeSlipstream, fee_bps: 0, token0: None, token1: None },
        ];
        let (v2, v3, algebra, aero, pcs, wombat, dodo) = partition_pools(&configs);
        assert_eq!(v2, vec![addr(1)]);
        assert_eq!(v3, vec![addr(2), addr(9)], "V3 + Slipstream");
        assert_eq!(algebra, vec![addr(3)]);
        assert_eq!(aero, vec![addr(4)]);
        assert_eq!(pcs, vec![addr(5)]);
        assert_eq!(wombat, vec![addr(6)]);
        assert_eq!(dodo, vec![addr(7)]);
    }

    #[test]
    fn test_v4_excluded_from_all_partitions() {
        let configs = vec![
            PoolConfig { address: addr(1), protocol: Protocol::UniswapV4, fee_bps: 0, token0: None, token1: None },
        ];
        let (v2, v3, algebra, aero, pcs, wombat, dodo) = partition_pools(&configs);
        assert!(v2.is_empty() && v3.is_empty() && algebra.is_empty() && aero.is_empty()
                && pcs.is_empty() && wombat.is_empty() && dodo.is_empty());
    }
}
