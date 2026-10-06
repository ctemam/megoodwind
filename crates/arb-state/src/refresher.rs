use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use alloy::sol;
use alloy_primitives::{Address, B256, U256};
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

        /// Legacy reader layout — deployed readers that predate the fee
        /// field return this 5-field tuple; the fee then comes from the
        /// static pool config. `readV2Legacy` is never invoked on-chain;
        /// its return type only exists so `abi_decode_returns` can decode
        /// raw `readV2` output that matches the legacy layout.
        struct V2StateLegacy {
            address pool;
            address token0;
            address token1;
            uint112 reserve0;
            uint112 reserve1;
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
        function readV2Legacy(address[] calldata pools) external view returns (V2StateLegacy[] memory);
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
        // swapFee() is optional — Uniswap V2 and PancakeSwap V2 pairs do not
        // implement it; probed via allowFailure so a missing getter falls
        // through to the factory table / config / default in the resolver.
        // factory() is a standard UniV2-fork getter used for that fallback.
        function swapFee() external view returns (uint256);
        function factory() external view returns (address);
    }

    #[sol(rpc)]
    interface IV3Pool {
        function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked);
        function liquidity() external view returns (uint128);
        function fee() external view returns (uint24);
        function token0() external view returns (address);
        function token1() external view returns (address);
    }

    #[sol(rpc)]
    interface ISlipstreamPool {
        // Aerodrome Slipstream slot0 drops Uniswap's feeProtocol field —
        // 6-word return vs V3's 7. Same selector, different ABI.
        function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked);
    }

    #[sol(rpc)]
    interface IAlgebraPool {
        // Algebra v1.9 globalState() — replaces slot0; the dynamic fee is a
        // single uint16 (hundredths of a bip, same units as V3 fee).
        // Thena Fusion pools on BSC return this 7-word shape.
        function globalState() external view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked);
        function liquidity() external view returns (uint128);
        function token0() external view returns (address);
        function token1() external view returns (address);
    }

    #[sol(rpc)]
    interface IAlgebraIntegralPool {
        // Algebra Integral variant — same selector, 8-word return with the
        // dynamic fee split per direction (feeZto/feeOtz).
        function globalState() external view returns (uint160 price, int24 tick, uint16 feeZto, uint16 feeOtz, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked);
    }

    #[sol(rpc)]
    interface IAeroV2Pool {
        function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
        function stable() external view returns (bool);
        function token0() external view returns (address);
        function token1() external view returns (address);
    }

    #[sol(rpc)]
    interface IERC20 {
        function decimals() external view returns (uint8);
    }

    #[sol(rpc)]
    interface IExtsload {
        // UniV4 PoolManager exposes NO view getters — pool state is read
        // through EIP-1153-style raw slot access (verified live: getSlot0
        // reverts on the BSC PoolManager 0x28e2ea09...9df, extsload works).
        function extsload(bytes32[] calldata slots) external view returns (bytes32[] memory);
    }
}

lazy_static::lazy_static! {
    /// Per-batch network round-trip for each reader method / aggregate3
    /// call, labeled by the read-pool endpoint that served it. Wire time
    /// only — client-side ABI decode is measured separately.
    static ref READER_RPC_SECONDS: prometheus::HistogramVec = prometheus::register_histogram_vec!(
        "arb_reader_rpc_seconds",
        "Network round-trip per batched state read, by reader method and endpoint",
        &["method", "endpoint"],
        vec![0.005, 0.01, 0.02, 0.04, 0.07, 0.1, 0.15, 0.25, 0.4, 0.8]
    ).unwrap();

    /// Client-side ABI decode time per batch, by method.
    static ref READER_DECODE_SECONDS: prometheus::HistogramVec = prometheus::register_histogram_vec!(
        "arb_reader_decode_seconds",
        "Client-side ABI decode time per batched read, by method",
        &["method"],
        vec![0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025]
    ).unwrap();

    /// Per-refresh phase totals. rpc = summed network-call time across all
    /// reads (branches run concurrently — busy time, not wall); decode =
    /// summed client decode/extract time; store = PoolStore update section;
    /// wall = total refresh (same measurement as arb_state_refresh_seconds).
    static ref REFRESH_PHASE_SECONDS: prometheus::HistogramVec = prometheus::register_histogram_vec!(
        "arb_state_refresh_phase_seconds",
        "Per-refresh time by phase: rpc|decode|store|wall",
        &["phase"],
        vec![0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0]
    ).unwrap();
}

/// Records a decode/extract segment into READER_DECODE_SECONDS on scope
/// exit — keeps measurement correct through early returns.
struct DecodeTimer<'a> {
    r: &'a StateRefresher,
    m: &'static str,
    t: Instant,
}

impl Drop for DecodeTimer<'_> {
    fn drop(&mut self) {
        self.r.note_decode(self.m, self.t.elapsed());
    }
}

/// Canonical Multicall3 — deployed at the same address on BSC and Base.
/// READ-PATH ONLY: never used to wrap execution calldata (flash-loan
/// callbacks must land on our executor contract, not Multicall3).
pub const MULTICALL3_ADDR: Address =
    alloy_primitives::address!("cA11bde05977b3631167028862bE2a173976CA11");

pub struct PoolConfig {
    pub address: Address,
    pub protocol: Protocol,
    pub fee_bps: u32,
    pub token0: Option<Address>,
    pub token1: Option<Address>,
}

/// A V4 pool's identity inside the PoolManager singleton. `address` is the
/// pseudo address (last 20 bytes of `pool_id`) used as the PoolStore/hop
/// key; `pool_id` derives the state slots read via `extsload` on `manager`.
/// There is deliberately no reader method — V4 always reads through the
/// deployless Multicall3 path.
pub struct V4PoolSpec {
    pub address: Address,
    pub pool_id: B256,
    pub manager: Address,
}

impl V4PoolSpec {
    /// v4-core Pool.POOLS_SLOT = 6: the _pools mapping lives at slot 6, so
    /// Pool.State sits at keccak256(poolId ++ 6). Slot0 at +0, liquidity +3.
    pub fn pool_slot(&self) -> B256 {
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(self.pool_id.as_slice());
        buf[63] = 6;
        alloy_primitives::keccak256(buf)
    }

