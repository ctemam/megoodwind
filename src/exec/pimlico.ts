import { ChainConfig, cfg, privKeyHex } from '../config/index.js';
import { logger } from '../config/logger.js';
import { execProbe, gasProbe, ProbeOutcome } from './verify.js';
import { RpcPool } from '../providers/rpcPool.js';

/**
 * ERC-4337 submission lane — strict_4337: every live execution goes out
 * as a sponsored UserOp from the Kernel smart account via the Pimlico
 * bundler. The exec-probe identity is ALWAYS the smart account, never
 * the EOA (probe must match the real msg.sender).
 *
 * Transport: permissionless SDK (viem). Fallback: raw bundler JSON-RPC
 * when the SDK path is unavailable.
 */

const log = logger('pimlico');
const PIMLICO_BASE = 'https://api.pimlico.io/v2';

export function bundlerUrl(chain: ChainConfig): string {
  return `${PIMLICO_BASE}/${chain.chainId}/rpc?apikey=${cfg.PIMLICO_API_KEY}`;
}

/** Raw bundler JSON-RPC helper (gas price, receipts, sponsor calls). */
export async function bundlerRpc<T>(chain: ChainConfig, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(bundlerUrl(chain), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`bundler_http_${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`bundler_rpc: ${j.error.message}`);
  return j.result as T;
}

export interface SubmitResult {
  kind: 'sent' | 'skipped' | 'failed';
  userOpHash?: string;
  reason?: string;
}

/**
 * ERC-4337 submission lane for arbitrary targets — used by the CREATE2
 * deployment path (deploy.ts) where there is no chain.executor yet to call.
 * Strict_4337: probe identity is always the smart account, never the EOA.
 */
export async function submitUserOp(
  chain: ChainConfig,
  rpc: RpcPool,
  to: string,
  data: string,
): Promise<SubmitResult> {
  // exec-probe from the REAL sender identity first — strict_4337
  const probe: ProbeOutcome = await execProbe(rpc, cfg.SMART_ACCOUNT_ADDRESS, to, data);
  if (probe.kind === 'deterministic_revert') {
    return { kind: 'skipped', reason: `probe_revert:${probe.reason}` };
  }
  if (probe.kind === 'transport') {
    return { kind: 'skipped', reason: `probe_transport:${probe.reason}` };
  }

  try {
    const { smartAccountClient, accountAddress } = await buildSmartAccountClient(chain);
    if (accountAddress.toLowerCase() !== cfg.SMART_ACCOUNT_ADDRESS.toLowerCase()) {
      log.warn(`derived smart account ${accountAddress} != env ${cfg.SMART_ACCOUNT_ADDRESS}`);
    }
    const hash = await smartAccountClient.sendUserOperation({
      calls: [{ to: to as `0x${string}`, data: data as `0x${string}`, value: 0n }],
    });
    log.info(`${chain.key} UserOp sent`, { hash, to });
    return { kind: 'sent', userOpHash: hash };
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    log.error(`${chain.key} UserOp submit failed`, msg.slice(0, 200));
    return { kind: 'failed', reason: msg.slice(0, 200) };
  }
}

/**
 * Build + sponsor + send a UserOp calling exec(planBytes) on the executor.
 * Uses permissionless when installed; falls back to raw pm_* calls.
 */
export async function submitExecUserOp(
  chain: ChainConfig,
  rpc: RpcPool,
  execData: string,
): Promise<SubmitResult> {
  const executor = chain.executor;
  if (!executor) return { kind: 'skipped', reason: 'no_executor_for_chain' };

  // exec-probe from the REAL sender identity first — strict_4337
  const probe: ProbeOutcome = await execProbe(rpc, cfg.SMART_ACCOUNT_ADDRESS, executor, execData);
  if (probe.kind === 'deterministic_revert') {
    return { kind: 'skipped', reason: `probe_revert:${probe.reason}` };
  }
  if (probe.kind === 'transport') {
    return { kind: 'skipped', reason: `probe_transport:${probe.reason}` };
  }

  try {
    const { smartAccountClient, accountAddress } = await buildSmartAccountClient(chain);
    if (accountAddress.toLowerCase() !== cfg.SMART_ACCOUNT_ADDRESS.toLowerCase()) {
      log.warn(`derived smart account ${accountAddress} != env ${cfg.SMART_ACCOUNT_ADDRESS}`);
    }
    const hash = await smartAccountClient.sendUserOperation({
      calls: [{ to: executor as `0x${string}`, data: execData as `0x${string}`, value: 0n }],
    });
    log.info(`${chain.key} UserOp sent`, { hash });
    return { kind: 'sent', userOpHash: hash };
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    log.error(`${chain.key} UserOp submit failed`, msg.slice(0, 200));
    return { kind: 'failed', reason: msg.slice(0, 200) };
  }
}

/** permissionless Kernel client — dynamic import keeps module loadable
 *  even if the SDK tree shifts; typecheck validates the calls. */
async function buildSmartAccountClient(chain: ChainConfig) {
  const viem = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { createSmartAccountClient } = await import('permissionless');
  const { toKernelSmartAccount } = await import('permissionless/accounts');
  const { createPimlicoClient } = await import('permissionless/clients/pimlico');
  const { entryPoint07Address } = await import('viem/account-abstraction');

  const owner = privateKeyToAccount(privKeyHex());
  // reads (Kernel address derivation, nonce, estimates) go to the chain
  // RPC — the Pimlico bundler URL does not serve eth_call and would kill
  // account construction before any UserOp could be sent.
  const client = viem.createPublicClient({
    chain: viemChain(chain.chainId),
    transport: viem.http(chain.rpcUrls[0]),
  });

  const account = await toKernelSmartAccount({
    client,
    owners: [owner],
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    version: '0.3.1',
  });

  const pimlico = createPimlicoClient({
    chain: viemChain(chain.chainId),
    transport: viem.http(bundlerUrl(chain)),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: viemChain(chain.chainId),
    bundlerTransport: viem.http(bundlerUrl(chain)),
    paymaster: pimlico,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
    },
  });

  return { smartAccountClient, accountAddress: account.address as string };
}

/** Minimal viem chain descriptor — we only need id + rpc for 4337 ops. */
function viemChain(chainId: number) {
  return {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'NATIVE', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  } as never;
}

/** Poll until a UserOp lands (or times out) — settled evidence only. */
export async function awaitUserOp(chain: ChainConfig, userOpHash: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const receipt = await bundlerRpc<{ success?: boolean; receipt?: { transactionHash?: string } }>(
        chain,
        'eth_getUserOperationReceipt',
        [userOpHash],
      );
      if (receipt?.receipt?.transactionHash) {
        return { landed: true, success: receipt.success !== false, txHash: receipt.receipt.transactionHash };
      }
    } catch {
      /* transport — keep polling */
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return { landed: false, success: false, txHash: undefined };
}

export { gasProbe };
