import { ChainConfig, cfg } from '../config/index.js';
import { logger } from '../config/logger.js';
import { RpcPool } from '../providers/rpcPool.js';
import { Candidate } from '../strategies/solver.js';
import { buildPlan } from './planBuilder.js';
import { pickFlashSource, flashPremium } from './flashVenues.js';
import { baseFeeOk, execProbe } from './verify.js';
import { submitExecUserOp, awaitUserOp } from './pimlico.js';
import { sendUserOpViaFlashbots } from './privateRoute.js';
import { flashbotsAvailable } from './flashbots.js';
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

  // 3. build plan + exec-probe from smart account — fee-free capital
  //    preferred: Balancer > Morpho > Maker(DAI) > Aave (0.09% last resort)
  const source = pickFlashSource(chain.key, cand.borrowToken);
  const premium = flashPremium(source, cand.borrowAmount);
  // minProfit binds the lane floor on-chain (whale plans also fold it
  // into last-hop minOut) — a decayed fill reverts instead of settling
  // below the floor that qualified the candidate.
  const { execData } = buildPlan(cand, { source, premium, minProfit: cand.minProfitToken });
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

  // 4. submit via strict 4337 — private rail first on eth (Flashbots
  //    bundle/private-tx wraps the signed UserOp in a handleOps carrier
  //    tx; mempool never sees it). Fallback to Pimlico on failure.
  if (flashbotsAvailable(chain)) {
    const priv = await sendUserOpViaFlashbots(chain, rpc, execData);
    if (priv.kind === 'sent') {
      metrics.inc('arb_submit_total', { chain: chain.key, strategy: cand.strategy });
      metrics.inc('arb_submit_private_total', { chain: chain.key, strategy: cand.strategy });
      log.info(`PRIVATE submit ${cand.strategy} ${chain.key} bundle=${priv.bundleHash ?? priv.txHash}`);
      const rc = await awaitTxReceipt(rpc, priv.txHash!);
      if (!rc.landed) { metrics.inc('arb_unlanded_total', { chain: chain.key }); return; }
      if (!rc.success) { scheduler.recordRevert(cand.variant); metrics.inc('arb_landed_revert_total', { chain: chain.key }); return; }
      scheduler.recordSettle(cand.variant, cand.netUsd);
      metrics.addSettled(chain.key, cand.strategy, cand.netUsd, rc.txHash!, cand.spreadPct);
      log.info(`SETTLED(private) ${cand.strategy} ${chain.key} net $${cand.netUsd.toFixed(2)} tx ${rc.txHash}`);
      return;
    }
    if (priv.kind === 'failed') {
      log.warn(`private route failed (${priv.reason}) — falling back to Pimlico`);
      metrics.inc('arb_private_fallback_total', { chain: chain.key });
    }
  }
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

/** Poll eth_getTransactionReceipt on the carrier tx — the private rail's
 *  settled-evidence path (same honesty floor as the UserOp receipt). */
async function awaitTxReceipt(
  rpc: RpcPool,
  txHash: string,
  timeoutMs = 60_000,
): Promise<{ landed: boolean; success: boolean; txHash?: string }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await rpc.call<{ status?: string; transactionHash?: string } | null>(
        'eth_getTransactionReceipt',
        [txHash],
      );
      if (r?.transactionHash) {
        return { landed: true, success: r.status === '0x1', txHash: r.transactionHash };
      }
    } catch {
      /* transport — keep polling */
    }
    await new Promise((res) => setTimeout(res, 3_000));
  }
  return { landed: false, success: false };
}

export {};
