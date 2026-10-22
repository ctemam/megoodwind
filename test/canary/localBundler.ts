import http from 'node:http';
import { ethers } from 'ethers';

/**
 * Local ERC-4337 "bundler" — implements the JSON-RPC surface
 * permissionless/viem call on a Pimlico endpoint, backed by a real
 * EntryPoint.handleOps on the Anvil fork. Not a mock: the UserOp is
 * validated, executed and settled by the canonical EP0.7 contract on
 * forked mainnet state; this shim is just the mempool→carrier glue a
 * bundler provides.
 *
 *   pimlico_getUserOperationGasPrice → {slow,standard,fast}
 *   eth_estimateUserOperationGas     → padded limits
 *   eth_sendUserOperation            → handleOps([op], beneficiary)
 *   eth_getUserOperationReceipt      → stored receipt
 *   (anything else)                  → forwarded to the anvil rpc
 */

const EP07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const EP_ABI = [
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)',
  'function depositTo(address account) payable',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
];

interface V7Op {
  sender: string; nonce: string;
  factory?: string | null; factoryData?: string | null;
  callData: string;
  callGasLimit: string; verificationGasLimit: string; preVerificationGas: string;
  maxFeePerGas: string; maxPriorityFeePerGas: string;
  paymaster?: string | null; paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string; paymasterData?: string | null;
  signature: string;
}

function packUserOp(op: V7Op) {
  const bn = (v?: string | null) => (v ? BigInt(v) : 0n);
  const packU128 = (hi: bigint, lo: bigint) => ethers.toBeHex((hi << 128n) | lo, 32) as `0x${string}`;
  return {
    sender: op.sender,
    nonce: bn(op.nonce),
    initCode: (op.factory && op.factoryData ? op.factory + op.factoryData.slice(2) : '0x') as `0x${string}`,
    callData: op.callData as `0x${string}`,
    accountGasLimits: packU128(bn(op.verificationGasLimit), bn(op.callGasLimit)),
    preVerificationGas: bn(op.preVerificationGas),
    gasFees: packU128(bn(op.maxPriorityFeePerGas), bn(op.maxFeePerGas)),
    paymasterAndData: (op.paymaster
      ? (op.paymaster +
          (packU128(bn(op.paymasterVerificationGasLimit), bn(op.paymasterPostOpGasLimit)) as string).slice(2) +
          (op.paymasterData ?? '0x').slice(2)) as `0x${string}`
      : '0x'),
    signature: op.signature as `0x${string}`,
  };
}

export function startLocalBundler(opts: { anvilUrl: string; bundlerPort: number; beneficiaryKey: string }) {
  const provider = new ethers.JsonRpcProvider(opts.anvilUrl);
  const wallet = new ethers.Wallet(opts.beneficiaryKey, provider);
  const ep = new ethers.Contract(EP07, EP_ABI, wallet);
  const sent = new Map<string, { txHash: string; success: boolean; receipt: unknown }>();

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      const fail = (message: string) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message } }));
      try {
        const j = JSON.parse(body) as { method: string; params: unknown[] };
        const m = j.method;
        console.log('[bundler]', m, JSON.stringify(j.params).slice(0, 120));
        if (m === 'pimlico_getUserOperationGasPrice') {
          const fee = await provider.getFeeData();
          const prio = ethers.parseUnits('1.5', 'gwei');
          const max = (fee.maxFeePerGas ?? 30n * 10n ** 9n) + prio;
          return reply({ slow: { maxFeePerGas: '0x' + max.toString(16), maxPriorityFeePerGas: '0x' + prio.toString(16) },
                         standard: { maxFeePerGas: '0x' + max.toString(16), maxPriorityFeePerGas: '0x' + prio.toString(16) },
                         fast: { maxFeePerGas: '0x' + max.toString(16), maxPriorityFeePerGas: '0x' + prio.toString(16) } });
        }
        if (m === 'eth_estimateUserOperationGas') {
          return reply({ preVerificationGas: '0x' + (120_000).toString(16),
                         verificationGasLimit: '0x' + (1_200_000).toString(16),
                         callGasLimit: '0x' + (1_500_000).toString(16) });
        }
        if (m === 'eth_sendUserOperation') {
          const op = packUserOp(j.params[0] as V7Op);
          try {
            await ep.handleOps.staticCall([op], wallet.address, { gasLimit: 6_000_000 });
          } catch (e) {
            console.log('[bundler] handleOps static revert:', String((e as Error).message ?? e).slice(0, 400));
            throw e;
          }
          const tx = await ep.handleOps([op], wallet.address, { gasLimit: 6_000_000 });
          const rc = await tx.wait();
          // the real userOpHash lives in the UserOperationEvent log
          let hash = '0x' + '0'.repeat(64), success = false;
          for (const l of rc!.logs) {
            if (l.address.toLowerCase() === EP07.toLowerCase() && l.topics[0] === ethers.id('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')) {
              hash = l.topics[1];
            }
          }
          // decode success flag properly via the interface
          const parsed = rc!.logs.map((l: ethers.Log) => { try { return ep.interface.parseLog(l as never); } catch { return null; } })
            .find((p: ethers.LogDescription | null) => p && p.name === 'UserOperationEvent');
          if (parsed) success = Boolean(parsed.args.success);
          sent.set(hash.toLowerCase(), { txHash: tx.hash, success, receipt: rc });
          return reply(hash);
        }
        if (m === 'eth_getUserOperationReceipt') {
          const r = sent.get(String(j.params[0]).toLowerCase());
          if (!r) return reply(null);
          return reply({ userOpHash: j.params[0], sender: '', nonce: '0x0', success: r.success,
                         receipt: { transactionHash: r.txHash, status: r.success ? '0x1' : '0x0' } });
        }
        if (m === 'eth_getUserOperationByHash') return reply(null);
        if (m === 'pm_getPaymasterStubData' || m === 'pm_sponsorUserOperation') {
          return fail('canary_self_pay_no_sponsor');
        }
        // forward anything else (eth_chainId etc.) to the anvil rpc
        const fwd = await fetch(opts.anvilUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        res.end(await fwd.text());
        return;
      } catch (e) {
        return fail(String((e as Error).message ?? e).slice(0, 300));
      }
    });
  });
  server.listen(opts.bundlerPort, '127.0.0.1');
  return server;
}
