//! allbrightA pre-deployment latency profile (spec: <5µs per path evaluation,
//! zero heap allocations inside the calculation cycle).
//!
//! Two benches:
//!  1. Math kernel latency: `arb_core::v2::get_amount_out` over a static
//!     stack-allocated 3-hop path. Fails if a full eval exceeds 5µs.
//!  2. Heap audit: a counting global allocator wraps the REAL production
//!     `evaluate_path` (pool store borrow + per-hop quote dispatch) and
//!     asserts it performs ZERO heap allocations per evaluation.
//!
//! Usage: RUSTFLAGS="-C target-cpu=native" cargo run --release --bin latency_profile

use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use alloy_primitives::{Address, U256};
use arb_core::types::{
    CurvePoolState, PoolState, Protocol, V2PoolState, V3PoolState,
};
use arb_core::v2::get_amount_out;
use arb_paths::{HopTemplate, PathTemplate};
use arb_sim::evaluate::evaluate_path;
use arb_state::pool_store::PoolStore;

const ITERATIONS: usize = 10_000;
/// Spec ceiling: sub-5µs per complete 3-hop path evaluation.
const TARGET_NANOS: u128 = 5_000;

/// Counting allocator: every alloc/realloc/dealloc event is recorded so the
/// eval-cycle heap audit can assert a zero count inside the measured region.
#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

static ALLOC_COUNT: AtomicUsize = AtomicUsize::new(0);

struct CountingAlloc;

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        System.realloc(ptr, layout, new_size)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

struct Hop {
    reserve_in: U256,
    reserve_out: U256,
    fee_bps: u32,
}

fn main() {
    println!("--- Commencing Pre-Deployment Latency Profiling Verification ---");

    // ---- Bench 1: math kernel latency, static stack path ----
    let path = [
        Hop { reserve_in: U256::from(50_000_000_000u128), reserve_out: U256::from(55_000_000_000u128), fee_bps: 25 },
        Hop { reserve_in: U256::from(25_000_000_000u128), reserve_out: U256::from(24_000_000_000u128), fee_bps: 25 },
        Hop { reserve_in: U256::from(12_000_000_000u128), reserve_out: U256::from(12_500_000_000u128), fee_bps: 30 },
    ];
    let test_capital = U256::from(500_000_000u128);

    for _ in 0..1_000 {
        let mut amount = black_box(test_capital);
        for hop in black_box(&path) {
            amount = get_amount_out(amount, hop.reserve_in, hop.reserve_out, hop.fee_bps)
                .expect("quote");
        }
        black_box(amount);
    }

    let start = Instant::now();
    for _ in 0..ITERATIONS {
        let mut amount = black_box(test_capital);
        for hop in black_box(&path) {
            amount = get_amount_out(amount, hop.reserve_in, hop.reserve_out, hop.fee_bps)
                .expect("quote");
        }
        black_box(amount);
    }
    let elapsed = start.elapsed();
    let per_eval_nanos = elapsed.as_nanos() / ITERATIONS as u128;
    println!(
        "[PROFILE CRITERIA] Math kernel: {} iterations of 3-hop eval in {:?} — {}ns per eval",
        ITERATIONS, elapsed, per_eval_nanos
    );
    if per_eval_nanos >= TARGET_NANOS {
        eprintln!(
            "[CRITICAL ACCELERATION ERROR] Engine took {}ns/eval. Threshold ceiling is <5µs. Aborting binary instantiation.",
            per_eval_nanos
        );
        std::process::exit(1);
    }
    println!("[LATENCY PASS] Sub-5 microsecond constraints validated successfully.");

    // ---- Bench 2: zero-allocation audit on the production eval path ----
    // Store holds V2 + V3 + Curve states. CurvePoolState carries Vec fields —
    // the clone-per-read pattern this audit guards against.
    let token_a = Address::from([0x11; 20]);
    let token_b = Address::from([0x22; 20]);
    let token_c = Address::from([0x33; 20]);
    let pool_v2 = Address::from([0xA1; 20]);
    let pool_v3 = Address::from([0xB1; 20]);
    let pool_cv = Address::from([0xC1; 20]);

    let store = PoolStore::new();
    store.update(
        pool_v2,
        PoolState::V2(V2PoolState {
            address: pool_v2,
            token0: token_a,
            token1: token_b,
            reserve0: U256::from(50_000_000_000u128),
            reserve1: U256::from(55_000_000_000u128),
            fee_bps: 25,
        }),
    );
    store.update(
        pool_v3,
        PoolState::V3(V3PoolState {
            address: pool_v3,
            token0: token_b,
            token1: token_c,
            sqrt_price_x96: U256::from(1u128 << 96),
            tick: 0,
            liquidity: 1_000_000_000_000_000,
            fee: 3000,
            fee_otz: None,
        }),
    );
    store.update(
        pool_cv,
        PoolState::Curve(CurvePoolState {
            address: pool_cv,
            tokens: vec![token_c, token_a],
            balances: vec![U256::from(30_000_000_000u128), U256::from(31_000_000_000u128)],
            amp: U256::from(100u32),
            fee: U256::from(400_000u64),
        }),
    );

    let tpl = PathTemplate {
        id: 1,
        flash_token: token_a,
        flash_amount: test_capital,
        hops: vec![
            HopTemplate { protocol: Protocol::UniswapV2, pool: pool_v2, token_in: token_a, token_out: token_b },
            HopTemplate { protocol: Protocol::UniswapV3, pool: pool_v3, token_in: token_b, token_out: token_c },
            HopTemplate { protocol: Protocol::PancakeStable, pool: pool_cv, token_in: token_c, token_out: token_a },
        ],
    };

    for _ in 0..1_000 {
        black_box(evaluate_path(black_box(&tpl), black_box(&store)));
    }

    ALLOC_COUNT.store(0, Ordering::Relaxed);
    let start = Instant::now();
    for _ in 0..ITERATIONS {
        black_box(evaluate_path(black_box(&tpl), black_box(&store)));
    }
    let elapsed = start.elapsed();
    let allocs = ALLOC_COUNT.load(Ordering::Relaxed);
    let per_eval_nanos = elapsed.as_nanos() / ITERATIONS as u128;

    println!(
        "[HEAP AUDIT] evaluate_path: {} iterations in {:?} — {}ns per eval, {} heap events total",
        ITERATIONS, elapsed, per_eval_nanos, allocs
    );
    if allocs != 0 {
        eprintln!(
            "[CRITICAL HEAP ERROR] {} allocations inside the evaluation cycle. The scan loop must be heap-free.",
            allocs
        );
        std::process::exit(1);
    }
    println!("[HEAP PASS] Zero allocations per evaluation verified.");
}
