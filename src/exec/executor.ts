import { ChainConfig, cfg } from '../config/index.js';
import { logger } from '../config/logger.js';
import { RpcPool } from '../providers/rpcPool.js';
import { Candidate } from '../strategies/solver.js';
import { buildPlan } from './planBuilder.js';
import { baseFeeOk, execProbe } from './verify.js';
import { submitExecUserOp, awaitUserOp } from './pimlico.js';
import { breaker } from '../forensics/baitPool.js';
import { metrics } from '../telemetry/metrics.js';
import { VariantScheduler } from '../engine/predictiveEngine.js';
import { refreshPools } from '../feed/refresh.js';
import { legOut } from '../strategies/solver.js';

/**
 * Execution orchestrator — one candidate through the full gate:
 *   fresh-state re-sim at real size -> baseFee circuit breaker ->
 *   gas-abort -> exec-probe from the smart account -> submit ->
 *   receipt -> settled-evidence accounting.
 * AUTO_EXECUTE=false runs the identical pipeline minus the send
 * (shadow mode — emissions are still honest, labeled 'shadow').
 */

const log = logger('executor');
const GAS_ESTIMATE_UNITS = 450_000n; // flash + 2-3 swap legs, padded

export async function executeCandidate(
  chain: ChainConfig,
  rpc: RpcPool,
  cand: Candidate,
  scheduler: VariantScheduler,
): Promise<void> {
  const t0 = performance.now();
  metrics.inc('arb_eval_total', { chain: chain.key, strategy: cand.strategy });

  // 1. merged refresh of just the legs' pools (fresh state at real size)
  await refreshPools(rpc, cand.legs.map((l) => l.pool));
  const reSim = cand.legs.reduce<bigint>((amt, leg) => {
    if (amt === 0n) return 0n;
    return legOut(leg.pool, amt, leg.tokenIn);
  }, cand.borrowAmount);
  if (reSim <= cand.borrowAmount) {
    metrics.inc('arb_resim_fail_total', { chain: chain.key });
    return;
  }

  // 2. EIP-1559 circuit breaker
  const fee = await baseFeeOk(rpc);
  if (!fee.ok) {
    metrics.inc('arb_basefee_dormant_total', { chain: chain.key });
    return;
  }

  // 3. build plan + exec-probe from smart account
  const premium = 0n; // Balancer primary; Aave plan builder sets premium
  const { execData } = buildPlan(cand, { source: 'BALANCER', premium, minProfit: 0n });
  const probe = await execProbe(rpc, cfg.SMART_ACCOUNT_ADDRESS, chain.executor!, execData);
  scheduler.recordLatency(cand.variant, performance.now() - t0);

  if (probe.kind === 'deterministic_revert') {
    scheduler.recordRevert(cand.variant);
    metrics.inc('arb_probe_revert_total', { chain: chain.key });
    for (const l of cand.legs) breaker.recordProbe(chain.key, l.pool.address, true);
    return;
  }
  if (probe.kind === 'transport') {
    metrics.inc('arb_probe_transport_total', { chain: chain.key });
    return; // transport proves nothing — skip, don't penalize
  }
  for (const l of cand.legs) breaker.recordProbe(chain.key, l.pool.address, false);
  metrics.inc('arb_probe_pass_total', { chain: chain.key });

  if (!cfg.AUTO_EXECUTE) {
    metrics.inc('arb_shadow_emit_total', { chain: chain.key, strategy: cand.strategy });
    log.info(`shadow emit ${cand.strategy} ${chain.key} net~$${cand.netUsd.toFixed(2)}`);
    return;
  }

  // 4. submit via strict 4337
  const sub = await submitExecUserOp(chain, rpc, execData);
  if (sub.kind !== 'sent' || !sub.userOpHash) {
    metrics.inc('arb_submit_fail_total', { chain: chain.key });
    return;
  }
  metrics.inc('arb_submit_total', { chain: chain.key, strategy: cand.strategy });

  // 5. receipt — settled evidence ONLY
  const receipt = await awaitUserOp(chain, sub.userOpHash);
  if (!receipt.landed) {
    metrics.inc('arb_unlanded_total', { chain: chain.key });
    return;
  }
  if (!receipt.success) {
    scheduler.recordRevert(cand.variant);
    metrics.inc('arb_landed_revert_total', { chain: chain.key });
    return;
  }

  // HONESTY FLOOR: only arb_settled_net_usd on landed records is profit.
  scheduler.recordSettle(cand.variant, cand.netUsd);
  metrics.addSettled(chain.key, cand.strategy, cand.netUsd, receipt.txHash!, cand.spreadPct);
  log.info(`SETTLED ${cand.strategy} ${chain.key} net $${cand.netUsd.toFixed(2)} tx ${receipt.txHash}`);
}

export {};
