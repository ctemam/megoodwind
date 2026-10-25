/** WO-8 step 5 — shadow exec-probe: in DIAG_ONLY, every solver-passed
 *  candidate ALSO gets the real executor.exec() eth_call — current-build
 *  bytecode state-overridden at the configured executor address (deployed
 *  0x6614… is stale), with storage slots set to the per-chain venue set
 *  and owner=SMART. Read-only; nothing is ever submitted. */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { cfg } from '../config/index.js';
import type { ChainConfig } from '../config/index.js';
import type { RpcPool } from '../providers/rpcPool.js';
import type { Candidate } from '../strategies/solver.js';
import { buildPlan } from './planBuilder.js';
import { pickFlashSource, flashPremium, FLASH_VENUES } from './flashVenues.js';
import { execProbe, type StateOverride } from './verify.js';
import { logger } from '../config/logger.js';
import { ethers } from 'ethers';

const log = logger('shadowProbe');
mkdirSync('data', { recursive: true });
const FILE = 'data/shadow_candidates.jsonl';

const pad32 = (addr: string) => ethers.zeroPadValue(ethers.getAddress(addr), 32);
let BYTECODE: string | null = null;
function currentBytecode(): string {
  if (!BYTECODE) {
    const a = JSON.parse(readFileSync('out/AllBrightExecutor.sol/AllBrightExecutor.json', 'utf8'));
    BYTECODE = a.deployedBytecode?.object ?? a.bytecode?.object;
  }
  return BYTECODE!;
}

/** Corrected venue coords — the real base Aave V3 Pool, not the typo'd
 *  FLASH_VENUES entry (verified getCode on-chain). */
const FIXED_AAVE: Record<string, string> = { base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' };

function overrideFor(chain: ChainConfig): StateOverride {
  const v = FLASH_VENUES[chain.key] ?? {};
  return {
    [chain.executor!]: {
      code: currentBytecode(),
      stateDiff: {
        ['0x' + '0'.repeat(63) + '0']: '0x' + '0'.repeat(63) + '1',   // _status=1 (entered=false)
        ['0x' + '0'.repeat(63) + '1']: pad32(cfg.SMART_ACCOUNT_ADDRESS),
        ['0x' + '0'.repeat(63) + '2']: pad32((v as { balancer?: string }).balancer ?? ethers.ZeroAddress),
        ['0x' + '0'.repeat(63) + '3']: pad32(FIXED_AAVE[chain.key] ?? (v as { aave?: string }).aave ?? ethers.ZeroAddress),
        ['0x' + '0'.repeat(63) + '4']: pad32((v as { morpho?: string }).morpho ?? ethers.ZeroAddress),
        ['0x' + '0'.repeat(63) + '5']: pad32((v as { erc3156?: string }).erc3156 ?? ethers.ZeroAddress),
      },
    },
    [cfg.SMART_ACCOUNT_ADDRESS]: { balance: '0xDE0B6B3A7640000' }, // 1 native — gas-cost artifact only
  };
}

const STALE_MS = Number(process.env.SHADOW_STALE_MS ?? 30_000); // reserves older than this → reject, not silent-K
export async function shadowExecProbe(chain: ChainConfig, rpc: RpcPool, cand: Candidate): Promise<void> {
  const path = cand.legs.map((l) => l.pool.address.toLowerCase()).join('>');
  try {
    // Stage-3B: reject stale pool state before probing — reserves drift → K() is state-error, not strategy error
    const stale = cand.legs.filter((l) => (l.pool as any).updatedAt && Date.now() - (l.pool as any).updatedAt > STALE_MS);
    if (stale.length) {
      appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), stage: 'shadow_exec_probe', chain: chain.key, path, probe: 'stale_state_rejected', stalePools: stale.length, reason: `reserves older than ${STALE_MS}ms` }) + '\n');
      return;
    }
    const source = pickFlashSource(chain.key, cand.borrowToken);
    const premium = flashPremium(source, cand.borrowAmount);
    const { planBytes, execData } = buildPlan(cand, { source, premium, minProfit: cand.minProfitToken });
    const probe = await execProbe(rpc, cfg.SMART_ACCOUNT_ADDRESS, chain.executor!, execData, { stateOverride: overrideFor(chain) });
    appendFileSync(FILE, JSON.stringify({
      ts: new Date().toISOString(), stage: 'shadow_exec_probe', chain: chain.key,
      path, lane: cand.lane, variant: cand.variant?.id, strategy: cand.strategy,
      source, borrowToken: cand.borrowToken, borrowAmount: cand.borrowAmount.toString(),
      minProfitToken: cand.minProfitToken?.toString(), grossUsd: cand.grossUsd,
      gasUsd: cand.gasUsd, netUsd: cand.netUsd, spreadPct: cand.spreadPct,
      probe: probe.kind, reason: probe.kind !== 'pass' ? (probe as { reason?: string }).reason : undefined,
      execDataLen: execData.length / 2 - 1,
    }) + '\n');
    log.info(`${chain.key} shadow-probe ${probe.kind} ${path.slice(0, 40)} net=${cand.netUsd.toFixed(3)}${probe.kind !== 'pass' ? ' ' + (probe as { reason?: string }).reason : ''}`);
  } catch (e) {
    appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), stage: 'shadow_exec_probe', chain: chain.key, path, probe: 'build_error', reason: String(e).slice(0, 160) }) + '\n');
  }
}
