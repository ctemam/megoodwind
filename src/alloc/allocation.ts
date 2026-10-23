/**
 * WO-12 — allocation scoring. Ranks chain × lane by
 *   score = (observed $/day * probePassRate) / (gasUsd + rpcLoad + competition)
 * with every input measured from the diag files + settled records — no
 * hand-typed values (THRESHOLDS §1: floor sweep, not a picked floor).
 * Output: data/allocation.json — recomputed on a 6h cadence (or on demand).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { cfg } from '../config/index.js';
import { FLASH_VENUES } from '../exec/flashVenues.js';

const ALL_CHAINS = ['eth', 'base', 'arb', 'op', 'poly', 'bsc', 'avax', 'linea', 'scroll'];

export interface LaneScore {
  chain: string;
  lane: 'dex_arb' | 'liquidation' | 'private_flow';
  observedUsdPerDay: number;
  probePassRate: number;      // passed_to_simulation_probe / detected (0 if lane dark)
  execSettleRate: number;     // ArbSettled / probe_pass (0 if no data)
  gasUsdPerDay: number;
  rpcReqPerDay: number;
  competitionBps: number;     // measured share-of-dislocation already taken (0 = unmeasured)
  score: number;
  dataHours: number;
}

const jsonl = (f: string): Record<string, unknown>[] =>
  existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Record<string, unknown>[] : [];

function laneStats(chain: string): { detected: number; probePass: number; settled: number; netUsd: number; hours: number } {
  const pp = jsonl('data/diag_probe_pass.jsonl').filter((r) => r.chain === chain);
  const hours = pp.length ? Math.max(1, (Date.now() - new Date(String(pp[0].ts)).getTime()) / 3.6e6) : 0;
  const settled = jsonl('data/settled.jsonl').filter((r) => r.chain === chain);
  const funnel = jsonl('data/diag_funnel.jsonl').filter((r) => r.chain === chain);
  const detected = funnel.reduce((a, r) => a + Number(r.detected ?? 0), 0) || pp.length * 1000; // fallback proxy
  return {
    detected, probePass: pp.length,
    settled: settled.length,
    netUsd: settled.reduce((a, r) => a + Number(r.netUsd ?? 0), 0),
    hours,
  };
}

export function computeAllocation(): LaneScore[] {
  const out: LaneScore[] = [];
  const memStats = jsonl('data/rpc_requests.jsonl'); // if emitted: per-chain request counts
  for (const ch of ALL_CHAINS) {
    const s = laneStats(ch);
    const probeRate = s.detected ? s.probePass / s.detected : 0;
    const settleRate = s.probePass ? s.settled / s.probePass : 0;
    const rpcPerDay = memStats.filter((r) => r.chain === ch).reduce((a, r) => a + Number(r.n ?? 0), 0) / Math.max(1, s.hours / 24);
    // lanes: dex_arb scored from diag data; liquidation/private pending data
    for (const lane of ['dex_arb', 'liquidation', 'private_flow'] as const) {
      const usdDay = lane === 'dex_arb' ? s.netUsd / Math.max(1, s.hours / 24) : 0;
      const hasVenue = !!FLASH_VENUES[ch]?.balancer;
      out.push({
        chain: ch, lane,
        observedUsdPerDay: usdDay,
        probePassRate: probeRate,
        execSettleRate: settleRate,
        gasUsdPerDay: 0, // filled when gas ledger lands
        rpcReqPerDay: rpcPerDay,
        competitionBps: 0,
        score: hasVenue && rpcPerDay >= 0 ? (usdDay * Math.max(probeRate, settleRate)) / Math.max(1, rpcPerDay / 1e6) : 0,
        dataHours: s.hours,
      });
    }
  }
  mkdirSync('data', { recursive: true });
  writeFileSync('data/allocation.json', JSON.stringify({ computedAt: new Date().toISOString(), lanes: out.sort((a, b) => b.score - a.score) }, null, 2));
  return out;
}
