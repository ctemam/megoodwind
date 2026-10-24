/**
 * WO-05 — Cross-chain measurement contract (mc-v1).
 * Rules: every rate publishes numerator + denominator + eligible/excluded/
 * unresolved populations + window + unit. Missing ≠ zero. Partial ≠ matched.
 * Chain ordering semantics retained — format normalized, realities not.
 */

export type OrderingModel = 'eth_builder_mev' | 'l2_sequencer_fifo' | 'unknown';
export const ORDERING: Record<string, OrderingModel> = {
  eth: 'eth_builder_mev', base: 'l2_sequencer_fifo', op: 'l2_sequencer_fifo',
  arb: 'l2_sequencer_fifo', poly: 'l2_sequencer_fifo', avax: 'l2_sequencer_fifo',
};

export const CONTRACT_VERSION = 'mc-v1';

export interface ObsWindow {
  chain: string;
  fromBlock: number;   // inclusive
  toBlock: number;     // inclusive
  complete: boolean;   // false if any chunk failed / scan interrupted
  scannedAt: number;   // epoch ms
  schema: string;      // decoder schema e.g. ci-v3
  contract: string;    // CONTRACT_VERSION
  ordering: OrderingModel;
}

export type Unit = 'tx' | 'event' | 'entity' | 'pool' | 'opportunity';
export type JoinOutcome = 'matched' | 'partial' | 'unmatched' | 'unresolved' | 'excluded';

export interface Rate {
  name: string;
  unit: Unit;
  numerator: number;
  denominator: number;
  eligible: number;      // population meeting inclusion criteria
  excluded: number;      // removed by explicit rule (incl. quarantined)
  unresolved: number;    // insufficient evidence — NOT counted as zero
  rate?: number;         // numerator/eligible; undefined when eligible=0 — never 0
  window?: ObsWindow;
}

/** Rate refuses to fake a denominator: eligible=0 → rate undefined, not 0. */
export function makeRate(name: string, unit: Unit, num: number, den: number, excl = 0, unres = 0, w?: ObsWindow): Rate {
  const eligible = den - excl;
  return { name, unit, numerator: num, denominator: den, eligible, excluded: excl, unresolved: unres,
           rate: eligible > 0 ? num / eligible : undefined, window: w };
}

export interface Coverage {
  blocksScanned: number; blocksExpected: number;
  blockCoverage?: number;                 // undefined if expected=0
  receiptsResolved: number; receiptsMissing: number;
  swapsDecoded: number; decodeFailures: number;
  pricedEvents: number; unpricedEvents: number;
  join: Record<JoinOutcome, number>;
}

export function newCoverage(): Coverage {
  return { blocksScanned: 0, blocksExpected: 0, receiptsResolved: 0, receiptsMissing: 0,
           swapsDecoded: 0, decodeFailures: 0, pricedEvents: 0, unpricedEvents: 0,
           join: { matched: 0, partial: 0, unmatched: 0, unresolved: 0, excluded: 0 } };
}

/** Two windows comparable only if same contract version + complete + same unit semantics. */
export function comparable(a: Rate, b: Rate): { ok: boolean; reason?: string } {
  if (a.unit !== b.unit) return { ok: false, reason: `unit mismatch ${a.unit} vs ${b.unit}` };
  if (!a.window || !b.window) return { ok: false, reason: 'missing window' };
  if (a.window.contract !== b.window.contract) return { ok: false, reason: `contract ${a.window.contract} vs ${b.window.contract}` };
  if (!a.window.complete || !b.window.complete) return { ok: false, reason: 'incomplete scan' };
  if (a.unresolved > 0 || b.unresolved > 0) return { ok: true, reason: 'comparable but unresolved>0 — disclose' };
  return { ok: true };
}