    pub fn liquidity_slot(&self) -> B256 {
        B256::from(U256::from_be_bytes::<32>(*self.pool_slot()) + U256::from(3u64))
    }
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

/// Resolved V2 swap fee in bps: pair-reported `swapFee()` > factory table >
/// declared config > UniV2's 30 bps max-common default. A stored config fee
/// of 0 means "unset" — it must never reach the quote path (a fabricated 0%
/// fee quotes phantom profit, so the guard lives here, at the write site).
fn resolve_v2_fee_bps(
    onchain_swap_fee: Option<u32>,
    factory: Option<Address>,
    config_bps: u32,
    chain_id: u64,
) -> u32 {
    if let Some(bps) = onchain_swap_fee {
        return bps;
    }
    if let Some(bps) = factory.and_then(|f| default_fee_for_factory(f, chain_id)) {
        return bps;
    }
    if config_bps > 0 {
        return config_bps;
    }
    30
}

fn partition_pools(
    configs: &[PoolConfig],
) -> (
    Vec<Address>,
    Vec<Address>,
    Vec<Address>,
    Vec<Address>,
    Vec<Address>,
    Vec<Address>,
    Vec<Address>,
) {
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

/// Per-reader-method circuit breaker: a method that fails with a
/// non-transport error (revert, ABI decode) on every chunk for
/// DEAD_AFTER refreshes in a row is proven dead on this deployment — its
/// bytecode predates the interface. Skipping the call avoids
/// guaranteed-wasted round-trips every block.
#[derive(Default)]
struct MethodCircuitBreaker {
    streaks: std::sync::Mutex<std::collections::HashMap<&'static str, u8>>,
}

impl MethodCircuitBreaker {
    /// Consecutive refreshes in which a reader method must fail on every
    /// chunk before it is skipped for the rest of the session.
    const DEAD_AFTER: u8 = 2;

    /// Increment the contract-failure streak; warn once when the method
    /// crosses the dead threshold.
    fn note_failure(&self, label: &'static str) {
        let mut m = self.streaks.lock().unwrap();
        let n = m.entry(label).or_insert(0);
        *n = n.saturating_add(1);
        if *n == Self::DEAD_AFTER {
            warn!(method = label, "StateReader method dead on this deployment — skipping call (Multicall3 fallback covers V2/V3/Algebra/AeroV2)");
        }
    }

    /// Reset a method's streak on any successful chunk read.
    fn clear(&self, label: &'static str) {
        self.streaks.lock().unwrap().remove(label);
    }

    /// True once a method has failed contract-side for DEAD_AFTER
    /// consecutive refreshes.
    fn is_dead(&self, label: &'static str) -> bool {
        self.streaks
            .lock()
            .unwrap()
            .get(label)
            .is_some_and(|n| *n >= Self::DEAD_AFTER)
    }
}

pub struct StateRefresher {
    endpoint: Arc<Endpoint>,
    state_reader_addr: Address,
    pool_configs: RwLock<Vec<PoolConfig>>,
    /// V4 pool identities (pseudo addr → poolId + PoolManager). Kept off
    /// pool_configs so the protocol partition and its tests are untouched.
    v4_pools: Vec<V4PoolSpec>,
    chain_id: u64,
    call_deadline: std::time::Duration,
    reader_breaker: MethodCircuitBreaker,
    /// Refresh-phase accumulators (nanoseconds): reset at the top of each
    /// refresh and summed across the parallel read branches.
    rpc_ns: AtomicU64,
    decode_ns: AtomicU64,
}

impl StateRefresher {
    const CHUNK_SIZE: usize = 50;
    /// Reader batch size — the bespoke contract eats a whole pool class in
    /// one eth_call, so chunks can far exceed the Multicall3 Call3 cap.
    /// Public endpoints answer a ~128-pool read in a single RTT.
    const READER_CHUNK_SIZE: usize = 128;
    /// Max Call3s per aggregate3 round-trip — public nodes reject oversized
    /// eth_calls ("request is too complex") well before the gas cap. 30 calls
    /// = 10 V2 or 6 V3 pools per round-trip; lighter batches answer inside the
    /// deadline instead of timing out and serializing into retries.
    const MC3_MAX_CALLS: usize = 30;
    /// Per-call deadline for every read. Public endpoints have bimodal tail
    /// latency (~150ms healthy vs 500ms+ slow): an unbounded slow pick holds
    /// the whole parallel join hostage. A call past the deadline benches the
    /// endpoint like a transport failure and retries on the next one.
    const CALL_DEADLINE: std::time::Duration = std::time::Duration::from_millis(400);

    pub fn new(
        endpoint: Arc<Endpoint>,
        state_reader_addr: Address,
        pool_configs: Vec<PoolConfig>,
        chain_id: u64,
    ) -> Self {
        Self {
            endpoint,
            state_reader_addr,
            pool_configs: RwLock::new(pool_configs),
            v4_pools: Vec::new(),
            chain_id,
            call_deadline: Self::CALL_DEADLINE,
            reader_breaker: MethodCircuitBreaker::default(),
            rpc_ns: AtomicU64::new(0),
            decode_ns: AtomicU64::new(0),
        }
    }

    /// Per-chain read deadline override ([chain] call_deadline_ms). Chains
    /// whose public endpoints answer aggregate3 batches in >400ms (Ethereum,
    /// Polygon) need more slack or every refresh batch is benched.
    pub fn with_call_deadline(mut self, deadline_ms: u64) -> Self {
        self.call_deadline = std::time::Duration::from_millis(deadline_ms);
        self
    }

    /// Attach the V4 pool identities for this chain ([chain] v4_pool_manager
    /// + [[pools]] v4 entries). V4 state is read via getSlot0/getLiquidity
    /// on the PoolManager — no bespoke reader involvement.
    pub fn with_v4_pools(mut self, specs: Vec<V4PoolSpec>) -> Self {
        self.v4_pools = specs;
        self
    }

    /// Increment the contract-failure streak for a reader method; warn once
    /// when it crosses the dead threshold.
    fn note_reader_contract_failure(&self, label: &'static str) {
        self.reader_breaker.note_failure(label);
    }

    /// Reset a method's streak on any successful chunk read.
    fn clear_reader_failure(&self, label: &'static str) {
        self.reader_breaker.clear(label);
    }

    /// True once a reader method has failed contract-side for the
    /// consecutive-failure threshold.
    fn reader_method_dead(&self, label: &'static str) -> bool {
        self.reader_breaker.is_dead(label)
    }

    /// Record one network round-trip: phase accumulator + per-method,
    /// per-endpoint histogram + the endpoint's latency EWMA.
    fn note_rpc(&self, method: &'static str, idx: usize, dur: std::time::Duration) {
        self.rpc_ns
            .fetch_add(dur.as_nanos() as u64, Ordering::Relaxed);
        self.endpoint.note_latency(idx, dur);
        READER_RPC_SECONDS
            .with_label_values(&[method, self.endpoint.endpoint_url(idx)])
            .observe(dur.as_secs_f64());
    }

    /// Record client-side decode/extract time: phase accumulator +
    /// per-method histogram.
    fn note_decode(&self, method: &'static str, dur: std::time::Duration) {
        self.decode_ns
            .fetch_add(dur.as_nanos() as u64, Ordering::Relaxed);
        READER_DECODE_SECONDS
            .with_label_values(&[method])
            .observe(dur.as_secs_f64());
    }

    /// Scope guard that times a decode/extract segment — records on drop
    /// so early returns stay measured.
    fn decode_timer(&self, method: &'static str) -> DecodeTimer<'_> {
        DecodeTimer {
            r: self,
            m: method,
            t: Instant::now(),
        }
    }

    /// One aggregate3 against the read pool — batches run CONCURRENTLY
    /// (join_all preserves order): sequential batching multiplied the
    /// refresh wall time by the batch count at one RTT each.
    async fn multicall_aggregate3(
        &self,
        calls: Vec<IMulticall3::Call3>,
    ) -> Vec<IMulticall3::Result3> {
        let parts = futures::future::join_all(
            calls
                .chunks(Self::MC3_MAX_CALLS)
                .map(|b| self.aggregate3_batch(b)),
        )
        .await;
        merge_aggregate3_parts(calls.chunks(Self::MC3_MAX_CALLS), parts)
    }

    /// Single aggregate3 batch with transport failover. Some public endpoints
    /// reject even moderate batches ("request is too complex", -32602) — a
    /// per-endpoint gas/complexity limit, not a transport fault — so the
    /// batch is split and retried recursively instead of failing wholesale.
    fn aggregate3_batch<'a>(
        &'a self,
        batch: &'a [IMulticall3::Call3],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<IMulticall3::Result3>> + Send + 'a>>
    {
        Box::pin(async move {
            for attempt in 0..2 {
                let (idx, provider) = self.endpoint.pool_pick();
                let mc = IMulticall3::new(MULTICALL3_ADDR, provider);
                let t = Instant::now();
                match tokio::time::timeout(
                    self.call_deadline,
                    mc.aggregate3(batch.to_vec()).call_raw(),
                )
                .await
                {
                    Ok(Ok(raw)) => {
                        self.note_rpc("aggregate3", idx, t.elapsed());
                        let _dt = self.decode_timer("aggregate3");
                        match <IMulticall3::aggregate3Call as alloy_sol_types::SolCall>::abi_decode_returns(&raw[..]) {
                            Ok(r) => return r,
                            Err(e) => {
                                warn!(error = %e, calls = batch.len(), "aggregate3 decode failed");
                                return Vec::new();
                            }
                        }
                    }
                    outcome => {
                        // Failed/timed-out calls still spent wire time — count it.
                        self.note_rpc("aggregate3", idx, t.elapsed());
                        if let Ok(Err(e)) = &outcome {
                            warn!(error = %e, attempt, calls = batch.len(), "Multicall3 aggregate3 failed");
                            let msg = e.to_string().to_ascii_lowercase();
                            if msg.contains("too complex") || msg.contains("too large") {
                                self.endpoint.blacklist_read(idx);
                                let mut out = Vec::new();
                                if batch.len() > 4 {
                                    let mid = batch.len() / 2;
                                    out = self.aggregate3_batch(&batch[..mid]).await;
                                    if !out.is_empty() {
                                        out.extend(self.aggregate3_batch(&batch[mid..]).await);
                                    }
                                }
                                return out;
                            }
                            if !arb_rpc::is_contract_transport_error(e) || attempt == 1 {
                                return Vec::new();
                            }
                        } else {
                            warn!(
                                attempt,
                                calls = batch.len(),
                                "Multicall3 aggregate3 timed out"
                            );
                        }
                        self.endpoint.blacklist_read(idx);
                    }
                }
            }
            Vec::new()
        })
    }

    /// One-shot AMM interface detection for pools whose feed metadata can't
    /// name the flavor (unversioned/unknown dex ids — measured: DS reports
    /// ~36 liquid BSC pools per ingest cycle that dexId alone cannot
    /// classify). Three selectors per pool in ONE aggregate3 batch with
    /// allowFailure: globalState → Algebra, slot0 → V3, getReserves → V2.
    ///
    /// The most specific interface wins: Algebra forks (Thena, Quickswap
    /// V3) can also answer slot0 on some deployments, and probing
    /// globalState first keeps them off the V3 read path (which would
    /// miss the dynamic fee). Pools answering none of the three stay
    /// unadmitted — the caller drops them.
    /// Returns `None` on batch transport failure (vs `Some(empty)` when
    /// every pool answered with no supported interface) so callers can
    /// retry next cycle instead of caching a negative verdict.
    pub async fn probe_interfaces(
        &self,
        pools: &[Address],
    ) -> Option<std::collections::HashMap<Address, Protocol>> {
        use alloy_sol_types::SolCall;
        if pools.is_empty() {
            return Some(std::collections::HashMap::new());
        }
        let mut calls = Vec::with_capacity(pools.len() * 3);
        for p in pools {
            calls.push(IMulticall3::Call3 {
                target: *p,
                allowFailure: true,
                callData: IAlgebraPool::globalStateCall::new(())
                    .abi_encode()
                    .into(),
            });
            calls.push(IMulticall3::Call3 {
                target: *p,
                allowFailure: true,
                callData: IV3Pool::slot0Call::new(())
                    .abi_encode()
                    .into(),
            });
            calls.push(IMulticall3::Call3 {
                target: *p,
                allowFailure: true,
                callData: IV2Pool::getReservesCall::new(())
                    .abi_encode()
                    .into(),
            });
        }
        let results = self.multicall_aggregate3(calls).await;
        if results.len() < pools.len() * 3 {
            return None; // transport failure — no verdict to cache
        }
        let mut out = std::collections::HashMap::new();
        for (i, p) in pools.iter().enumerate() {
            let t = &results[i * 3..i * 3 + 3];
            if let Some(proto) = classify_probe_triplet(&t[0], &t[1], &t[2]) {
                out.insert(*p, proto);
            }
        }
        Some(out)
    }

    /// Hot-add pools discovered mid-run (leader-scan merge). They join the
    /// next refresh cycle and become visible to refresh_pools immediately.
    pub fn add_pools(&self, mut add: Vec<PoolConfig>) {
        self.pool_configs.write().unwrap().append(&mut add);
    }

    fn pool_tokens(&self, pool: &Address) -> Option<(Address, Address)> {
        self.pool_configs
            .read()
            .unwrap()
            .iter()
            .find(|pc| pc.address == *pool)
            .and_then(|pc| pc.token0.zip(pc.token1))
    }

    fn pool_protocol(&self, pool: &Address) -> Option<Protocol> {
        self.pool_configs
            .read()
            .unwrap()
            .iter()
            .find(|pc| pc.address == *pool)
            .map(|pc| pc.protocol)
    }

    /// Decode a slot0() return for a V3-class pool. Aerodrome Slipstream
    /// omits Uniswap's feeProtocol field — 6-word return vs V3's 7 — so the
    /// V3 decode always fails on Slipstream pools even though the call and
    /// the price/tick layout are identical.
    fn decode_v3_slot0(&self, pool: &Address, data: &[u8]) -> Option<(U256, i32)> {
        use alloy_sol_types::SolCall;
        if matches!(
            self.pool_protocol(pool),
            Some(Protocol::AerodromeSlipstream)
        ) {
            ISlipstreamPool::slot0Call::abi_decode_returns(data)
                .ok()
                .map(|r| (U256::from(r.sqrtPriceX96), r.tick.as_i32()))
        } else {
            IV3Pool::slot0Call::abi_decode_returns(data)
                .ok()
                .map(|r| (U256::from(r.sqrtPriceX96), r.tick.as_i32()))
        }
    }

    /// Multicall3 read for V2 pools: reserves + token addresses in ONE
    /// aggregate3 (single network round-trip), allowFailure per call so a
    /// dead pool can't sink the batch — unlike the all-or-nothing
    /// IStateReader chunk reads. Pools whose token pair is already in config
    /// skip the token0/token1 calls — only getReserves is dynamic. The full
    /// path also probes swapFee()/factory() so the fee resolves per
    /// `resolve_v2_fee_bps` (onchain > factory table > config > 30 bps).
    /// Returns (pool, reserve0, reserve1, token0, token1, fee_bps).
    async fn multicall_v2(
        &self,
        pools: &[Address],
    ) -> Vec<(Address, U256, U256, Address, Address, u32)> {
        use alloy_sol_types::SolCall;
        let mut out = Vec::with_capacity(pools.len());

        let (slim, full): (Vec<Address>, Vec<Address>) = pools
            .iter()
            .copied()
            .partition(|p| self.pool_tokens(p).is_some());

        if !slim.is_empty() {
            let calls: Vec<IMulticall3::Call3> = slim
                .iter()
                .map(|&p| IMulticall3::Call3 {
                    target: p,
                    allowFailure: true,
                    callData: IV2Pool::getReservesCall::new(()).abi_encode().into(),
                })
                .collect();
            let results = self.multicall_aggregate3(calls).await;
            let _dt = self.decode_timer("mc_v2");
            if results.len() == slim.len() {
                for (i, res) in results.iter().enumerate() {
                    let p = slim[i];
                    if !res.success {
                        continue;
                    }
                    let Some((t0, t1)) = self.pool_tokens(&p) else {
                        continue;
                    };
                    let Ok(reserves) =
                        IV2Pool::getReservesCall::abi_decode_returns(&res.returnData[..])
                    else {
                        continue;
                    };
                    out.push((
                        p,
                        U256::from(reserves.reserve0),
                        U256::from(reserves.reserve1),
                        t0,
                        t1,
                        self.fee_for_pool(&p),
                    ));
                }
            }
        }

        if full.is_empty() {
            return out;
        }
        let calls: Vec<IMulticall3::Call3> = full
            .iter()
            .flat_map(|&p| {
                [
                    IV2Pool::getReservesCall::new(()).abi_encode().into(),
                    IV2Pool::token0Call::new(()).abi_encode().into(),
                    IV2Pool::token1Call::new(()).abi_encode().into(),
                    IV2Pool::swapFeeCall::new(()).abi_encode().into(),
                    IV2Pool::factoryCall::new(()).abi_encode().into(),
                ]
                .map(|call_data| IMulticall3::Call3 {
                    target: p,
                    allowFailure: true,
                    callData: call_data,
                })
            })
            .collect();
        let results = self.multicall_aggregate3(calls).await;
        let _dt = self.decode_timer("mc_v2");
        if results.len() != full.len() * 5 {
            return out;
        }
        out.extend(full.iter().enumerate().filter_map(|(i, &p)| {
            let base = i * 5;
            let res = &results[base];
            let t0 = &results[base + 1];
            let t1 = &results[base + 2];
            if !(res.success && t0.success && t1.success) {
                return None;
            }
            let reserves =
                IV2Pool::getReservesCall::abi_decode_returns(&res.returnData[..]).ok()?;
            let token0 = IV2Pool::token0Call::abi_decode_returns(&t0.returnData[..]).ok()?;
            let token1 = IV2Pool::token1Call::abi_decode_returns(&t1.returnData[..]).ok()?;
            // Optional probes — a missing/undecodable getter falls through to
            // the factory table / config / default in the resolver.
            let swap_fee = if results[base + 3].success {
                IV2Pool::swapFeeCall::abi_decode_returns(&results[base + 3].returnData[..])
                    .ok()
                    .map(|f| f.to::<u32>())
                    .filter(|&bps| (1..=10_000).contains(&bps))
            } else {
                None
            };
            let factory = if results[base + 4].success {
                IV2Pool::factoryCall::abi_decode_returns(&results[base + 4].returnData[..])
                    .ok()
            } else {
                None
            };
            Some((
                p,
                U256::from(reserves.reserve0),
                U256::from(reserves.reserve1),
                token0,
                token1,
                resolve_v2_fee_bps(
                    swap_fee,
                    factory,
                    self.pool_config_fee_bps(&p),
                    self.chain_id,
                ),
            ))
        }));
        out
    }

    /// Config fee (bps) for a pool, when declared — V3 pools keep their fee
    /// in raw hundredths-of-a-bip units (config bps × 100).
    fn pool_config_fee_raw(&self, pool: &Address) -> Option<u32> {
        self.pool_configs
            .read()
            .unwrap()
            .iter()
            .find(|pc| pc.address == *pool)
            .map(|pc| pc.fee_bps)
            .filter(|&bps| bps > 0)
            .map(|bps| bps.saturating_mul(100))
    }

    /// Declared config fee in plain bps — the units V2 (and AeroV2) quote in.
    /// 0 means "unset" (feed-registered pools declare no fee).
    fn pool_config_fee_bps(&self, pool: &Address) -> u32 {
        self.pool_configs
            .read()
            .unwrap()
            .iter()
            .find(|pc| pc.address == *pool)
            .map(|pc| pc.fee_bps)
            .unwrap_or(0)
    }

    /// Multicall3 read for V3 pools: slot0 + liquidity + fee + tokens in
    /// ONE aggregate3 round-trip, allowFailure per call. Pools with config
    /// tokens + declared fee only need the dynamic slot0/liquidity reads.
    async fn multicall_v3(
        &self,
        pools: &[Address],
    ) -> Vec<(Address, U256, i32, u128, u32, Address, Address)> {
        use alloy_sol_types::SolCall;
        let mut out = Vec::with_capacity(pools.len());

        let (slim, full): (Vec<Address>, Vec<Address>) = pools
            .iter()
            .copied()
            .partition(|p| self.pool_tokens(p).is_some() && self.pool_config_fee_raw(p).is_some());

        if !slim.is_empty() {
            let calls: Vec<IMulticall3::Call3> = slim
                .iter()
                .flat_map(|&p| {
                    [
                        IV3Pool::slot0Call::new(()).abi_encode().into(),
                        IV3Pool::liquidityCall::new(()).abi_encode().into(),
                    ]
                    .map(|call_data| IMulticall3::Call3 {
                        target: p,
                        allowFailure: true,
                        callData: call_data,
                    })
                })
                .collect();
            let results = self.multicall_aggregate3(calls).await;
            let _dt = self.decode_timer("mc_v3");
            if results.len() == slim.len() * 2 {
                for (i, &p) in slim.iter().enumerate() {
                    let s = &results[i * 2];
                    let l = &results[i * 2 + 1];
                    if !(s.success && l.success) {
                        continue;
                    }
                    let (Some((t0, t1)), Some(fee)) =
                        (self.pool_tokens(&p), self.pool_config_fee_raw(&p))
                    else {
                        continue;
                    };
                    let (Some((sqrt_p, tick)), Ok(liq)) = (
                        self.decode_v3_slot0(&p, &s.returnData[..]),
                        IV3Pool::liquidityCall::abi_decode_returns(&l.returnData[..]),
                    ) else {
                        continue;
                    };
                    out.push((p, sqrt_p, tick, liq, fee, t0, t1));
                }
            }
        }

        if full.is_empty() {
            return out;
        }
        let calls: Vec<IMulticall3::Call3> = full
            .iter()
            .flat_map(|&p| {
                [
                    IV3Pool::slot0Call::new(()).abi_encode().into(),
                    IV3Pool::liquidityCall::new(()).abi_encode().into(),
                    IV3Pool::feeCall::new(()).abi_encode().into(),
                    IV3Pool::token0Call::new(()).abi_encode().into(),
                    IV3Pool::token1Call::new(()).abi_encode().into(),
                ]
                .map(|call_data| IMulticall3::Call3 {
                    target: p,
                    allowFailure: true,
                    callData: call_data,
                })
            })
            .collect();
        let results = self.multicall_aggregate3(calls).await;
        let _dt = self.decode_timer("mc_v3");
        if results.len() != full.len() * 5 {
            return out;
        }
        out.extend(full.iter().enumerate().filter_map(|(i, &p)| {
            let base = i * 5;
            let s = results.get(base)?;
            let l = results.get(base + 1)?;
            let f = results.get(base + 2)?;
            let t0 = results.get(base + 3)?;
            let t1 = results.get(base + 4)?;
            if !(s.success && l.success && f.success && t0.success && t1.success) {
                return None;
            }
            let (sqrt_p, tick) = self.decode_v3_slot0(&p, &s.returnData[..])?;
            let liq = IV3Pool::liquidityCall::abi_decode_returns(&l.returnData[..]).ok()?;
            let fee = IV3Pool::feeCall::abi_decode_returns(&f.returnData[..]).ok()?;
            let token0 = IV3Pool::token0Call::abi_decode_returns(&t0.returnData[..]).ok()?;
            let token1 = IV3Pool::token1Call::abi_decode_returns(&t1.returnData[..]).ok()?;
            Some((p, sqrt_p, tick, liq, fee.to::<u32>(), token0, token1))
        }));
        out
    }

    /// Multicall3 read for V4 pools: one extsload([slot0, liquidity]) call
    /// per spec against its PoolManager — the ONLY V4 read path (UniV4's
    /// manager has no view getters; verified live on BSC). slot0 packs
    /// sqrtPriceX96(160)|tick(i24)|protocolFee(u24)|lpFee(u24); the lpFee is
    /// authoritative (dynamic-fee pools report the resolved fee there).
    /// Tokens still come from config (PoolConfig keyed by pseudo addr).
    /// Returns (pseudo_addr, sqrt_price_x96, tick, liquidity, lp_fee).
    async fn multicall_v4(
        &self,
        specs: &[V4PoolSpec],
    ) -> Vec<(Address, U256, i32, u128, u32)> {
        use alloy_sol_types::SolCall;
        let mut out = Vec::with_capacity(specs.len());
        let calls: Vec<IMulticall3::Call3> = specs
            .iter()
            .map(|sp| {
                let slot0 = sp.pool_slot();
                let liq = sp.liquidity_slot();
                IMulticall3::Call3 {
                    target: sp.manager,
                    allowFailure: true,
                    callData: IExtsload::extsloadCall::new((vec![slot0, liq],))
                        .abi_encode()
                        .into(),
                }
            })
            .collect();
        let results = self.multicall_aggregate3(calls).await;
        let _dt = self.decode_timer("mc_v4");
        if results.len() != specs.len() {
            return out;
        }
        for (i, sp) in specs.iter().enumerate() {
            let r = &results[i];
            if !r.success {
                continue;
            }
            let Ok(words) = IExtsload::extsloadCall::abi_decode_returns(&r.returnData[..]) else {
                continue;
            };
            if words.len() != 2 {
                continue;
            }
            // slot0 packing (v4-core Slot0): sqrtPriceX96 @bits 0-159,
            // tick @160-183, protocolFee @184-207, lpFee @208-231.
            let w = U256::from_be_bytes(*words[0]);
            let sqrt_p = w & ((U256::from(1u64) << 160) - U256::from(1u64));
            let t = ((w >> 160usize) & U256::from(0xFFFFFFu32)).to::<u32>();
            let tick = if t >= 0x800000 { t.wrapping_sub(0x1000000) as i32 } else { t as i32 };
            let lp_fee = ((w >> 208usize) & U256::from(0xFFFFFFu32)).to::<u32>();
            let liq = U256::from_be_bytes(*words[1]).to::<u128>();
            out.push((sp.address, sqrt_p, tick, liq, lp_fee));
        }
        out
    }

    /// Decode a globalState() return — two Algebra generations share the
    /// selector: v1.9 returns 7 words with a single `fee`, Integral returns
    /// 8 words with per-direction feeZto/feeOtz. Try v1.9 first.
    /// Returns (sqrtPriceX96, tick, feeZto, feeOtz) in V3State field units.
    fn decode_algebra_global_state(data: &[u8]) -> Option<(U256, i32, u32, u32)> {
        use alloy_sol_types::SolCall;
        if let Ok(gs) = IAlgebraPool::globalStateCall::abi_decode_returns(data) {
            let fee = gs.fee as u32;
            return Some((U256::from(gs.price), gs.tick.as_i32(), fee, fee));
        }
        IAlgebraIntegralPool::globalStateCall::abi_decode_returns(data)
            .ok()
            .map(|gs| {
                (
                    U256::from(gs.price),
                    gs.tick.as_i32(),
                    gs.feeZto as u32,
                    gs.feeOtz as u32,
                )
            })
    }

    /// Multicall3 read for Algebra pools: globalState + liquidity in ONE
    /// aggregate3. Algebra replaces slot0() with globalState().
    async fn multicall_algebra(
        &self,
        pools: &[Address],
    ) -> Vec<(Address, U256, i32, u128, u32, u32, Address, Address)> {
        use alloy_sol_types::SolCall;
        let mut out = Vec::with_capacity(pools.len());

        let (slim, full): (Vec<Address>, Vec<Address>) = pools
            .iter()
            .copied()
            .partition(|p| self.pool_tokens(p).is_some());

        if !slim.is_empty() {
            let calls: Vec<IMulticall3::Call3> = slim
                .iter()
                .flat_map(|&p| {
                    [
                        IAlgebraPool::globalStateCall::new(()).abi_encode().into(),
                        IAlgebraPool::liquidityCall::new(()).abi_encode().into(),
                    ]
                    .map(|call_data| IMulticall3::Call3 {
                        target: p,
                        allowFailure: true,
                        callData: call_data,
                    })
                })
                .collect();
            let results = self.multicall_aggregate3(calls).await;
            let _dt = self.decode_timer("mc_algebra");
            if results.len() == slim.len() * 2 {
                for (i, &p) in slim.iter().enumerate() {
                    let s = &results[i * 2];
                    let l = &results[i * 2 + 1];
                    if !(s.success && l.success) {
                        continue;
                    }
                    let Some((t0, t1)) = self.pool_tokens(&p) else {
                        continue;
                    };
                    let (Some((sqrt_p, tick, fee_zto, fee_otz)), Ok(liq)) = (
                        Self::decode_algebra_global_state(&s.returnData[..]),
                        IAlgebraPool::liquidityCall::abi_decode_returns(&l.returnData[..]),
                    ) else {
                        continue;
                    };
                    out.push((p, sqrt_p, tick, liq, fee_zto, fee_otz, t0, t1));
                }
            }
        }

        if full.is_empty() {
            return out;
        }
        let calls: Vec<IMulticall3::Call3> = full
            .iter()
            .flat_map(|&p| {
                [
                    IAlgebraPool::globalStateCall::new(()).abi_encode().into(),
                    IAlgebraPool::liquidityCall::new(()).abi_encode().into(),
                    IAlgebraPool::token0Call::new(()).abi_encode().into(),
                    IAlgebraPool::token1Call::new(()).abi_encode().into(),
                ]
                .map(|call_data| IMulticall3::Call3 {
                    target: p,
                    allowFailure: true,
                    callData: call_data,
                })
            })
            .collect();
        let results = self.multicall_aggregate3(calls).await;
        let _dt = self.decode_timer("mc_algebra");
        if results.len() != full.len() * 4 {
            return out;
        }
        out.extend(full.iter().enumerate().filter_map(|(i, &p)| {
            let base = i * 4;
            let s = &results[base];
            let l = &results[base + 1];
            let t0 = &results[base + 2];
            let t1 = &results[base + 3];
            if !(s.success && l.success && t0.success && t1.success) {
                return None;
            }
            let (sqrt_p, tick, fee_zto, fee_otz) =
                Self::decode_algebra_global_state(&s.returnData[..])?;
            let liq = IAlgebraPool::liquidityCall::abi_decode_returns(&l.returnData[..]).ok()?;
            let token0 = IAlgebraPool::token0Call::abi_decode_returns(&t0.returnData[..]).ok()?;
            let token1 = IAlgebraPool::token1Call::abi_decode_returns(&t1.returnData[..]).ok()?;
            Some((p, sqrt_p, tick, liq, fee_zto, fee_otz, token0, token1))
        }));
        out
    }

    /// Multicall3 read for Aerodrome V2 pools: getReserves + stable, plus
    /// ERC20 decimals() on the pair tokens. The pool doesn't expose the
    /// decimals0/1 scale factors the bespoke reader computes — the stable
    /// invariant needs 10^decimals scaling, read from the tokens directly.
    /// Tokens are resolved from config first and shared across pools, so
    /// the decimals calls are deduped (AERO/WETH/USDC appear everywhere).
    async fn multicall_aero(
        &self,
        pools: &[Address],
    ) -> Vec<(Address, U256, U256, Address, Address, bool, U256, U256)> {
        use alloy_sol_types::SolCall;
        use std::collections::{HashMap, HashSet};
        let mut out = Vec::with_capacity(pools.len());

        let mut pool_tokens: Vec<(Address, Address, Address)> = Vec::with_capacity(pools.len());
        let mut need_tokens: Vec<Address> = Vec::new();
        for &p in pools {
            match self.pool_tokens(&p) {
                Some((t0, t1)) => pool_tokens.push((p, t0, t1)),
                None => need_tokens.push(p),
            }
        }
        if !need_tokens.is_empty() {
            let calls: Vec<IMulticall3::Call3> = need_tokens
                .iter()
                .flat_map(|&p| {
                    [
                        IAeroV2Pool::token0Call::new(()).abi_encode().into(),
                        IAeroV2Pool::token1Call::new(()).abi_encode().into(),
                    ]
                    .map(|call_data| IMulticall3::Call3 {
                        target: p,
                        allowFailure: true,
                        callData: call_data,
                    })
                })
                .collect();
            let results = self.multicall_aggregate3(calls).await;
            let _dt = self.decode_timer("mc_aero");
            if results.len() == need_tokens.len() * 2 {
                for (i, &p) in need_tokens.iter().enumerate() {
                    let t0 = &results[i * 2];
                    let t1 = &results[i * 2 + 1];
                    if !(t0.success && t1.success) {
                        continue;
                    }
                    let (Ok(t0), Ok(t1)) = (
                        IAeroV2Pool::token0Call::abi_decode_returns(&t0.returnData[..]),
                        IAeroV2Pool::token1Call::abi_decode_returns(&t1.returnData[..]),
                    ) else {
                        continue;
                    };
                    pool_tokens.push((p, t0, t1));
                }
            }
        }

        let mut unique_tokens: Vec<Address> = Vec::new();
        let mut seen: HashSet<Address> = HashSet::new();
        for (_, t0, t1) in &pool_tokens {
            for t in [*t0, *t1] {
                if seen.insert(t) {
                    unique_tokens.push(t);
                }
            }
        }

        let calls: Vec<IMulticall3::Call3> = pool_tokens
            .iter()
            .flat_map(|(p, _, _)| {
                [
                    IAeroV2Pool::getReservesCall::new(()).abi_encode().into(),
                    IAeroV2Pool::stableCall::new(()).abi_encode().into(),
                ]
                .map(|call_data| IMulticall3::Call3 {
                    target: *p,
                    allowFailure: true,
                    callData: call_data,
                })
            })
            .chain(unique_tokens.iter().map(|&t| IMulticall3::Call3 {
                target: t,
                allowFailure: true,
                callData: IERC20::decimalsCall::new(()).abi_encode().into(),
            }))
            .collect();
        let results = self.multicall_aggregate3(calls).await;
        let _dt = self.decode_timer("mc_aero");
        if results.len() != pool_tokens.len() * 2 + unique_tokens.len() {
            return out;
        }

        let mut scale: HashMap<Address, U256> = HashMap::with_capacity(unique_tokens.len());
        for (i, &t) in unique_tokens.iter().enumerate() {
            let res = &results[pool_tokens.len() * 2 + i];
            if !res.success {
                continue;
            }
            if let Ok(dec) = IERC20::decimalsCall::abi_decode_returns(&res.returnData[..]) {
                scale.insert(t, U256::from(10u64).pow(U256::from(dec)));
            }
        }

        for (i, &(p, t0, t1)) in pool_tokens.iter().enumerate() {
            let res = &results[i * 2];
            let st = &results[i * 2 + 1];
            if !(res.success && st.success) {
                continue;
            }
            // A pool whose token decimals didn't resolve can't scale the
            // stable invariant — drop it rather than quote on bad math.
            let (Some(&d0), Some(&d1)) = (scale.get(&t0), scale.get(&t1)) else {
                continue;
            };
            let (Ok(reserves), Ok(stable)) = (
                IAeroV2Pool::getReservesCall::abi_decode_returns(&res.returnData[..]),
                IAeroV2Pool::stableCall::abi_decode_returns(&st.returnData[..]),
            ) else {
                continue;
            };
            out.push((
                p,
                reserves.reserve0,
                reserves.reserve1,
                t0,
                t1,
                stable,
                d0,
                d1,
            ));
        }
        out
    }

    pub async fn refresh(&self, store: &PoolStore) -> Result<(usize, std::time::Duration)> {
        let start = Instant::now();
        self.rpc_ns.store(0, Ordering::Relaxed);
        self.decode_ns.store(0, Ordering::Relaxed);
        let mut updated = 0;

        let (
            v2_addrs,
            v3_addrs,
            algebra_addrs,
            aero_addrs,
            pcs_stable_addrs,
            wombat_addrs,
            dodo_addrs,
        ) = self.partition_by_type();

        // Each async block picks its own provider from the read pool and fails
        // over to the next healthy endpoint on a transport error (429/timeout).
        // A contract-level error (revert / decode) comes from the deployed
        // reader bytecode itself — the same call fails identically on every
        // remaining chunk and on any other endpoint, so break early instead
        // of burning one RTT per chunk. Total-failure streaks mark the method
        // dead so future refreshes skip it entirely.
        macro_rules! chunk_loop {
            ($label:literal, $chunks:expr, $call:ident, $callty:ident) => {{
                let mut all = Vec::new();
                let mut contract_fail = false;
                let (mut idx, provider) = self.endpoint.pool_pick();
                let mut reader = IStateReader::new(self.state_reader_addr, provider);
                for chunk in &$chunks {
                    let t = Instant::now();
                    match tokio::time::timeout(self.call_deadline, reader.$call(chunk.clone()).call_raw()).await {
                        Ok(Ok(raw)) => {
                            self.note_rpc($label, idx, t.elapsed());
                            let _dt = self.decode_timer($label);
                            match <IStateReader::$callty as alloy_sol_types::SolCall>::abi_decode_returns(&raw[..]) {
                                Ok(states) => all.extend(states),
                                Err(e) => {
                                    warn!(chunk_size = chunk.len(), "{} chunk decode failed: {}", $label, e);
                                    contract_fail = true;
                                    break;
                                }
                            }
                        }
                        outcome => {
                            self.note_rpc($label, idx, t.elapsed());
                            if let Ok(Err(e)) = &outcome {
                                warn!(chunk_size = chunk.len(), "{} chunk read failed: {}", $label, e);
                            } else {
                                warn!(chunk_size = chunk.len(), "{} chunk read timed out ({}ms)", $label, self.call_deadline.as_millis());
                            }
                            let transport_fail = match &outcome {
                                Ok(Err(e)) => arb_rpc::is_contract_transport_error(e),
                                Err(_) => true,
                                _ => false,
                            };
                            if transport_fail {
                                self.endpoint.blacklist_read(idx);
                                let (nidx, np) = self.endpoint.pool_pick();
                                idx = nidx;
                                reader = IStateReader::new(self.state_reader_addr, np);
                                let t2 = Instant::now();
                                match tokio::time::timeout(self.call_deadline, reader.$call(chunk.clone()).call_raw()).await {
                                    Ok(Ok(raw)) => {
                                        self.note_rpc($label, idx, t2.elapsed());
                                        let _dt = self.decode_timer($label);
                                        match <IStateReader::$callty as alloy_sol_types::SolCall>::abi_decode_returns(&raw[..]) {
                                            Ok(states) => all.extend(states),
                                            Err(e) => {
                                                warn!(chunk_size = chunk.len(), "{} chunk retry decode failed: {}", $label, e);
                                                contract_fail = true;
                                            }
                                        }
                                    }
                                    outcome2 => {
                                        self.note_rpc($label, idx, t2.elapsed());
                                        match &outcome2 {
                                            Ok(Err(e2)) => {
                                                warn!(chunk_size = chunk.len(), "{} chunk retry failed: {}", $label, e2);
                                                if arb_rpc::is_contract_transport_error(e2) {
                                                    self.endpoint.blacklist_read(idx);
                                                } else {
                                                    contract_fail = true;
                                                }
                                            }
                                            Err(_) => {
                                                warn!(chunk_size = chunk.len(), "{} chunk retry timed out", $label);
                                                self.endpoint.blacklist_read(idx);
                                            }
                                            _ => {}
                                        }
                                        if contract_fail { break; }
                                    }
                                }
                            } else {
                                contract_fail = true;
                                break;
                            }
                        }
                    }
                }
                if contract_fail && all.is_empty() {
                    self.note_reader_contract_failure($label);
                } else if !all.is_empty() {
                    self.clear_reader_failure($label);
                }
                all
            }};
        }

        let v2_chunks: Vec<_> = v2_addrs
            .chunks(Self::READER_CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        let v3_chunks: Vec<_> = v3_addrs
            .chunks(Self::READER_CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        let algebra_chunks: Vec<_> = algebra_addrs
            .chunks(Self::READER_CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        let aero_chunks: Vec<_> = aero_addrs
            .chunks(Self::READER_CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        let pcs_chunks: Vec<_> = pcs_stable_addrs
            .chunks(Self::READER_CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        let dodo_chunks: Vec<_> = dodo_addrs
            .chunks(Self::READER_CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();

        let wombat_data: Vec<(Address, Address, Address)> = wombat_addrs
            .iter()
            .filter_map(|addr| {
                self.pool_configs
                    .read()
                    .unwrap()
                    .iter()
                    .find(|c| c.address == *addr)
                    .and_then(|c| c.token0.zip(c.token1))
                    .map(|(t0, t1)| (*addr, t0, t1))
            })
            .collect();
        let wombat_pools: Vec<Address> = wombat_data.iter().map(|d| d.0).collect();
        let wombat_t0s: Vec<Address> = wombat_data.iter().map(|d| d.1).collect();
        let wombat_t1s: Vec<Address> = wombat_data.iter().map(|d| d.2).collect();

        // When no bespoke state_reader is configured (zero address), skip the
        // reader path entirely — Multicall3 covers V2/V3/Algebra/AeroV2 reads
        // deployless.
        let reader_live = !self.state_reader_addr.is_zero();
        if !reader_live {
            debug!("state_reader unset — Multicall3 fallback mode (V2/V3/Algebra/AeroV2 reads)");
        }

        // Methods proven dead on the deployed reader (contract-side failure on
        // every chunk for READER_DEAD_AFTER refreshes) are skipped entirely —
        // a guaranteed revert costs a full RTT every block. For V2/V3 the
        // Multicall3 salvage becomes the primary reader and runs inside the
        // same parallel join, so a dead reader adds zero extra round-trips.
        let v2_dead = !reader_live || self.reader_method_dead("readV2");
        let v3_dead = !reader_live || self.reader_method_dead("readV3");
        let algebra_dead = !reader_live || self.reader_method_dead("readAlgebra");
        let aero_dead = !reader_live || self.reader_method_dead("readAeroV2");
        let pcs_dead = !reader_live || self.reader_method_dead("readPcsStable");
        let dodo_dead = !reader_live || self.reader_method_dead("readDodoV2");
        let wombat_dead = !reader_live || self.reader_method_dead("readWombat");

        let (
            v2_results,
            v3_results,
            algebra_results,
            aero_results,
            pcs_results,
            dodo_results,
            wombat_results,
            v2_mc,
            v3_mc,
            algebra_mc,
            aero_mc,
            v4_mc,
            block,
        ) = tokio::join!(
            async {
                if v2_dead {
                    return Vec::new();
                }
                // Dual-decode V2 path: current readers return the 6-field
                // V2State (fee included); legacy deployments return the
                // original 5-field struct, which fails the typed decode
                // and otherwise forces the Multicall3 fallback every
                // block. Read raw returns so a legacy response salvages
                // with the static config fee; a pool with no configured
                // fee is dropped — a fabricated zero fee quotes phantom
                // profits.
                use alloy_sol_types::SolCall;
                // V2State.fee is plain bps (the reader fills it from
                // swapFee(), which reports bps) — not the V3 hundredths-of-a-
                // bip encoding, so pool_config_fee_bps here, not _raw.
                let map_legacy =
                    |v: Vec<IStateReader::V2StateLegacy>| -> Vec<IStateReader::V2State> {
                        v.into_iter()
                            .filter_map(|s| {
                                let fee = self.pool_config_fee_bps(&s.pool);
                                (fee > 0).then(|| IStateReader::V2State {
                                    pool: s.pool,
                                    token0: s.token0,
                                    token1: s.token1,
                                    reserve0: s.reserve0,
                                    reserve1: s.reserve1,
                                    fee,
                                })
                            })
                            .collect()
                    };
                let decode = |raw: &[u8]| -> Option<Vec<IStateReader::V2State>> {
                    match IStateReader::readV2Call::abi_decode_returns(raw) {
                        Ok(v) => Some(v),
                        Err(_) => IStateReader::readV2LegacyCall::abi_decode_returns(raw)
                            .ok()
                            .map(map_legacy),
                    }
                };
                let mut all: Vec<IStateReader::V2State> = Vec::new();
                let mut contract_fail = false;
                let (mut idx, provider) = self.endpoint.pool_pick();
                let mut reader = IStateReader::new(self.state_reader_addr, provider);
                for chunk in &v2_chunks {
                    let t = Instant::now();
                    let res = tokio::time::timeout(
                        self.call_deadline,
                        reader.readV2(chunk.clone()).call_raw(),
                    )
                    .await;
                    match res {
                        Ok(Ok(raw)) => {
                            self.note_rpc("readV2", idx, t.elapsed());
                            let _dt = self.decode_timer("readV2");
                            match decode(&raw[..]) {
                                Some(v) => all.extend(v),
                                None => {
                                    warn!(chunk_size = chunk.len(), "V2 chunk decode failed — neither 6-field nor legacy 5-field layout matched");
                                    contract_fail = true;
                                    break;
                                }
                            }
                        }
                        outcome => {
                            self.note_rpc("readV2", idx, t.elapsed());
                            if let Ok(Err(e)) = &outcome {
                                warn!(chunk_size = chunk.len(), "V2 chunk read failed: {}", e);
                            } else {
                                warn!(
                                    chunk_size = chunk.len(),
                                    "V2 chunk read timed out ({}ms)",
                                    self.call_deadline.as_millis()
                                );
                            }
                            let transport_fail = match &outcome {
                                Ok(Err(e)) => arb_rpc::is_contract_transport_error(e),
                                Err(_) => true,
                                _ => false,
                            };
                            if transport_fail {
                                self.endpoint.blacklist_read(idx);
                                let (nidx, np) = self.endpoint.pool_pick();
                                idx = nidx;
                                reader = IStateReader::new(self.state_reader_addr, np);
                                let t2 = Instant::now();
                                match tokio::time::timeout(
                                    self.call_deadline,
                                    reader.readV2(chunk.clone()).call_raw(),
                                )
                                .await
                                {
                                    Ok(Ok(raw)) => {
                                        self.note_rpc("readV2", idx, t2.elapsed());
                                        let _dt = self.decode_timer("readV2");
                                        match decode(&raw[..]) {
                                            Some(v) => all.extend(v),
                                            None => {
                                                warn!(
                                                    chunk_size = chunk.len(),
                                                    "V2 chunk retry decode failed"
                                                );
                                                contract_fail = true;
                                            }
                                        }
                                    }
                                    outcome2 => {
                                        self.note_rpc("readV2", idx, t2.elapsed());
                                        match &outcome2 {
                                            Ok(Err(e2)) => {
                                                warn!(
                                                    chunk_size = chunk.len(),
                                                    "V2 chunk retry failed: {}", e2
                                                );
                                                if arb_rpc::is_contract_transport_error(e2) {
                                                    self.endpoint.blacklist_read(idx);
                                                } else {
                                                    contract_fail = true;
                                                }
                                            }
                                            Err(_) => {
                                                warn!(
                                                    chunk_size = chunk.len(),
                                                    "V2 chunk retry timed out"
                                                );
                                                self.endpoint.blacklist_read(idx);
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                if contract_fail {
                                    break;
                                }
                            } else {
                                contract_fail = true;
                                break;
                            }
                        }
                    }
                }
                if contract_fail && all.is_empty() {
                    self.note_reader_contract_failure("readV2");
                } else if !all.is_empty() {
                    self.clear_reader_failure("readV2");
                }
                all
            },
            async {
                if v3_dead {
                    Vec::new()
                } else {
                    chunk_loop!("readV3", v3_chunks, readV3, readV3Call)
                }
            },
            async {
                if algebra_dead {
                    Vec::new()
                } else {
                    chunk_loop!("readAlgebra", algebra_chunks, readAlgebra, readAlgebraCall)
                }
            },
            async {
                if aero_dead {
                    Vec::new()
                } else {
                    chunk_loop!("readAeroV2", aero_chunks, readAeroV2, readAeroV2Call)
                }
            },
            async {
                if pcs_dead {
                    Vec::new()
                } else {
                    chunk_loop!(
                        "readPcsStable",
                        pcs_chunks,
                        readPcsStable,
                        readPcsStableCall
                    )
                }
            },
            async {
                if dodo_dead {
                    Vec::new()
                } else {
                    chunk_loop!("readDodoV2", dodo_chunks, readDodoV2, readDodoV2Call)
                }
            },
            async {
                if wombat_dead || wombat_pools.is_empty() {
                    return Vec::new();
                }
                let (idx, provider) = self.endpoint.pool_pick();
                let reader = IStateReader::new(self.state_reader_addr, provider);
                let t = Instant::now();
                match tokio::time::timeout(
                    self.call_deadline,
                    reader
                        .readWombat(wombat_pools.clone(), wombat_t0s.clone(), wombat_t1s.clone())
                        .call_raw(),
                )
                .await
                {
                    Ok(Ok(raw)) => {
                        self.note_rpc("readWombat", idx, t.elapsed());
                        let _dt = self.decode_timer("readWombat");
                        match <IStateReader::readWombatCall as alloy_sol_types::SolCall>::abi_decode_returns(&raw[..]) {
                            Ok(states) => {
                                self.clear_reader_failure("readWombat");
                                states
                            }
                            Err(e) => {
                                warn!("Wombat decode failed: {e}");
                                self.note_reader_contract_failure("readWombat");
                                Vec::new()
                            }
                        }
                    }
                    outcome => {
                        self.note_rpc("readWombat", idx, t.elapsed());
                        if let Ok(Err(e)) = &outcome {
                            warn!("Wombat read failed: {e}");
                        } else {
                            warn!("Wombat read timed out");
                        }
                        let transport_fail = match &outcome {
                            Ok(Err(e)) => arb_rpc::is_contract_transport_error(e),
                            Err(_) => true,
                            _ => false,
                        };
                        if transport_fail {
                            self.endpoint.blacklist_read(idx);
                            let (ridx, np) = self.endpoint.pool_pick();
                            let retry = IStateReader::new(self.state_reader_addr, np);
                            let t2 = Instant::now();
                            match tokio::time::timeout(
                                self.call_deadline,
                                retry
                                    .readWombat(
                                        wombat_pools.clone(),
                                        wombat_t0s.clone(),
                                        wombat_t1s.clone(),
                                    )
                                    .call_raw(),
                            )
                            .await
                            {
                                Ok(Ok(raw)) => {
                                    self.note_rpc("readWombat", ridx, t2.elapsed());
                                    let _dt = self.decode_timer("readWombat");
                                    match <IStateReader::readWombatCall as alloy_sol_types::SolCall>::abi_decode_returns(&raw[..]) {
                                        Ok(states) => states,
                                        Err(e) => {
                                            warn!("Wombat retry decode failed: {e}");
                                            self.note_reader_contract_failure("readWombat");
                                            Vec::new()
                                        }
                                    }
                                }
                                outcome2 => {
                                    self.note_rpc("readWombat", ridx, t2.elapsed());
                                    match &outcome2 {
                                        Ok(Err(e2)) => {
                                            warn!("Wombat retry failed: {e2}");
                                            if !arb_rpc::is_contract_transport_error(e2) {
                                                self.note_reader_contract_failure("readWombat");
                                            }
                                        }
                                        Err(_) => warn!("Wombat retry timed out"),
                                        _ => {}
                                    }
                                    Vec::new()
                                }
                            }
                        } else {
                            self.note_reader_contract_failure("readWombat");
                            Vec::new()
                        }
                    }
                }
            },
            async {
                // Primary Multicall3 read when the V2 reader path is dead or unset.
                if !v2_dead {
                    return Vec::new();
                }
                let parts = futures::future::join_all(
                    v2_addrs
                        .chunks(Self::CHUNK_SIZE)
                        .map(|c| self.multicall_v2(c)),
                )
                .await;
                parts.concat()
            },
            async {
                if !v3_dead {
                    return Vec::new();
                }
                let parts = futures::future::join_all(
                    v3_addrs
                        .chunks(Self::CHUNK_SIZE)
                        .map(|c| self.multicall_v3(c)),
                )
                .await;
                parts.concat()
            },
            async {
                // Same deployless read for Algebra (globalState) when the
                // reader method is dead or unset.
                if !algebra_dead {
                    return Vec::new();
                }
                let parts = futures::future::join_all(
                    algebra_addrs
                        .chunks(Self::CHUNK_SIZE)
                        .map(|c| self.multicall_algebra(c)),
                )
                .await;
                parts.concat()
            },
            async {
                if !aero_dead {
                    return Vec::new();
                }
                let parts = futures::future::join_all(
                    aero_addrs
                        .chunks(Self::CHUNK_SIZE)
                        .map(|c| self.multicall_aero(c)),
                )
                .await;
                parts.concat()
            },
            async {
                // V4 has no reader method — the Multicall3 path is the
                // primary (and only) read, unconditional on reader health.
                if self.v4_pools.is_empty() {
                    return Vec::new();
                }
                self.multicall_v4(&self.v4_pools).await
            },
            async {
                tokio::time::timeout(self.call_deadline, self.endpoint.block_number())
                    .await
                    .ok()
                    .and_then(|r| r.ok())
                    .unwrap_or(0)
            },
        );

        // PoolStore update section: wall time minus the rpc/decode time any
        // Multicall3 salvage inside it still spends.
        let store_start = Instant::now();
        let pre_rpc_ns = self.rpc_ns.load(Ordering::Relaxed);
        let pre_decode_ns = self.decode_ns.load(Ordering::Relaxed);

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

        // Multicall3 results fetched inside the join (primary reader when the
        // deployed reader's method is dead or unset; the only path for V4).
        for (pool, r0, r1, t0, t1, fee_bps) in &v2_mc {
            store.update(
                *pool,
                PoolState::V2(V2PoolState {
                    address: *pool,
                    token0: *t0,
                    token1: *t1,
                    reserve0: *r0,
                    reserve1: *r1,
                    fee_bps: *fee_bps,
                }),
            );
            updated += 1;
        }
        for (pool, sqrt_p, tick, liq, fee, t0, t1) in &v3_mc {
            if sqrt_p.is_zero() {
                continue;
            }
            store.update(
                *pool,
                PoolState::V3(V3PoolState {
                    address: *pool,
                    token0: *t0,
                    token1: *t1,
                    sqrt_price_x96: *sqrt_p,
                    tick: *tick,
                    liquidity: *liq,
                    fee: *fee,
                    fee_otz: None,
                }),
            );
            updated += 1;
        }
        for (pool, sqrt_p, tick, liq, fee_zto, fee_otz, t0, t1) in &algebra_mc {
            if sqrt_p.is_zero() {
                continue;
            }
            store.update(
                *pool,
                PoolState::V3(V3PoolState {
                    address: *pool,
                    token0: *t0,
                    token1: *t1,
                    sqrt_price_x96: *sqrt_p,
                    tick: *tick,
                    liquidity: *liq,
                    fee: *fee_zto,
                    fee_otz: Some(*fee_otz),
                }),
            );
            updated += 1;
        }
        for (pool, r0, r1, t0, t1, stable, dec0, dec1) in &aero_mc {
            store.update(
                *pool,
                PoolState::AeroV2(AeroV2PoolState {
                    address: *pool,
                    token0: *t0,
                    token1: *t1,
                    reserve0: *r0,
                    reserve1: *r1,
                    stable: *stable,
                    fee_bps: self.fee_for_pool(pool),
                    decimals0: *dec0,
                    decimals1: *dec1,
                }),
            );
            updated += 1;
        }

        // V4 pools: token0/token1 always come from config — the PoolManager
        // carries currencies but config order is the enumeration order, so
        // an entry with no configured tokens drops out.
        for (pool, sqrt_p, tick, liq, lp_fee) in &v4_mc {
            if sqrt_p.is_zero() {
                continue;
            }
            let Some((t0, t1)) = self.pool_tokens(pool) else {
                continue;
            };
            store.update(
                *pool,
                PoolState::V3(V3PoolState {
                    address: *pool,
                    token0: t0,
                    token1: t1,
                    sqrt_price_x96: *sqrt_p,
                    tick: *tick,
                    liquidity: *liq,
                    fee: *lp_fee,
                    fee_otz: None,
                }),
            );
            updated += 1;
        }

        // Multicall3 salvage: pools the reader missed (partial chunk failures).
        // Sequential — runs only when a live reader left gaps, which is rare.
        // per-pool allowFailure so dead pools drop out instead of sinking
        // the batch.
        {
            use std::collections::HashSet;
            let mut seen_v2: HashSet<Address> = v2_results.iter().map(|s| s.pool).collect();
            seen_v2.extend(v2_mc.iter().map(|t| t.0));
            let missing_v2: Vec<Address> = v2_addrs
                .iter()
                .copied()
                .filter(|a| !seen_v2.contains(a))
                .collect();
            if !missing_v2.is_empty() {
                let mut salvaged = 0usize;
                for chunk in missing_v2.chunks(Self::CHUNK_SIZE) {
                    for (pool, r0, r1, t0, t1, fee_bps) in self.multicall_v2(chunk).await {
                        store.update(
                            pool,
                            PoolState::V2(V2PoolState {
                                address: pool,
                                token0: t0,
                                token1: t1,
                                reserve0: r0,
                                reserve1: r1,
                                fee_bps,
                            }),
                        );
                        updated += 1;
                        salvaged += 1;
                    }
                }
                if salvaged > 0 {
                    debug!(
                        salvaged,
                        missing = missing_v2.len(),
                        "Multicall3 V2 salvage"
                    );
                }
            }

            let mut seen_v3: HashSet<Address> = v3_results.iter().map(|s| s.pool).collect();
            seen_v3.extend(v3_mc.iter().map(|t| t.0));
            let missing_v3: Vec<Address> = v3_addrs
                .iter()
                .copied()
                .filter(|a| !seen_v3.contains(a))
                .collect();
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
                    debug!(
                        salvaged,
                        missing = missing_v3.len(),
                        "Multicall3 V3 salvage"
                    );
                }
            }

            let mut seen_algebra: HashSet<Address> =
                algebra_results.iter().map(|s| s.pool).collect();
            seen_algebra.extend(algebra_mc.iter().map(|t| t.0));
            let missing_algebra: Vec<Address> = algebra_addrs
                .iter()
                .copied()
                .filter(|a| !seen_algebra.contains(a))
                .collect();
            if !missing_algebra.is_empty() {
                let mut salvaged = 0usize;
                for chunk in missing_algebra.chunks(Self::CHUNK_SIZE) {
                    for (pool, sqrt_p, tick, liq, fee_zto, fee_otz, t0, t1) in
                        self.multicall_algebra(chunk).await
                    {
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
                                fee: fee_zto,
                                fee_otz: Some(fee_otz),
                            }),
                        );
                        updated += 1;
                        salvaged += 1;
                    }
                }
                if salvaged > 0 {
                    debug!(
                        salvaged,
                        missing = missing_algebra.len(),
                        "Multicall3 Algebra salvage"
                    );
                }
            }

            let mut seen_aero: HashSet<Address> = aero_results.iter().map(|s| s.pool).collect();
            seen_aero.extend(aero_mc.iter().map(|t| t.0));
            let missing_aero: Vec<Address> = aero_addrs
                .iter()
                .copied()
                .filter(|a| !seen_aero.contains(a))
                .collect();
            if !missing_aero.is_empty() {
                let mut salvaged = 0usize;
                for chunk in missing_aero.chunks(Self::CHUNK_SIZE) {
                    for (pool, r0, r1, t0, t1, stable, dec0, dec1) in
                        self.multicall_aero(chunk).await
                    {
                        store.update(
                            pool,
                            PoolState::AeroV2(AeroV2PoolState {
                                address: pool,
                                token0: t0,
                                token1: t1,
                                reserve0: r0,
                                reserve1: r1,
                                stable,
                                fee_bps: self.fee_for_pool(&pool),
                                decimals0: dec0,
                                decimals1: dec1,
                            }),
                        );
                        updated += 1;
                        salvaged += 1;
                    }
                }
                if salvaged > 0 {
                    debug!(
                        salvaged,
                        missing = missing_aero.len(),
                        "Multicall3 AeroV2 salvage"
                    );
                }
            }
        }

        store.set_block(block);

        let store_phase = store_start
            .elapsed()
            .checked_sub(std::time::Duration::from_nanos(
                self.rpc_ns.load(Ordering::Relaxed) - pre_rpc_ns,
            ))
            .and_then(|d| {
                d.checked_sub(std::time::Duration::from_nanos(
                    self.decode_ns.load(Ordering::Relaxed) - pre_decode_ns,
                ))
            })
            .unwrap_or_default();

        let elapsed = start.elapsed();
        REFRESH_PHASE_SECONDS
            .with_label_values(&["rpc"])
            .observe(self.rpc_ns.load(Ordering::Relaxed) as f64 / 1e9);
        REFRESH_PHASE_SECONDS
            .with_label_values(&["decode"])
            .observe(self.decode_ns.load(Ordering::Relaxed) as f64 / 1e9);
        REFRESH_PHASE_SECONDS
            .with_label_values(&["store"])
            .observe(store_phase.as_secs_f64());
        REFRESH_PHASE_SECONDS
            .with_label_values(&["wall"])
            .observe(elapsed.as_secs_f64());
        debug!(
            updated,
            elapsed_ms = elapsed.as_millis(),
            rpc_ms = (self.rpc_ns.load(Ordering::Relaxed) / 1_000_000),
            decode_ms = (self.decode_ns.load(Ordering::Relaxed) / 1_000_000),
            store_ms = store_phase.as_millis(),
            block,
            "State refresh completed"
        );

        Ok((updated, elapsed))
    }

    /// Targeted refresh: re-read only `addrs` via the deployless Multicall3
    /// path — one aggregate3 per protocol class, all concurrent. Used on the
    /// backrun critical path: a full refresh costs an RTT per protocol
    /// partition while a victim's handful of touched pools fits one batch
    /// each. Protocols with no deployless fallback (Curve/Dodo/Wombat)
    /// keep their previous state.
    pub async fn refresh_pools(&self, store: &PoolStore, addrs: &[Address]) -> usize {
        if addrs.is_empty() {
            return 0;
        }
        self.rpc_ns.store(0, Ordering::Relaxed);
        self.decode_ns.store(0, Ordering::Relaxed);
        let t = Instant::now();

        let mut v2 = Vec::new();
        let mut v3 = Vec::new();
        let mut algebra = Vec::new();
        let mut aero = Vec::new();
        let mut v4 = Vec::new();
        for a in addrs {
            match self.pool_protocol(a) {
                Some(Protocol::UniswapV2) => v2.push(*a),
                Some(Protocol::UniswapV3) | Some(Protocol::AerodromeSlipstream) => v3.push(*a),
                Some(Protocol::Algebra) => algebra.push(*a),
                Some(Protocol::AerodromeV2) => aero.push(*a),
                Some(Protocol::UniswapV4) => {
                    if let Some(sp) = self.v4_pools.iter().find(|s| s.address == *a) {
                        v4.push(V4PoolSpec {
                            address: sp.address,
                            pool_id: sp.pool_id,
                            manager: sp.manager,
                        });
                    }
                }
                _ => {}
            }
        }

        let (v2_mc, v3_mc, algebra_mc, aero_mc, v4_mc) = tokio::join!(
            async {
                if v2.is_empty() {
                    Vec::new()
                } else {
                    futures::future::join_all(
                        v2.chunks(Self::CHUNK_SIZE).map(|c| self.multicall_v2(c)),
                    )
                    .await
                    .concat()
                }
            },
            async {
                if v3.is_empty() {
                    Vec::new()
                } else {
                    futures::future::join_all(
                        v3.chunks(Self::CHUNK_SIZE).map(|c| self.multicall_v3(c)),
                    )
                    .await
                    .concat()
                }
            },
            async {
                if algebra.is_empty() {
                    Vec::new()
                } else {
                    futures::future::join_all(
                        algebra
                            .chunks(Self::CHUNK_SIZE)
                            .map(|c| self.multicall_algebra(c)),
                    )
                    .await
                    .concat()
                }
            },
            async {
                if aero.is_empty() {
                    Vec::new()
                } else {
                    futures::future::join_all(
                        aero.chunks(Self::CHUNK_SIZE)
                            .map(|c| self.multicall_aero(c)),
                    )
                    .await
                    .concat()
                }
            },
            async {
                if v4.is_empty() {
                    Vec::new()
                } else {
                    self.multicall_v4(&v4).await
                }
            },
        );

        let mut updated = 0;
        for (pool, r0, r1, t0, t1, fee_bps) in &v2_mc {
            store.update(
                *pool,
                PoolState::V2(V2PoolState {
                    address: *pool,
                    token0: *t0,
                    token1: *t1,
                    reserve0: *r0,
                    reserve1: *r1,
                    fee_bps: *fee_bps,
                }),
            );
            updated += 1;
        }
        for (pool, sqrt_p, tick, liq, fee, t0, t1) in &v3_mc {
            if sqrt_p.is_zero() {
                continue;
            }
            store.update(
                *pool,
                PoolState::V3(V3PoolState {
                    address: *pool,
                    token0: *t0,
                    token1: *t1,
                    sqrt_price_x96: *sqrt_p,
                    tick: *tick,
                    liquidity: *liq,
                    fee: *fee,
                    fee_otz: None,
                }),
            );
            updated += 1;
        }
        for (pool, sqrt_p, tick, liq, fee_zto, fee_otz, t0, t1) in &algebra_mc {
            if sqrt_p.is_zero() {
                continue;
            }
            store.update(
                *pool,
                PoolState::V3(V3PoolState {
                    address: *pool,
                    token0: *t0,
                    token1: *t1,
                    sqrt_price_x96: *sqrt_p,
                    tick: *tick,
                    liquidity: *liq,
                    fee: *fee_zto,
                    fee_otz: Some(*fee_otz),
                }),
            );
            updated += 1;
        }
        for (pool, r0, r1, t0, t1, stable, dec0, dec1) in &aero_mc {
            store.update(
                *pool,
                PoolState::AeroV2(AeroV2PoolState {
                    address: *pool,
                    token0: *t0,
                    token1: *t1,
                    reserve0: *r0,
                    reserve1: *r1,
                    stable: *stable,
                    fee_bps: self.fee_for_pool(pool),
                    decimals0: *dec0,
                    decimals1: *dec1,
                }),
            );
            updated += 1;
        }
        for (pool, sqrt_p, tick, liq, lp_fee) in &v4_mc {
            if sqrt_p.is_zero() {
                continue;
            }
            let Some((t0, t1)) = self.pool_tokens(pool) else {
                continue;
            };
            store.update(
                *pool,
                PoolState::V3(V3PoolState {
                    address: *pool,
                    token0: t0,
                    token1: t1,
                    sqrt_price_x96: *sqrt_p,
                    tick: *tick,
                    liquidity: *liq,
                    fee: *lp_fee,
                    fee_otz: None,
                }),
            );
            updated += 1;
        }

        let wall = t.elapsed();
        REFRESH_PHASE_SECONDS
            .with_label_values(&["wall"])
            .observe(wall.as_secs_f64());
        REFRESH_PHASE_SECONDS
            .with_label_values(&["rpc"])
            .observe(self.rpc_ns.load(Ordering::Relaxed) as f64 / 1e9);
        REFRESH_PHASE_SECONDS
            .with_label_values(&["decode"])
            .observe(self.decode_ns.load(Ordering::Relaxed) as f64 / 1e9);
        debug!(
            pools = addrs.len(),
            updated,
            ms = wall.as_millis(),
            "Targeted pool refresh"
        );
        updated
    }

    fn partition_by_type(
        &self,
    ) -> (
        Vec<Address>,
        Vec<Address>,
        Vec<Address>,
        Vec<Address>,
        Vec<Address>,
        Vec<Address>,
        Vec<Address>,
    ) {
        partition_pools(&self.pool_configs.read().unwrap())
    }

    fn fee_for_pool(&self, pool: &Address) -> u32 {
        let bps = self.pool_config_fee_bps(pool);
        if bps > 0 { bps } else { 30 }
    }
}

/// Classify a pool by its probe triplet — (globalState, slot0, getReserves)
/// in that order. Most-specific interface wins: Algebra forks can answer
/// slot0 on some deployments, so globalState is checked first. A pool must
/// answer with real data (success + ≥1 word) — a bare "no revert" from a
/// fallback function doesn't count.
fn classify_probe_triplet(
    global_state: &IMulticall3::Result3,
    slot0: &IMulticall3::Result3,
    reserves: &IMulticall3::Result3,
) -> Option<Protocol> {
    let answered = |r: &IMulticall3::Result3| r.success && r.returnData.len() >= 32;
    if answered(global_state) {
        Some(Protocol::Algebra)
    } else if answered(slot0) {
        Some(Protocol::UniswapV3)
    } else if answered(reserves) {
        Some(Protocol::UniswapV2)
    } else {
        None
    }
}

/// Merge per-chunk aggregate3 results back into call order. One
/// transport-level batch failure must not zero out the entire refresh —
/// on flaky public endpoints a single bad batch previously dropped EVERY
/// pool in the bucket (measured live: 46/46 priceable Polygon V3 pools
/// went unpriced because one concurrent chunk timed out). A failed chunk
/// yields `success:false` placeholders so per-pool decode filtering drops
/// just its calls; the output length always equals the total call count.
fn merge_aggregate3_parts<'a>(
    chunks: impl Iterator<Item = &'a [IMulticall3::Call3]>,
    parts: Vec<Vec<IMulticall3::Result3>>,
) -> Vec<IMulticall3::Result3> {
    let mut all = Vec::new();
    for (chunk, r) in chunks.zip(parts) {
        if r.is_empty() {
            warn!(calls = chunk.len(), "aggregate3 chunk failed wholesale — marking calls failed");
            all.extend((0..chunk.len()).map(|_| IMulticall3::Result3 {
                success: false,
                returnData: alloy_primitives::Bytes::new(),
            }));
        } else {
            all.extend(r);
        }
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(b: u8) -> Address {
        Address::with_last_byte(b)
    }

    #[test]
    fn test_default_fee_pancakeswap_v2_bsc() {
        let factory: Address = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"
            .parse()
            .unwrap();
        assert_eq!(default_fee_for_factory(factory, 56), Some(25));
    }

    #[test]
    fn test_default_fee_biswap_bsc() {
        let factory: Address = "0x858E3312ed3A876947EA49d572A7C42DE08af7EE"
            .parse()
            .unwrap();
        assert_eq!(default_fee_for_factory(factory, 56), Some(10));
    }

    #[test]
    fn test_default_fee_mdex_bsc() {
        let factory: Address = "0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062b8"
            .parse()
            .unwrap();
        assert_eq!(default_fee_for_factory(factory, 56), Some(30));
    }

    #[test]
    fn test_default_fee_apeswap_bsc() {
        let factory: Address = "0x0841BD0B734E4F5853f0dD8d7Ea989891DBdcFb5"
            .parse()
            .unwrap();
        assert_eq!(default_fee_for_factory(factory, 56), Some(20));
    }

    #[test]
    fn test_default_fee_baseswap_base() {
        let factory: Address = "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB"
            .parse()
            .unwrap();
        assert_eq!(default_fee_for_factory(factory, 8453), Some(25));
    }

    #[test]
    fn test_default_fee_sushiswap_base() {
        let factory: Address = "0x71524B4f93c58fcbF659783284E38825f0622859"
            .parse()
            .unwrap();
        assert_eq!(default_fee_for_factory(factory, 8453), Some(30));
    }

    #[test]
    fn test_default_fee_unknown_factory() {
        assert_eq!(default_fee_for_factory(addr(99), 56), None);
        assert_eq!(default_fee_for_factory(addr(99), 8453), None);
    }

    #[test]
    fn test_default_fee_unknown_chain() {
        let factory: Address = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"
            .parse()
            .unwrap();
        assert_eq!(default_fee_for_factory(factory, 1), None);
    }

    #[test]
    fn test_partition_routes_correctly() {
        let configs = vec![
            PoolConfig {
                address: addr(1),
                protocol: Protocol::UniswapV2,
                fee_bps: 25,
                token0: None,
                token1: None,
            },
            PoolConfig {
                address: addr(2),
                protocol: Protocol::UniswapV3,
                fee_bps: 0,
                token0: None,
                token1: None,
            },
            PoolConfig {
                address: addr(3),
                protocol: Protocol::Algebra,
                fee_bps: 0,
                token0: None,
                token1: None,
            },
            PoolConfig {
                address: addr(4),
                protocol: Protocol::AerodromeV2,
                fee_bps: 30,
                token0: None,
                token1: None,
            },
            PoolConfig {
                address: addr(5),
                protocol: Protocol::PancakeStable,
                fee_bps: 0,
                token0: None,
                token1: None,
            },
            PoolConfig {
                address: addr(6),
                protocol: Protocol::Wombat,
                fee_bps: 0,
                token0: Some(addr(10)),
                token1: Some(addr(11)),
            },
            PoolConfig {
                address: addr(7),
                protocol: Protocol::DodoV2,
                fee_bps: 0,
                token0: None,
                token1: None,
            },
            PoolConfig {
                address: addr(8),
                protocol: Protocol::UniswapV4,
                fee_bps: 0,
                token0: None,
                token1: None,
            },
            PoolConfig {
                address: addr(9),
                protocol: Protocol::AerodromeSlipstream,
                fee_bps: 0,
                token0: None,
                token1: None,
            },
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
        let configs = vec![PoolConfig {
            address: addr(1),
            protocol: Protocol::UniswapV4,
            fee_bps: 0,
            token0: None,
            token1: None,
        }];
        let (v2, v3, algebra, aero, pcs, wombat, dodo) = partition_pools(&configs);
        assert!(
            v2.is_empty()
                && v3.is_empty()
                && algebra.is_empty()
                && aero.is_empty()
                && pcs.is_empty()
                && wombat.is_empty()
                && dodo.is_empty()
        );
    }

    #[test]
    fn test_breaker_dead_after_threshold() {
        let cb = MethodCircuitBreaker::default();
        cb.note_failure("V2");
        assert!(!cb.is_dead("V2"), "one bad refresh must not kill a method");
        cb.note_failure("V2");
        assert!(cb.is_dead("V2"));
        assert!(cb.is_dead("V2"), "dead methods stay dead for the session");
        assert!(!cb.is_dead("V3"), "breakers are per-method");
    }

    #[test]
    fn test_breaker_resets_on_success() {
        let cb = MethodCircuitBreaker::default();
        cb.note_failure("V2");
        cb.note_failure("V2");
        cb.clear("V2");
        assert!(!cb.is_dead("V2"), "a successful read clears the streak");
        cb.note_failure("V2");
        assert!(!cb.is_dead("V2"), "counter restarts — needs a fresh streak");
    }

    fn r3(success: bool, words: usize) -> IMulticall3::Result3 {
        IMulticall3::Result3 {
            success,
            returnData: vec![0u8; words * 32].into(),
        }
    }

    /// LOCKED: feed-lane coverage fix — pools whose dex id can't name the
    /// AMM flavor get probed on-chain instead of dropped. Most-specific
    /// interface wins: Algebra (globalState) before V3 (slot0) before V2
    /// (getReserves); a contract that answers none stays unadmitted.
    #[test]
    fn test_probe_triplet_classification() {
        let dead = r3(false, 0);
        // Real UniV3 pool: globalState reverts, slot0 answers 7 words,
        // getReserves reverts.
        assert_eq!(
            classify_probe_triplet(&dead, &r3(true, 7), &dead),
            Some(Protocol::UniswapV3)
        );
        // Slipstream-style slot0 (6 words) still counts as V3.
        assert_eq!(
            classify_probe_triplet(&dead, &r3(true, 6), &dead),
            Some(Protocol::UniswapV3)
        );
        // Algebra pool that also answers slot0 must classify Algebra —
        // reading it as V3 would miss the dynamic fee.
        assert_eq!(
            classify_probe_triplet(&r3(true, 7), &r3(true, 7), &dead),
            Some(Protocol::Algebra)
        );
        // Plain V2 pool.
        assert_eq!(
            classify_probe_triplet(&dead, &dead, &r3(true, 3)),
            Some(Protocol::UniswapV2)
        );
        // Answered but empty returnData (bare fallback) doesn't count.
        assert_eq!(
            classify_probe_triplet(&dead, &r3(true, 0), &dead),
            None
        );
        // Nothing answers → unadmitted.
        assert_eq!(classify_probe_triplet(&dead, &dead, &dead), None);
    }

    /// LOCKED: aggregate3 batch resilience — a wholesale-failed chunk
    /// must emit `success:false` placeholders (output len == call count,
    /// order preserved), never zero out sibling chunks. Regression lock
    /// for the measured Polygon wipe (6/52 pools priced because one
    /// timed-out chunk nulled the whole V3 bucket).
    #[test]
    fn test_merge_aggregate3_parts_failed_chunk_only_drops_itself() {
        let mk = |n: usize| {
            (0..n)
                .map(|i| IMulticall3::Call3 {
                    target: addr(i as u8 + 1),
                    allowFailure: true,
                    callData: vec![0u8; 4].into(),
                })
                .collect::<Vec<_>>()
        };
        // 60 calls → 2 chunks of 30 (MC3_MAX_CALLS=30). Second chunk's
        // transport dies.
        let calls = mk(60);
        let ok_part: Vec<IMulticall3::Result3> = (0..30).map(|_| r3(true, 1)).collect();
        let merged = merge_aggregate3_parts(
            calls.chunks(StateRefresher::MC3_MAX_CALLS),
            vec![ok_part, Vec::new()],
        );
        assert_eq!(merged.len(), 60);
        assert!(merged[..30].iter().all(|r| r.success));
        assert!(merged[30..].iter().all(|r| !r.success));
        // Chunk ordering is positional — a failed first chunk must not
        // shift later chunks' results onto wrong calls.
        let merged2 = merge_aggregate3_parts(
            calls.chunks(StateRefresher::MC3_MAX_CALLS),
            vec![Vec::new(), (0..30).map(|_| r3(true, 2)).collect()],
        );
        assert_eq!(merged2.len(), 60);
        assert!(merged2[..30].iter().all(|r| !r.success));
        assert!(merged2[30..].iter().all(|r| r.success && r.returnData.len() == 64));
        // Empty tail: fewer parts than chunks (shouldn't happen, but
        // zip must not panic or fabricate results).
        let merged3 = merge_aggregate3_parts(
            calls.chunks(StateRefresher::MC3_MAX_CALLS),
            vec![(0..30).map(|_| r3(true, 1)).collect()],
        );
        assert_eq!(merged3.len(), 30);
    }

    // Locked (2026-10-06): a stored V2 fee of 0 is the "unset" sentinel, NOT a
    // real 0% fee — feed-registered pools carry fee_bps=0 and used to quote
    // every V2 leg at zero fee (measured phantom $0.57–$2.38/candidate on BSC).
    #[test]
    fn test_resolve_v2_fee_never_quotes_zero() {
        // Pair-reported swapFee() wins over everything.
        assert_eq!(resolve_v2_fee_bps(Some(10), Some(addr(9)), 25, 56), 10);
        // PCS V2 pairs have no swapFee() — the factory table supplies the
        // real 25 bps (not the 30 bps generic default).
        let pcs: Address = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"
            .parse()
            .unwrap();
        assert_eq!(resolve_v2_fee_bps(None, Some(pcs), 0, 56), 25);
        // Declared config fee beats the default; zero/missing config and
        // unknown factory both fall to the UniV2 max-common 30 bps.
        assert_eq!(resolve_v2_fee_bps(None, None, 20, 1), 20);
        assert_eq!(resolve_v2_fee_bps(None, None, 0, 1), 30);
        assert_eq!(resolve_v2_fee_bps(None, Some(addr(9)), 0, 56), 30);
        // Unmapped chain: no factory table, still never zero.
        assert_eq!(resolve_v2_fee_bps(None, None, 0, 137), 30);
    }
}
