import { ethers } from 'ethers';
import { ChainConfig, cfg, privKeyHex } from '../config/index.js';
import { logger } from '../config/logger.js';
import { RpcPool } from '../providers/rpcPool.js';
import { bundlerRpc } from './pimlico.js';
import { callBundle, sendBundle, sendPrivateTransaction, flashbotsAvailable } from './flashbots.js';

/**
 * Private execution route — strict-4337 preserved end to end.
 *
 * The UserOp is NOT sent to a bundler's mempool. It is signed by the
 * Kernel account, wrapped in EntryPoint.handleOps() calldata, packed
 * into a raw EIP-1559 tx signed by the owner EOA, and delivered to the
 * Flashbots relay (eth_sendBundle / eth_sendPrivateTransaction). The
 * UserOp still executes via EntryPoint exactly as a bundler would land
 * it — nothing about the 4337 semantics changes; only the ORDERFLOW is
 * private (invisible to public-mempool sandwichers).
 *
 * Gate before send: eth_callBundle simulates the signed tx on real
 * builder state — a revert/OOG there aborts without spending a slot.
 */

const log = logger('privateRoute');
const EP07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const; // EntryPoint v0.7

const EP_ABI = new ethers.Interface([
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)',
]);

interface SponsoredOp {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: string; // v0.7 packed: paymaster|verGas|postOpGas|data
}

function toHex(b: bigint | number): string {
  return `0x${b.toString(16)}`;
}

/** pm_sponsorUserOperation → gas + paymaster fields (v0.7 packed or split). */
async function sponsorOp(chain: ChainConfig, op: Record<string, unknown>): Promise<SponsoredOp | null> {
  try {
    const r = await bundlerRpc<Record<string, string>>(chain, 'pm_sponsorUserOperation', [op, EP07]);
    if (!r) return null;
    const paymasterAndData =
      r.paymasterAndData ??
      (r.paymaster
        ? r.paymaster +
          BigInt(r.paymasterVerificationGasLimit ?? '0').toString(16).padStart(32, '0') +
          BigInt(r.paymasterPostOpGasLimit ?? '0').toString(16).padStart(32, '0') +
          (r.paymasterData ?? '0x').slice(2)
        : '0x');
    return {
      callGasLimit: BigInt(r.callGasLimit ?? '0'),
      verificationGasLimit: BigInt(r.verificationGasLimit ?? '0'),
      preVerificationGas: BigInt(r.preVerificationGas ?? '0'),
      maxFeePerGas: BigInt(r.maxFeePerGas ?? '0'),
      maxPriorityFeePerGas: BigInt(r.maxPriorityFeePerGas ?? '0'),
      paymasterAndData,
    };
  } catch {
    return null;
  }
}

