//! allbrightA pre-deployment latency profile (spec: <5µs per path evaluation).
//!
//! Measures the real production math kernel (`arb_core::v2::get_amount_out`)
//! over a static stack-allocated 3-hop path — no heap allocation inside the
//! measured loop. Fails the process if a full path eval exceeds 5µs.
//!
//! Usage: RUSTFLAGS="-C target-cpu=native" cargo run --release --bin latency_profile

use std::hint::black_box;
use std::time::Instant;

use alloy_primitives::U256;
use arb_core::v2::get_amount_out;

const ITERATIONS: usize = 10_000;
/// Spec ceiling: sub-5µs per complete 3-hop path evaluation.
const TARGET_NANOS: u128 = 5_000;

struct Hop {
    reserve_in: U256,
    reserve_out: U256,
    fee_bps: u32,
}

fn main() {
    println!("--- Commencing Pre-Deployment Latency Profiling Verification ---");

    // Static path on the stack — mirrors a WBNB/USDT -> USDT/BUSD -> BUSD/WBNB loop.
    let path = [
        Hop { reserve_in: U256::from(50_000_000_000u128), reserve_out: U256::from(55_000_000_000u128), fee_bps: 25 },
        Hop { reserve_in: U256::from(25_000_000_000u128), reserve_out: U256::from(24_000_000_000u128), fee_bps: 25 },
        Hop { reserve_in: U256::from(12_000_000_000u128), reserve_out: U256::from(12_500_000_000u128), fee_bps: 30 },
    ];
    let test_capital = U256::from(500_000_000u128);

    // Warmup: fill instruction/data caches before measuring.
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
}
