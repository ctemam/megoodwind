/** WO-04 economics tests — run: npx tsx test/ci_econ_test.ts */
import { reconstruct } from '../src/ci/economics.js';
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const base = { receiptStatus: 1 as const, gasUsed: 200_000n, effectiveGasPrice: 20_000_000_000n, grossProfitRaw: 100_000_000n, profitDecimals: 6, profitUsdRate: 1.0, ethUsdRate: 3000 };

// T1 reverted tx = failed, gas is the only econ fact
const r1 = reconstruct({ receiptStatus: 0, gasUsed: 150_000n, effectiveGasPrice: 10_000_000_000n, ethUsdRate: 3000 });
ok('T1 reverted → execution_failed + gas cost', r1.status === 'execution_failed' && r1.gasCostUsd === 4.5 && r1.netUsd === undefined);

// T2 gross token gain ≠ net profit claim
const r2 = reconstruct(base);
ok('T2 fully-priced → net estimated|verified, net = gross - gas', (r2.status === 'net_profit_estimated' || r2.status === 'net_profit_verified') && Math.abs((r2.netUsd ?? 0) - (100 - 12)) < 0.01);

// T3 unpriced token → gross stays raw, never USD
const r3 = reconstruct({ ...base, profitUsdRate: undefined });
ok('T3 unpriced → successful_unpriced|gross-less, grossRaw kept, netUsd absent', r3.grossRaw === '100000000' && r3.grossUsd === undefined && r3.netUsd === undefined);

// T4 flash-loan fee deducted (same priced token)
const r4 = reconstruct({ ...base, flashLoan: { provider: 'aave_v3', principalRaw: 10_000_000_000n, repayRaw: 10_009_000_000n, feeRaw: 9_000_000n } });
ok('T4 flash fee subtracted from net', r4.flashFeeUsd === 9 && Math.abs((r4.netUsd ?? 0) - (100 - 12 - 9)) < 0.01);

// T5 no double-count: gas counted once even if fields repeat (single computation)
ok('T5 gas counted once', r2.gasCostUsd === 12);

// T6 builder payment reduces net
const r6 = reconstruct({ ...base, builderPaymentWei: 2_000_000_000_000_000n }); // 0.002 ETH = $6
ok('T6 builder pay deducted', r6.builderPayUsd === 6 && Math.abs((r6.netUsd ?? 0) - (100 - 12 - 6)) < 0.01);

// T7 missing gas price → cost unknown, net blocked
const r7 = reconstruct({ ...base, effectiveGasPrice: undefined });
ok('T7 unobservable gas → net not produced', r7.netUsd === undefined && r7.unknowns.includes('gas_cost_unobservable'));

// T8 unpriced flash fee → net blocked
const r8 = reconstruct({ ...base, flashLoan: { provider: 'balancer', principalRaw: 1n, repayRaw: 1n, feeRaw: 0n } });
ok('T8 zero-fee flash loan still nets', Math.abs((r8.netUsd ?? 0) - (100 - 12)) < 0.01);

// T9 missing eth price → gas unpriced → net blocked even with priced gross
const r9 = reconstruct({ ...base, ethUsdRate: undefined });
ok('T9 eth unpriced → net blocked, explicit unknown', r9.netUsd === undefined && r9.unknowns.includes('eth_price_unavailable'));

// T10 wrong-decimal sanity: 18-dec token raw ≠ USD without decimals
const r10 = reconstruct({ ...base, profitDecimals: 18, grossProfitRaw: 100_000_000_000_000_000_000n });
ok('T10 decimals applied correctly', r10.grossUsd === 100);

// T11 no flash-loan evidence → flagged unknown, not assumed
const r11 = reconstruct(base);
ok('T11 flash_loan_use_unconfirmed present', r11.unknowns.includes('flash_loan_use_unconfirmed'));

// T12 confidence scales with evidence completeness
const r12a = reconstruct({ receiptStatus: 1 });
const r12b = reconstruct({ ...base, builderPaymentWei: 1n });
ok('T12 confidence higher with more evidence', r12b.confidence > r12a.confidence && r12a.status === 'successful_unpriced');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
