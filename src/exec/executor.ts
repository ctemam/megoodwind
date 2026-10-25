import { ChainConfig, cfg, armedFor } from '../config/index.js';
import { logger } from '../config/logger.js';
import { RpcPool } from '../providers/rpcPool.js';
import { Candidate } from '../strategies/solver.js';
import { buildPlan } from './planBuilder.js';
import { pickFlashSource, flashPremium } from './flashVenues.js';
import { baseFeeOk, execProbe, gasProbe } from './verify.js';
import { submitExecUserOp, awaitUserOp } from './pimlico.js';
import { sendUserOpViaFlashbots } from './privateRoute.js';
import { mayExecute, dayNotionalUsd, noteNotional, recordLoss } from '../ops/killSwitch.js';
import { LatencyTracker } from '../speed/latency.js';
import { flashbotsAvailable } from './flashbots.js';
import { breaker, peerDivergence } from '../forensics/baitPool.js';
import { routeGasUnits } from './gasModel.js';
import { diagRecord } from '../telemetry/diagLog.js';
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
  // DIAG_ONLY hard-stop: refused here at the single funnel to the send
  // path, not merely by the AUTO_EXECUTE flag — submitExecUserOp,
  // submitUserOp and the Flashbots rail are all structurally unreachable.
  if (cfg.DIAG_ONLY) { metrics.inc('diag_exec_skipped', { chain: chain.key }); return; }
  const t0 = performance.now();
  const lat = new LatencyTracker(chain.key);
  lat.detect();
  metrics.inc('arb_eval_total', { chain: chain.key, strategy: cand.strategy });
  scheduler.recordEmit(cand.variant); // scheduler evidence — unlocks the
  // emitted>=5 settled-score pick (was never called: permanent round-robin)

  // 1. merged refresh of just the legs' pools (fresh state at real size)
  await refreshPools(rpc, cand.legs.map((l) => l.pool));
  const reSim = cand.legs.reduce<bigint>((amt, leg) => {
    if (amt === 0n) return 0n;
    return legOut(leg.pool, amt, leg.tokenIn);
  }, cand.borrowAmount);
  lat.solved();
  if (reSim <= cand.borrowAmount) {
    metrics.inc('arb_resim_fail_total', { chain: chain.key });
    lat.emit('filtered', { path: cand.legs.map((l) => l.pool.address.toLowerCase()).join('>') });
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
  lat.probed();

  if (probe.kind === 'deterministic_revert') {
    scheduler.recordRevert(cand.variant);
    metrics.inc('arb_probe_revert_total', { chain: chain.key });
    // attribute the revert: stats on every leg, but convict ONLY legs
    // divergent from same-pair peers — a blanket all-leg conviction
    // permanently bans honest co-leg pools that routed through the liar.
    // Non-attributed reverts still convict via recordProbe 3-strikes.
    for (const l of cand.legs) {
      breaker.recordProbe(chain.key, l.pool.address, true);
      if (peerDivergence(chain.key, l.pool) > 3) {
        breaker.convict(chain.key, l.pool.address, 'exec_probe_revert_divergent');
      }
    }
    lat.emit('revert', { path: cand.legs.map((l) => l.pool.address.toLowerCase()).join('>') });
    return;
  }
  if (probe.kind === 'transport') {
    metrics.inc('arb_probe_transport_total', { chain: chain.key });
    lat.emit('timeout', { path: cand.legs.map((l) => l.pool.address.toLowerCase()).join('>'), note: 'transport' });
    return; // transport proves nothing — skip, don't penalize
  }
  for (const l of cand.legs) breaker.recordProbe(chain.key, l.pool.address, false);
  metrics.inc('arb_probe_pass_total', { chain: chain.key });

  // WO-5: where gasProbe returns a live estimateGas for THIS execData,
  // prefer it over the route-table constant — re-check economics with
  // measured gas before spending a slot. Margin applied to the estimate
  // so a noisy est can't slide a marginal path through.
  const gp = await gasProbe(rpc, cfg.SMART_ACCOUNT_ADDRESS, chain.executor!, execData);
  if (gp !== null) {
    const modelUnits = routeGasUnits(cand.legs, cfg.GAS_MARGIN_BPS);
    const estUnits = (gp * (10_000n + BigInt(cfg.GAS_MARGIN_BPS))) / 10_000n;
    const prio = BigInt(Math.floor(cfg.PRIORITY_FEE_GWEI * 1e9));
    const estGasUsd = (Number(estUnits * (fee.baseFeeWei + prio)) / 1e18) * cfg.NATIVE_USD;
    const estNet = cand.grossUsd - cand.premiumUsd - estGasUsd;
    if (cfg.DIAG_ONLY) diagRecord('gas_model_vs_estimate', {
      chain: chain.key, path: cand.legs.map((l) => l.pool.address.toLowerCase()).join('>'),
      modelUnits: modelUnits.toString(), estimate: gp.toString(),
      modelGasUsd: cand.gasUsd, estGasUsd, estNetUsd: estNet, solverNetUsd: cand.netUsd,
    });
    const floorUsd = Math.max(cfg.MIN_PROFIT_USD, cand.lane === 'whale' ? cfg.WHALE_MIN_PROFIT_USD : cfg.PREDICTIVE_MIN_PROFIT_USD);
    if (estNet < floorUsd) {
      metrics.inc('exec_gas_recheck_reject', { chain: chain.key });
      log.warn(`gas re-check kill ${cand.strategy} ${chain.key} estNet $${estNet.toFixed(2)} < floor $${floorUsd}`);
      return;
    }
  }

  if (!armedFor(chain.chainId)) {
    metrics.inc('arb_shadow_emit_total', { chain: chain.key, strategy: cand.strategy });
    log.info(`shadow emit ${cand.strategy} ${chain.key} net~$${cand.netUsd.toFixed(2)}`);
    return;
  }

  // WO-15 ops gate — kill file / daily loss breaker / capital caps.
  // Between arm and submit so a hot file edit halts the next submit.
  const gate = mayExecute(chain.key, cand.borrowUsd ?? 0, {
    dailyLossCap: cfg.OPS_DAILY_LOSS_CAP_USD,
    perTxCap: cfg.OPS_PER_TX_CAP_USD,
    dailyNotionalCap: cfg.OPS_DAILY_NOTIONAL_CAP_USD,
    dayNotional: dayNotionalUsd(chain.key),
  });
  if (!gate.ok) {
    metrics.inc('arb_ops_gate_block', { chain: chain.key, reason: gate.reason ?? 'unknown' });
    log.error(`ops gate BLOCKED ${cand.strategy} ${chain.key} — ${gate.reason}`);
    return;
  }
  noteNotional(chain.key, cand.borrowUsd ?? 0);

  // 4. submit via strict 4337 — private rail first on eth (Flashbots
  //    bundle/private-tx wraps the signed UserOp in a handleOps carrier
  //    tx; mempool never sees it). Fallback to Pimlico on failure.
  if (flashbotsAvailable(chain)) {
    const priv = await sendUserOpViaFlashbots(chain, rpc, execData);
    if (priv.kind === 'sent') {
      metrics.inc('arb_submit_total', { chain: chain.key, strategy: cand.strategy });
      metrics.inc('arb_submit_private_total', { chain: chain.key, strategy: cand.strategy });
      lat.submitted();
      log.info(`PRIVATE submit ${cand.strategy} ${chain.key} bundle=${priv.bundleHash ?? priv.txHash}`);
      const rc = await awaitTxReceipt(rpc, priv.txHash!);
      lat.landed();
      if (!rc.landed) { metrics.inc('arb_unlanded_total', { chain: chain.key }); lat.emit('timeout', { note: 'unlanded' }); return; }
      if (!rc.success) { scheduler.recordRevert(cand.variant); metrics.inc('arb_landed_revert_total', { chain: chain.key }); recordLoss({ ts: Date.now(), chain: chain.key, kind: 'revert_gas', usd: cand.gasUsd, txHash: rc.txHash }); lat.emit('revert', { txHash: rc.txHash }); return; }
      scheduler.recordSettle(cand.variant, cand.netUsd);
      metrics.addSettled(chain.key, cand.strategy, cand.netUsd, rc.txHash!, cand.spreadPct, cand.regime, (cand as any).projectedNetUsd);
      lat.emit('settled', { path: cand.legs.map((l) => l.pool.address.toLowerCase()).join('>') });
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
  lat.submitted();

  // 5. receipt — settled evidence ONLY
  const receipt = await awaitUserOp(chain, sub.userOpHash);
  lat.landed();
  if (!receipt.landed) {
    metrics.inc('arb_unlanded_total', { chain: chain.key });
    lat.emit('timeout', { note: 'unlanded' });
    return;
  }
  if (!receipt.success) {
    scheduler.recordRevert(cand.variant);
    metrics.inc('arb_landed_revert_total', { chain: chain.key });
    // WO-15: failed-tx gas is a real cost — feeds the daily loss breaker
    recordLoss({ ts: Date.now(), chain: chain.key, kind: 'revert_gas', usd: cand.gasUsd, txHash: receipt.txHash });
    lat.emit('revert', { txHash: receipt.txHash });
    return;
  }

  // HONESTY FLOOR: only arb_settled_net_usd on landed records is profit.
  scheduler.recordSettle(cand.variant, cand.netUsd);
  metrics.addSettled(chain.key, cand.strategy, cand.netUsd, receipt.txHash!, cand.spreadPct, cand.regime, (cand as any).projectedNetUsd);
  lat.emit('settled', { path: cand.legs.map((l) => l.pool.address.toLowerCase()).join('>'), txHash: receipt.txHash });
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
