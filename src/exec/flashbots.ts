import { ethers } from 'ethers';
import { ChainConfig, cfg } from '../config/index.js';
import { logger } from '../config/logger.js';

/**
 * Item #8 — Flashbots private relay (Ethereum mainnet only).
 * Raw JSON-RPC against `relay.flashbots.net` — no bundle-provider dep.
 * Auth = `X-Flashbots-Signature: <addr>:<sig>` where sig = EIP-191 over the
 * raw request body (spec: docs.flashbots.net/flashbots-auction/advanced/
 * rpc-endpoint). The signing key carries searcher REPUTATION — a dedicated
 * FLASHBOOTS_AUTH_KEY is preferred over the execution key.
 *
 * Surfaces (spec-verified):
 *   eth_sendBundle              — atomic bundle to builders
 *   eth_callBundle              — simulate bundle on builder state (pre-send gate)
 *   eth_sendPrivateTransaction  — single-tx private path (25-block window)
 *   eth_cancelBundle            — revoke a replacementUuid bundle
 *   flashbots_getFeeRefundTotalsByRecipient — refund telemetry
 *
 * Limits: 10k req/s/IP (non-binding), ≤100 txs/bundle, ≤300kB payload.
 * BSC/Polygon/L2s have no Flashbots relay — Pimlico covers them.
 */

const log = logger('flashbots');
const MAX_BUNDLE_TXS = 100;

