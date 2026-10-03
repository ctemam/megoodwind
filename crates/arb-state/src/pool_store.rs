
use alloy_primitives::Address;
use dashmap::DashMap;
use parking_lot::RwLock;

use arb_core::types::PoolState;

/// Thread-safe in-memory pool state store.
/// Key: pool contract address.
/// Value: latest known on-chain state.
pub struct PoolStore {
    pools: DashMap<Address, PoolState>,
    /// Unix-ms of each pool's last successful refresh. Chunks that time out
    /// or fail leave the timestamp untouched, so pools whose reads keep
    /// failing age out instead of silently simulating on stale state.
    updated: DashMap<Address, u64>,
    last_block: RwLock<u64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl PoolStore {
    pub fn new() -> Self {
        Self {
            pools: DashMap::new(),
            updated: DashMap::new(),
            last_block: RwLock::new(0),
        }
    }

    pub fn update(&self, address: Address, state: PoolState) {
        self.pools.insert(address, state);
        self.updated.insert(address, now_ms());
    }

    /// Insert with an explicit freshness timestamp — projection builders
    /// copy the source store's age so staleness survives into projected
    /// states instead of every pool looking freshly read.
    pub fn update_at(&self, address: Address, state: PoolState, unix_ms: u64) {
        self.pools.insert(address, state);
        self.updated.insert(address, unix_ms);
    }

    pub fn updated_at(&self, address: &Address) -> Option<u64> {
        self.updated.get(address).map(|r| *r.value())
    }

    /// True when the pool's state was never refreshed or is older than
    /// `max_age_ms` — candidate paths through it are evaluating phantom
    /// spreads (the dominant cause of computed-profit → on-chain-revert).
    pub fn is_stale(&self, address: &Address, max_age_ms: u64) -> bool {
        match self.updated_at(address) {
            Some(t) => now_ms().saturating_sub(t) > max_age_ms,
            None => true,
        }
    }

    pub fn get(&self, address: &Address) -> Option<PoolState> {
        self.pools.get(address).map(|r| r.value().clone())
    }

    /// Zero-copy read for the hot eval path: returns a borrow guard, no clone.
    /// `CurvePoolState` contains Vecs — cloning it per hop allocates on the heap
    /// thousands of times per block. Hold the guard only for the hop's duration.
    pub fn get_ref(
        &self,
        address: &Address,
    ) -> Option<dashmap::mapref::one::Ref<'_, Address, PoolState>> {
        self.pools.get(address)
    }

    pub fn get_all(&self) -> Vec<(Address, PoolState)> {
        self.pools
            .iter()
            .map(|r| (*r.key(), r.value().clone()))
            .collect()
    }

    pub fn pool_count(&self) -> usize {
        self.pools.len()
    }

    pub fn set_block(&self, block: u64) {
        *self.last_block.write() = block;
    }

    pub fn last_block(&self) -> u64 {
        *self.last_block.read()
    }

    pub fn clear(&self) {
        self.pools.clear();
    }
}

impl Default for PoolStore {
    fn default() -> Self {
        Self::new()
    }
}
