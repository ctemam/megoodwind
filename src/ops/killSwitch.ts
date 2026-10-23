/**
 * WO-15 — operational hardening. File-based kill switch + daily loss
 * breaker + capital caps + secret hygiene check. The kill file is the
 * SINGLE source of truth: any armed loop must consult it before submit.
 *
 *   data/KILL          — exists => ALL execution halts (manual switch)
 *   data/kill.json     — { chain?: string } => per-chain halt
 *   daily loss breaker — settled loss sum (or revert-gas sum) > cap =>
 *                        auto-halt until next UTC day
 *   capital caps       — per-tx borrow ceiling + per-day notional ceiling
 *   secrets hygiene    — never write key material to data/, git-ignored
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { logger } from '../config/logger.js';

const log = logger('ops');
const KILL_FILE = 'data/KILL';
const KILL_JSON = 'data/kill.json';
const LOSS_FILE = 'data/ops/losses.jsonl';

export interface LossRow { ts: number; chain: string; kind: 'revert_gas' | 'settled_loss'; usd: number; txHash?: string; }

export function killActive(chain?: string): { active: boolean; reason?: string } {
  if (existsSync(KILL_FILE)) return { active: true, reason: 'KILL file present' };
  if (existsSync(KILL_JSON)) {
    try {
      const j = JSON.parse(readFileSync(KILL_JSON, 'utf8'));
      if (!j.chain || j.chain === chain) return { active: true, reason: `kill.json chain=${j.chain ?? 'all'}` };
    } catch { return { active: true, reason: 'kill.json unreadable — fail closed' }; }
  }
  return { active: false };
}

export function recordLoss(row: LossRow) {
  mkdirSync('data/ops', { recursive: true });
  appendFileSync(LOSS_FILE, JSON.stringify(row) + '\n');
  log.error('loss recorded', row);
}

export function dailyLossUsd(chain?: string): number {
  if (!existsSync(LOSS_FILE)) return 0;
  const dayStart = new Date().setUTCHours(0, 0, 0, 0);
  return readFileSync(LOSS_FILE, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as LossRow; } catch { return null; } })
    .filter((r): r is LossRow => !!r && r.ts >= dayStart && (!chain || r.chain === chain))
    .reduce((a, r) => a + r.usd, 0);
}

/** Breaker: halt if today's measured losses exceed the cap. */
export function lossBreakerTripped(chain: string, capUsd: number): boolean {
  const lost = dailyLossUsd(chain);
  if (lost >= capUsd) { log.error(`daily loss breaker TRIPPED ${chain} $${lost.toFixed(2)} >= $${capUsd}`); return true; }
  return false;
}

/** Capital cap check — per-tx + per-day notional. */
export function capitalOk(borrowUsd: number, perTxCap: number, dayNotional: number, dayCap: number): boolean {
  return borrowUsd <= perTxCap && dayNotional + borrowUsd <= dayCap;
}

const NOTIONAL_FILE = 'data/ops/notional.json';
function notionalRead(): { day: string; per: Record<string, number> } {
  if (existsSync(NOTIONAL_FILE)) {
    try { const j = JSON.parse(readFileSync(NOTIONAL_FILE, 'utf8')); if (j.day === new Date().toISOString().slice(0, 10)) return j; } catch {}
  }
  return { day: new Date().toISOString().slice(0, 10), per: {} };
}
export function dayNotionalUsd(chain: string): number {
  return notionalRead().per[chain] ?? 0;
}
export function noteNotional(chain: string, usd: number) {
  const n = notionalRead();
  n.per[chain] = (n.per[chain] ?? 0) + usd;
  mkdirSync('data/ops', { recursive: true });
  writeFileSync(NOTIONAL_FILE, JSON.stringify(n));
}

/** One-liner gate used by every submit path. */
export function mayExecute(chain: string, borrowUsd: number, caps: { dailyLossCap: number; perTxCap: number; dailyNotionalCap: number; dayNotional: number }): { ok: boolean; reason?: string } {
  const k = killActive(chain);
  if (k.active) return { ok: false, reason: k.reason };
  if (lossBreakerTripped(chain, caps.dailyLossCap)) return { ok: false, reason: 'daily_loss_breaker' };
  if (!capitalOk(borrowUsd, caps.perTxCap, caps.dayNotional, caps.dailyNotionalCap)) return { ok: false, reason: 'capital_cap' };
  return { ok: true };
}
