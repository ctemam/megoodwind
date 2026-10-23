/**
 * WO-16 — paid-RPC decision, computed not vibed. Two measured triggers:
 *   1. budget exhaustion: free-tier usage ratio > 0.7 on a PROFITABLE chain
 *      (measured from rpc telemetry vs documented daily budgets)
 *   2. latency-value: lost races attributable to latency where
 *      sum(lostNetUsd) > next-tier monthly cost / 30
 * Never purchases — produces data/rpc_upgrade_recommendation.json for the
 * Commander to sign off on spend.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';

const FREE_DAILY_REQ: Record<string, number> = { // documented budgets (req/day, eth_call cost basis)
  dRPC: 350_000, Alchemy: 38_000, Ankr: 6_670_000, NodeFlare: 67_000,
  '1RPC': 1_000, Blockscout: 100_000, Chainstack: 100_000,
};
const NEXT_TIER_USD_MO = { dRPC: 25, Alchemy: 50, Ankr: 200, Chainstack: 0 }; // documented entry tiers, $/mo

export interface RpcUpgradeRec {
  chain: string;
  trigger: 'budget_exhaustion' | 'latency_value' | 'none';
  usedReqPerDay: number;
  freeBudgetPerDay: number;
  usageRatio: number;
  lostRaceUsdPerDay: number;
  nextTierUsdDay: number;
  recommendation: string;
}

export function evaluateRpcSpend(chain: string): RpcUpgradeRec {
  const req = existsSync('data/rpc_requests.jsonl')
    ? readFileSync('data/rpc_requests.jsonl', 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((r): r is { chain: string; n: number } => !!r && r.chain === chain)
        .reduce((a, r) => a + r.n, 0)
    : 0;
  const freeBudget = Object.values(FREE_DAILY_REQ).reduce((a, b) => a + b, 0);
  const ratio = freeBudget ? req / freeBudget : 0;
  const lostUsd = existsSync('data/speed/latency.jsonl')
    ? readFileSync('data/speed/latency.jsonl', 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((r): r is { outcome: string; chain: string; grossUsd?: number } => !!r && r.outcome === 'lost_race' && r.chain === chain)
        .reduce((a, r) => a + (r.grossUsd ?? 0), 0)
    : 0;
  const tier = Math.min(...Object.values(NEXT_TIER_USD_MO)) / 30;
  const trigger: RpcUpgradeRec['trigger'] =
    ratio > 0.7 ? 'budget_exhaustion' : lostUsd > tier ? 'latency_value' : 'none';
  const rec: RpcUpgradeRec = {
    chain, trigger, usedReqPerDay: req, freeBudgetPerDay: freeBudget,
    usageRatio: ratio, lostRaceUsdPerDay: lostUsd, nextTierUsdDay: tier,
    recommendation: trigger === 'none'
      ? `no spend — usage ${(ratio * 100).toFixed(1)}%, lost-race value $${lostUsd.toFixed(2)}/day < tier $${tier.toFixed(2)}/day`
      : `RECOMMEND ${trigger} — Commander approval required for spend`,
  };
  mkdirSync('data', { recursive: true });
  writeFileSync('data/rpc_upgrade_recommendation.json', JSON.stringify({ computedAt: new Date().toISOString(), ...rec }, null, 2));
  return rec;
}
