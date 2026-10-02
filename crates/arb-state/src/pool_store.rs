
use alloy_primitives::Address;
use dashmap::DashMap;
use parking_lot::RwLock;

use arb_core::types::PoolState;

/// Thread-safe in-memory pool state store.
/// Key: pool contract address.
/// Value: latest known on-chain state.
pub struct PoolStore {
    pools: DashMap<Address, PoolState>,
    last_block: RwLock<u64>,
}

impl PoolStore {
    pub fn new() -> Self {
        Self {
            pools: DashMap::new(),
            last_block: RwLock::new(0),
        }
    }

    pub fn update(&self, address: Address, state: PoolState) {
        self.pools.insert(address, state);
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