/** Build → sponsor → sign UserOp → wrap in handleOps → sign raw tx → callBundle → sendBundle. */
export async function sendUserOpViaFlashbots(
  chain: ChainConfig,
  rpc: RpcPool,
  execData: string,
): Promise<{ kind: 'sent' | 'skipped' | 'failed'; bundleHash?: string; txHash?: string; reason?: string }> {
  if (!flashbotsAvailable(chain)) return { kind: 'skipped', reason: 'flashbots_unavailable' };
  const executor = chain.executor;
  if (!executor) return { kind: 'skipped', reason: 'no_executor_for_chain' };

  try {
    const { toKernelSmartAccount } = await import('permissionless/accounts');
    const { privateKeyToAccount } = await import('viem/accounts');
    const viem = await import('viem');

    const owner = privateKeyToAccount(privKeyHex());
    const client = viem.createPublicClient({
      chain: { id: chain.chainId, name: chain.key, nativeCurrency: { name: 'N', symbol: 'N', decimals: 18 }, rpcUrls: { default: { http: [] } } } as never,
      transport: viem.http(chain.rpcUrls[0]),
    });
    const account = await toKernelSmartAccount({
      client,
      owners: [owner],
      entryPoint: { address: EP07, version: '0.7' },
      version: '0.3.1',
    });

    // 1. callData + nonce
    const callData = await account.encodeCalls([
      { to: executor as `0x${string}`, data: execData as `0x${string}`, value: 0n },
    ]);
    const nonce = await (account.getNonce ? account.getNonce() : bundlerRpc<string>(chain, 'eth_getTransactionCount', [account.address, 'latest']).then(BigInt));

    // 2. sponsor → gas + paymasterAndData
    const partial = {
      sender: account.address,
      nonce: toHex(nonce),
      callData,
      callGasLimit: '0x0',
      verificationGasLimit: '0x0',
      preVerificationGas: '0x0',
      maxFeePerGas: '0x0',
      maxPriorityFeePerGas: '0x0',
    };
    const sp = await sponsorOp(chain, partial);
    if (!sp) return { kind: 'failed', reason: 'sponsor_unavailable' };

    // 3. sign the UserOp (Kernel → EIP-712/191 flow internally)
    const userOp = {
      sender: account.address,
      nonce,
      callData,
      callGasLimit: sp.callGasLimit,
      verificationGasLimit: sp.verificationGasLimit,
      preVerificationGas: sp.preVerificationGas,
      maxFeePerGas: sp.maxFeePerGas,
      maxPriorityFeePerGas: sp.maxPriorityFeePerGas,
      paymasterAndData: sp.paymasterAndData,
      signature: '0x' as `0x${string}`,
    };
    const signature = await account.signUserOperation(userOp as never);

    // 4. pack into EntryPoint v0.7 handleOps
    const pack = (a: bigint, b: bigint) =>
      `0x${a.toString(16).padStart(32, '0')}${b.toString(16).padStart(32, '0')}` as `0x${string}`;
    const packed = {
      sender: account.address,
      nonce,
      initCode: '0x',
      callData,
      accountGasLimits: pack(sp.verificationGasLimit, sp.callGasLimit),
      preVerificationGas: sp.preVerificationGas,
      gasFees: pack(sp.maxPriorityFeePerGas, sp.maxFeePerGas),
      paymasterAndData: sp.paymasterAndData,
      signature,
    };
    const bundler = new ethers.Wallet(privKeyHex());
    const handleOpsData = EP_ABI.encodeFunctionData('handleOps', [[packed], bundler.address]);

    // 5. sign the raw carrier tx (EIP-1559) — reads via the pool
    const [nonceHex, feeHist, gasHex] = await Promise.all([
      rpc.call<string>('eth_getTransactionCount', [bundler.address, 'latest']),
      rpc.call<{ baseFeePerGas: string[]; reward: string[][] }>('eth_feeHistory', [4, 'latest', [50]]),
      rpc
        .call<string>('eth_estimateGas', [{ to: EP07, data: handleOpsData, from: bundler.address }])
        .catch(() => '0x0'),
    ]);
    const txNonce = Number(BigInt(nonceHex));
    const baseFee = BigInt(feeHist.baseFeePerGas.at(-1) ?? '0x0');
    const priority = BigInt(feeHist.reward.at(-1)?.[0] ?? '0x0');
    const estGas = gasHex !== '0x0' ? (BigInt(gasHex) * 120n) / 100n : 500_000n;
    const signedTx = await bundler.signTransaction({
      to: EP07,
      data: handleOpsData,
      nonce: txNonce,
      chainId: chain.chainId,
      type: 2,
      gasLimit: estGas,
      maxFeePerGas: sp.maxFeePerGas > 0n ? sp.maxFeePerGas : baseFee * 2n + priority,
      maxPriorityFeePerGas: sp.maxPriorityFeePerGas > 0n ? sp.maxPriorityFeePerGas : priority,
    });

    // 6. eth_callBundle — real builder-state sim before spending a slot
    const head = Number(await rpc.blockNumber());
    const sim = await callBundle(chain, [signedTx], head + 1);
    if (!sim.ok) return { kind: 'failed', reason: `callbundle:${sim.reason}` };
    const failed = sim.perTx.find((t) => t.error || t.revert);
    if (failed) return { kind: 'failed', reason: `bundle_sim_revert:${failed.error ?? failed.revert}` };
    log.info(`callBundle PASS gasUsed=${sim.totalGasUsed} coinbaseDiff=${sim.coinbaseDiff}`);

    // 7. fire — bundle for next block; private-tx as secondary lane.
    //    Carrier tx hash = keccak256(signedTx) — the receipt path can
    //    settle it exactly like a public submission.
    const carrierTxHash = ethers.keccak256(signedTx);
    const sent = await sendBundle(chain, signedTx, head + 1, { maxTimestamp: Math.floor(Date.now() / 1000) + 120 });
    if (sent.kind === 'sent') return { kind: 'sent', bundleHash: sent.bundleHash, txHash: carrierTxHash };
    const priv = await sendPrivateTransaction(chain, signedTx, { fast: true });
    if (priv.ok) return { kind: 'sent', txHash: carrierTxHash };
    return { kind: 'failed', reason: `bundle:${sent.reason} private:${priv.reason}` };
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    log.error('private route failed', msg.slice(0, 200));
    return { kind: 'failed', reason: msg.slice(0, 200) };
  }
}

