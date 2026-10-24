/**
 * D6 — bundle-ledger realized-net reconciliation. For every ledger row
 * with sent=true and no inclusion verdict yet, poll the carrier tx
 * receipt; when landed, parse ArbSettled/LiquidationSettled to record
 * realizedNetUsd. Append-only ledger: writes the updated row on top —
 * readers take the LAST row per hintHash.
 */
import { ethers } from 'ethers';
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { RpcPool } from '../providers/rpcPool.js';
import { logger } from '../config/logger.js';

const log = logger('bundleReconcile');
const LEDGER = 'data/private/bundle_ledger.jsonl';

const ARB_SETTLED = ethers.id('ArbSettled(uint256,uint256,uint256)');
const LIQ_SETTLED = ethers.id('LiquidationSettled(uint256,uint256,uint256)');
const PROFIT_TOPIC = new Set([ARB_SETTLED, LIQ_SETTLED]);

interface ReconcileResult {
  hintHash: string;
  txHash: string;
  included: boolean;
  realizedNetUsd?: number;
  blockDelta?: number;
}

/** Poll one sent bundle for a landed receipt + realized profit event. */
export async function reconcileBundle(rpc: RpcPool, txHash: string, hintHash: string, sentAt: number): Promise<ReconcileResult | null> {
  const r = await rpc.call<{ status?: string; blockNumber?: string; logs?: { topics: string[]; data: string }[] }>(
    'eth_getTransactionReceipt', [txHash],
  ).catch(() => null);
  if (!r || !r.blockNumber) return null; // not landed yet
  const included = r.status === '0x1';
  let realizedNetUsd: number | undefined;
  if (included) {
    for (const l of r.logs ?? []) {
      if (!l.topics?.[0] || !PROFIT_TOPIC.has(l.topics[0])) continue;
      const vals = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'uint256'], l.data);
      realizedNetUsd = (realizedNetUsd ?? 0) + Number(vals[2]) / 1e6; // profit units (USDC-scaled)
    }
  }
  const head = await rpc.blockNumber().catch(() => 0);
  const blockDelta = head && r.blockNumber ? head - parseInt(r.blockNumber) : undefined;
  return { hintHash, txHash, included, realizedNetUsd, blockDelta };
}

/** Scan the ledger for unresolved sent bundles and reconcile each.
 *  Returns count of rows written. */
export async function reconcileLedger(rpc: RpcPool): Promise<number> {
  if (!existsSync(LEDGER)) return 0;
  const pending = new Map<string, { txHash: string; sentAt: number }>();
  for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.sent && r.txHash) {
        // latest row wins — a resolved row clears the pending entry
        if (r.included !== undefined) pending.delete(r.hintHash);
        else pending.set(r.hintHash, { txHash: r.txHash, sentAt: r.ts });
      }
    } catch { /* skip malformed */ }
  }
  let n = 0;
  for (const [hintHash, p] of pending) {
    const res = await reconcileBundle(rpc, p.txHash, hintHash, p.sentAt).catch(() => null);
    if (!res) continue;
    mkdirSync('data/private', { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ ts: Date.now(), ...res }) + '\n');
    log.info(`bundle ${hintHash.slice(0, 12)}: included=${res.included}${res.realizedNetUsd != null ? ` net=$${res.realizedNetUsd.toFixed(2)}` : ''}`);
    n++;
  }
  return n;
}
