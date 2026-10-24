/**
 * WO-04 — Economic reconstruction / profit-truth layer.
 * Contract: receipt-success ≠ profit; gross token flow ≠ net USD; missing ≠ zero.
 * Every output carries an explicit EconStatus + unknowns[] — never fabricate.
 */
export type EconStatus =
  | 'execution_failed'        // receipt status 0 — real loss = gas, not an arb
  | 'successful_unpriced'     // landed, but no defensible valuation
  | 'gross_value_estimated'   // gross priced, costs incomplete/unknown
  | 'net_profit_estimated'    // gross − attributed costs > 0, all inputs defensible
  | 'net_profit_verified'     // net confirmed under stated scope (e.g. receipt+trace)
  | 'economics_incomplete';   // insufficient evidence to classify further

export interface EconInput {
  receiptStatus?: 0 | 1;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;      // wei
  grossProfitRaw?: bigint;         // final.out − first.in, profit token
  profitDecimals?: number;
  profitUsdRate?: number;          // USD per whole token, stamped source
  ethUsdRate?: number;             // for gas costing
  flashLoan?: { provider: string; principalRaw: bigint; repayRaw: bigint; feeRaw: bigint };
  builderPaymentWei?: bigint;      // coinbase transfer, lower bound
  extraCostsUsd?: number;          // other attributable costs
  traceVerified?: boolean;         // internal trace/balance-delta evidence — public logs NEVER set this
}

export interface EconResult {
  status: EconStatus;
  grossRaw?: string; grossUsd?: number;
  gasCostWei?: string; gasCostUsd?: number;
  flashFeeRaw?: string; flashFeeUsd?: number;
  builderPayUsd?: number;
  netUsd?: number;                 // only when status is estimated/verified
  unknowns: string[];
  confidence: number;              // 0..1
}

export function reconstruct(i: EconInput): EconResult {
  const unknowns: string[] = [];
  if (i.receiptStatus !== 1) {
    const gasCostWei = i.gasUsed !== undefined && i.effectiveGasPrice !== undefined ? i.gasUsed * i.effectiveGasPrice : undefined;
    return { status: 'execution_failed', gasCostWei: gasCostWei?.toString(), gasCostUsd: gasCostWei !== undefined && i.ethUsdRate ? (Number(gasCostWei) / 1e18) * i.ethUsdRate : undefined, unknowns: gasCostWei === undefined ? ['gas_cost_unobservable'] : [], confidence: 0.9 };
  }
  const r: EconResult = { status: 'successful_unpriced', unknowns, confidence: 0 };
  let conf = 0.3; // receipt verified
  if (i.grossProfitRaw !== undefined) {
    r.grossRaw = i.grossProfitRaw.toString();
    if (i.profitUsdRate !== undefined && i.profitDecimals !== undefined) {
      r.grossUsd = (Number(i.grossProfitRaw) / 10 ** i.profitDecimals) * i.profitUsdRate;
      r.status = 'gross_value_estimated'; conf += 0.2;
    } else unknowns.push(i.profitUsdRate === undefined ? 'profit_token_unpriced' : 'decimals_unknown');
  } else unknowns.push('gross_flow_unobserved');

  // costs
  if (i.gasUsed !== undefined && i.effectiveGasPrice !== undefined) {
    const g = i.gasUsed * i.effectiveGasPrice;
    r.gasCostWei = g.toString();
    if (i.ethUsdRate !== undefined) r.gasCostUsd = (Number(g) / 1e18) * i.ethUsdRate;
    else unknowns.push('eth_price_unavailable');
  } else unknowns.push('gas_cost_unobservable');

  if (i.flashLoan) {
    r.flashFeeRaw = i.flashLoan.feeRaw.toString();
    // fee priced only if same token as profit AND priced
    if (i.profitUsdRate !== undefined && i.profitDecimals !== undefined)
      r.flashFeeUsd = (Number(i.flashLoan.feeRaw) / 10 ** i.profitDecimals) * i.profitUsdRate;
    else unknowns.push('flash_fee_unpriced');
  }
  if (i.builderPaymentWei !== undefined && i.ethUsdRate !== undefined)
    r.builderPayUsd = (Number(i.builderPaymentWei) / 1e18) * i.ethUsdRate;
  else if (i.builderPaymentWei !== undefined) unknowns.push('builder_payment_unpriced');
  else unknowns.push('builder_payment_unobserved'); // private-flow costs invisible on-chain

  // net only when every component priced
  const costKnown = r.gasCostUsd !== undefined && (r.flashFeeRaw === undefined || r.flashFeeUsd !== undefined);
  if (r.grossUsd !== undefined && costKnown) {
    r.netUsd = r.grossUsd - (r.gasCostUsd ?? 0) - (r.flashFeeUsd ?? 0) - (r.builderPayUsd ?? 0) - (i.extraCostsUsd ?? 0);
    conf += 0.3;
    // 'verified' requires trace-level evidence — public logs alone cap at estimated
    r.status = i.traceVerified && unknowns.length === 0 ? 'net_profit_verified' : 'net_profit_estimated';
  } else {
    if (r.grossUsd !== undefined) unknowns.push('net_blocked_by_unpriced_costs');
  }
  if (i.flashLoan === undefined) unknowns.push('flash_loan_use_unconfirmed');
  r.confidence = Math.min(1, conf);
  return r;
}
