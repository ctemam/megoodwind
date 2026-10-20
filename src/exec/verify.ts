import { RpcPool } from '../providers/rpcPool.js';
import { logger } from '../config/logger.js';
import { cfg } from '../config/index.js';

/**
 * Verify-before-submit (all lanes):
 *   1. fresh-state re-sim at REAL size (never the witness quote)
 *   2. gas-abort when the fee can't pay for itself
 *   3. exec-probe eth_call FROM the identity that will actually send —
 *      the smart account under strict 4337, never the EOA
 *   4. transport faults (429/timeout) prove nothing — skip, don't penalize.
 *      ErrorPayload reverts are deterministic — convict.
 */

export type ProbeOutcome =
  | { kind: 'pass'; gasEstimate?: bigint }
  | { kind: 'deterministic_revert'; reason: string }
  | { kind: 'transport'; reason: string };

const log = logger('verify');

export async function execProbe(
  rpc: RpcPool,
  from: string,
  to: string,
  data: string,
): Promise<ProbeOutcome> {
  try {
    await rpc.callFrom(from, to, data);
    return { kind: 'pass' };
  } catch (e) {
    const err = e as { message?: string; info?: { error?: { code?: number; data?: string } }; data?: string };
    const msg = String(err?.message ?? e);
    if (isTransport(msg)) return { kind: 'transport', reason: msg.slice(0, 120) };
    // ErrorPayload — decode revert reason (0x08c379a0 Error(string))
    const payload = err?.info?.error?.data ?? err?.data ?? '';
    const reason = decodeRevert(String(payload)) || msg.slice(0, 160);
    return { kind: 'deterministic_revert', reason };
  }
}

export async function gasProbe(rpc: RpcPool, from: string, to: string, data: string): Promise<bigint | null> {
  try {
    const hex = await rpc.call<string>('eth_estimateGas', [{ from, to, data }]);
    return BigInt(hex);
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (isTransport(msg)) return null;
    return null;
  }
}

const isTransport = (m: string) =>
  m.includes('429') || m.includes('timeout') || m.includes('TIMEOUT') ||
  m.includes('ECONNRESET') || m.includes('ETIMEDOUT') || m.includes('rpc_timeout');

function decodeRevert(hex: string): string {
  if (!hex.startsWith('0x08c379a0')) return '';
  try {
    const len = parseInt(hex.slice(74, 138), 16);
    const strHex = hex.slice(138, 138 + len * 2);
    return Buffer.from(strHex, 'hex').toString('utf8');
  } catch {
    return '';
  }
}

/** EIP-1559 circuit breaker — dormant above MAX_BASE_FEE_GWEI (Item #1). */
export async function baseFeeOk(rpc: RpcPool): Promise<{ ok: boolean; baseFeeWei: bigint }> {
  try {
    const block = await rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]);
    const base = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : 0n;
    const gwei = Number(base) / 1e9;
    return { ok: gwei <= cfg.MAX_BASE_FEE_GWEI, baseFeeWei: base };
  } catch {
    return { ok: false, baseFeeWei: 0n };
  }
}