let _authWallet: ethers.Wallet | undefined;
function authWallet(): ethers.Wallet | null {
  if (_authWallet) return _authWallet;
  const key = cfg.FLASHBOOTS_AUTH_KEY || process.env.PRIVATE_KEY;
  if (!key) return null;
  _authWallet = new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`);
  return _authWallet;
}

export function flashbotsAvailable(chain: ChainConfig): boolean {
  return chain.key === 'eth' && Boolean(cfg.FLASHBOOTS_AUTH_KEY || process.env.PRIVATE_KEY);
}

/** Signed JSON-RPC call to the relay — signature binds reputation to the body. */
async function fbRpc<T>(method: string, params: unknown[]): Promise<T | { error: string }> {
  const w = authWallet();
  if (!w) return { error: 'no_auth_key' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
  try {
    const signature = `${w.address}:${await w.signMessage(ethers.id(body))}`;
    const r = await fetch(cfg.FLASHBOOTS_RELAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Flashbots-Signature': signature },
      body,
    });
    const j = (await r.json()) as { result?: T; error?: { message?: string } | string };
    if (j.error) return { error: typeof j.error === 'string' ? j.error : j.error.message ?? 'relay_error' };
    return j.result as T;
  } catch (e) {
    return { error: String((e as { message?: string })?.message ?? e) };
  }
}

export interface BundleResult {
  kind: 'sent' | 'skipped' | 'failed';
  bundleHash?: string;
  reason?: string;
}

/** eth_callBundle — simulate a signed bundle against builder state.
 *  THE shadow-mode execution validator: real builder semantics, zero
 *  submission. Returns gas/revert detail per tx. */
export async function callBundle(
  chain: ChainConfig,
  signedTxs: string[],
  targetBlock: number,
  stateBlock: number | 'latest' = 'latest',
): Promise<
  | {
      ok: true;
      totalGasUsed: number;
      coinbaseDiff: string;
      perTx: { gasUsed: number; txHash: string; error?: string; revert?: string }[];
    }
  | { ok: false; reason: string }
> {
  if (!flashbotsAvailable(chain)) return { ok: false, reason: 'flashbots_unavailable' };
  if (signedTxs.length > MAX_BUNDLE_TXS) return { ok: false, reason: 'bundle_over_100_txs' };
  const res = await fbRpc<{
    totalGasUsed?: number;
    coinbaseDiff?: string;
    results?: { gasUsed: number; txHash: string; error?: string; revert?: string }[];
  }>('eth_callBundle', [
    {
      txs: signedTxs,
      blockNumber: `0x${targetBlock.toString(16)}`,
      stateBlockNumber: stateBlock === 'latest' ? 'latest' : `0x${stateBlock.toString(16)}`,
    },
  ]);
  if ('error' in res) return { ok: false, reason: res.error };
  return {
    ok: true,
    totalGasUsed: res.totalGasUsed ?? 0,
    coinbaseDiff: res.coinbaseDiff ?? '0',
    perTx: res.results ?? [],
  };
}

/** eth_sendBundle — atomic bundle to the relay. */
export async function sendBundle(
  chain: ChainConfig,
  signedTx: string | string[],
  targetBlock: number,
  opts: { maxTimestamp?: number; replacementUuid?: string; revertingTxHashes?: string[] } = {},
): Promise<BundleResult> {
  if (!flashbotsAvailable(chain)) {
    return { kind: 'skipped', reason: 'flashbots_unavailable_on_chain_or_no_key' };
  }
  const txs = Array.isArray(signedTx) ? signedTx : [signedTx];
  if (txs.length > MAX_BUNDLE_TXS) return { kind: 'failed', reason: 'bundle_over_100_txs' };
  const res = await fbRpc<{ bundleHash: string }>('eth_sendBundle', [
    {
      txs,
      blockNumber: `0x${targetBlock.toString(16)}`,
      ...(opts.maxTimestamp ? { maxTimestamp: opts.maxTimestamp } : {}),
      ...(opts.replacementUuid ? { replacementUuid: opts.replacementUuid } : {}),
      ...(opts.revertingTxHashes ? { revertingTxHashes: opts.revertingTxHashes } : {}),
    },
  ]);
  if ('error' in res) {
    log.error('bundle submit failed', res.error.slice(0, 200));
    return { kind: 'failed', reason: res.error.slice(0, 200) };
  }
  log.info(`bundle sent for block ${targetBlock}`, { bundleHash: res.bundleHash });
  return { kind: 'sent', bundleHash: res.bundleHash };
}

/** eth_sendPrivateTransaction — single signed tx, private for up to 25 blocks. */
export async function sendPrivateTransaction(
  chain: ChainConfig,
  signedTx: string,
  opts: { maxBlockNumber?: number; fast?: boolean } = {},
): Promise<{ ok: boolean; txHash?: string; reason?: string }> {
  if (!flashbotsAvailable(chain)) return { ok: false, reason: 'flashbots_unavailable' };
  const res = await fbRpc<string>('eth_sendPrivateTransaction', [
    {
      tx: signedTx,
      ...(opts.maxBlockNumber ? { maxBlockNumber: `0x${opts.maxBlockNumber.toString(16)}` } : {}),
      ...(opts.fast ? { preferences: { fast: true } } : {}),
    },
  ]);
  if (typeof res !== 'string') return { ok: false, reason: res.error };
  return { ok: true, txHash: res };
}

/** eth_cancelBundle — revoke by replacementUuid (must match the send). */
export async function cancelBundle(
  chain: ChainConfig,
  replacementUuid: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!flashbotsAvailable(chain)) return { ok: false, reason: 'flashbots_unavailable' };
  const res = await fbRpc<Record<string, never>>('eth_cancelBundle', [{ replacementUuid }]);
  return 'error' in res ? { ok: false, reason: res.error } : { ok: true };
}

/** flashbots_getFeeRefundTotalsByRecipient — weekly refund telemetry. */
export async function feeRefundTotals(
  chain: ChainConfig,
  recipient: string,
): Promise<{ pending: string; received: string; maxBlockNumber: string } | null> {
  if (!flashbotsAvailable(chain)) return null;
  const res = await fbRpc<{ pending: string; received: string; maxBlockNumber: string }>(
    'flashbots_getFeeRefundTotalsByRecipient',
    [recipient],
  );
  return 'error' in res ? null : res;
}
