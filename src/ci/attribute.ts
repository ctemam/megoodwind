/**
 * WO-07 — Stage-level attribution: competitor event → AllBright pipeline.
 * Six outcomes; unmatched ≠ missed. Causal evidence required; unknown stays
 * indeterminate. Replay-backed claims marked estimated vs verified.
 */
import type { CiRecord } from './store.js';

export type Attribution =
  | 'confirmed_missed'        // executable positive-net candidate we failed to capture (replay-backed)
  | 'visibility_failure'      // not observed: pools/tokens absent from our universe
  | 'pipeline_rejection'      // observed but rejected at a specific documented gate
  | 'execution_failure'       // qualified candidate lost in prep/submission/inclusion
  | 'not_economically_viable' // costs/impact/repayment kill net under OUR constraints
  | 'indeterminate';          // insufficient evidence — never forced into a cause

export interface AttributableInput {
  rec: CiRecord;
  ourPools: Set<string>;                // registry pool addrs (lowercase)
  convictedPools?: Set<string>;         // bait/convicted pools
  knownTokens?: Set<string>;            // token universe we can price/handle
  ourMinProfitUsd?: number;             // qualification floor
  replayed?: { executable: boolean; netUsd?: number; reason?: string }; // counterfactual result if run
}
export interface AttrResult {
  eventId: string; outcome: Attribution; stage: number; reason: string;
  confidence: number; alternatives: string[];
}

// stage ids follow WO-14 nine-stage map
export function attribute(i: AttributableInput): AttrResult {
  const r = i.rec;
  const alts: string[] = [];
  if (!r.receiptVerified) return { eventId: r.eventId, outcome: 'indeterminate', stage: 0, reason: 'receipt unverified — cannot confirm the event itself', confidence: 0.1, alternatives: ['decode artifact'] };

  const pools = r.pools ?? [];
  if (pools.length === 0) return { eventId: r.eventId, outcome: 'indeterminate', stage: 0, reason: 'no route decoded', confidence: 0.1, alternatives: [] };

  // Stage 1 detection: all route pools must be in our universe
  const missing = pools.filter((p) => !i.ourPools.has(p.toLowerCase()));
  if (missing.length === pools.length)
    return { eventId: r.eventId, outcome: 'visibility_failure', stage: 1, reason: `0/${pools.length} route pools in registry — opportunity invisible`, confidence: 0.8, alternatives: ['registry incomplete', 'competitor used venues outside our factories'] };
  if (missing.length > 0)
    return { eventId: r.eventId, outcome: 'visibility_failure', stage: 1, reason: `partial route: ${pools.length - missing.length}/${pools.length} pools known — cycle unreachable`, confidence: 0.7, alternatives: ['partial coverage still fails the cycle'] };

  // Stage 2 validation: convicted/suspect pools reject the path
  const convicted = pools.filter((p) => i.convictedPools?.has(p.toLowerCase()));
  if (convicted.length)
    return { eventId: r.eventId, outcome: 'pipeline_rejection', stage: 2, reason: `${convicted.length} route pool(s) convicted (bait/divergence) — rejection may be correct or a wrongful conviction`, confidence: 0.6, alternatives: ['wrongful conviction (audit)', 'genuinely unsafe pool'] };

  // Stage 3 projection: pricing availability
  if (r.profitToken && i.knownTokens && !i.knownTokens.has(r.profitToken.toLowerCase()))
    return { eventId: r.eventId, outcome: 'pipeline_rejection', stage: 3, reason: `profit token ${r.profitToken.slice(0, 10)} not in our token universe — cannot price`, confidence: 0.5, alternatives: ['token-list gap', 'decimals unresolved'] };

  // Stage 6 qualification: net economics under OUR constraints (floors, costs)
  if (i.replayed) {
    if (!i.replayed.executable)
      return { eventId: r.eventId, outcome: 'indeterminate', stage: 4, reason: `replay failed: ${i.replayed.reason ?? 'state reconstruction unavailable'} — cannot establish counterfactual`, confidence: 0.3, alternatives: ['stale state', 'simulation fidelity'] };
    if (i.replayed.netUsd !== undefined) {
      if (i.replayed.netUsd <= 0)
        return { eventId: r.eventId, outcome: 'not_economically_viable', stage: 6, reason: `replayed net ${i.replayed.netUsd.toFixed(4)} USD ≤ 0 after OUR costs — correctly skipped`, confidence: 0.85, alternatives: [] };
      if (i.ourMinProfitUsd !== undefined && i.replayed.netUsd < i.ourMinProfitUsd)
        return { eventId: r.eventId, outcome: 'not_economically_viable', stage: 6, reason: `replayed net ${i.replayed.netUsd.toFixed(4)} < floor ${i.ourMinProfitUsd} — below qualification`, confidence: 0.8, alternatives: ['floor may be too high (separate hypothesis)'] };
      return { eventId: r.eventId, outcome: 'confirmed_missed', stage: 6, reason: `replayed net ${i.replayed.netUsd.toFixed(4)} USD passes all gates — we missed an executable candidate`, confidence: 0.9, alternatives: ['inclusion would have competed (uncertain)'] };
    }
    return { eventId: r.eventId, outcome: 'indeterminate', stage: 4, reason: 'replay executable but net unpriced', confidence: 0.4, alternatives: ['unpriced profit token'] };
  }

  // no replay → economics-only estimate, marked as estimate not verified
  if (r.econ?.netUsd !== undefined) {
    if (r.econ.netUsd <= 0)
      return { eventId: r.eventId, outcome: 'not_economically_viable', stage: 6, reason: `estimated net ${r.econ.netUsd.toFixed(4)} ≤ 0 (operator-level costs) — likely correctly skipped`, confidence: 0.5, alternatives: ['our cost structure differs — replay needed'] };
    return { eventId: r.eventId, outcome: 'indeterminate', stage: 4, reason: 'positive estimated net but NO replay — counterfactual executability unproven', confidence: 0.35, alternatives: ['replay at pinned block required', 'timing/ordering advantage'] };
  }
  return { eventId: r.eventId, outcome: 'indeterminate', stage: 3, reason: 'economics unresolved (unpriced/missing inputs)', confidence: 0.2, alternatives: alts };
}
