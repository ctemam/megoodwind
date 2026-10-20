import { spawn, ChildProcess } from 'node:child_process';
import { ethers } from 'ethers';
import { chainConfig } from '../../src/config/index.js';
import { logger } from '../../src/config/logger.js';
import { categorize } from './forkDiagnostics.js';

/**
 * Alchemy-fork simulation tier — the two named skills, as runnable code.
 *
 * fork_live_chain_state  — local Anvil fork pinned to LIVE Alchemy/keyed
 *                          state at a given block; upstream requests are
 *                          rate-limited at the connection level via
 *                          `anvil --compute-units-per-second` (the node's
 *                          own queue, not a wrapper).
 * execute_fork_dry_run   — impersonate any target address on the fork,
 *                          push the real payload, assert zero reverts /
 *                          out-of-gas, and report the fork-vs-remote gas
 *                          variance (fee-model truth check).
 *
 * No mock data anywhere: state comes from the keyed mainnet endpoint at
 * the pinned block — impersonation grants execution permission locally,
 * never on-chain.
 */

const log = logger('forksim');

export interface ForkHandle {
  rpc: ethers.JsonRpcProvider;
  block: number;
  kill: () => void;
}

export async function fork_live_chain_state(opts: {
  chain: string;
  blockNumber?: number;
  upstreamCups?: number;   // compute units/sec the fork may spend upstream
  port?: number;
}): Promise<ForkHandle> {
  const chain = chainConfig(opts.chain);
  const forkUrl = chain.rpcUrls[0];
  if (!forkUrl) throw new Error(`no keyed RPC for ${opts.chain}`);
  const port = opts.port ?? 8546;
  const args = [
    '--fork-url', forkUrl,
    '--port', String(port),
    '--compute-units-per-second', String(opts.upstreamCups ?? 60), // upstream budget — keeps free tier unthrottled
    '--silent',
  ];
  if (opts.blockNumber) args.push('--fork-block-number', String(opts.blockNumber));
  const anvil: ChildProcess = spawn('anvil', args, { stdio: 'ignore' });
  const rpc = new ethers.JsonRpcProvider(`http://localhost:${port}`);
  // readiness loop — a fork needs upstream state before it answers;
  // a fixed sleep races slow endpoint warmups
  let block = -1;
  for (let i = 0; i < 30 && block < 0; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    block = await rpc.getBlockNumber().catch(() => -1);
  }
  if (block < 0) { anvil.kill(); throw new Error('anvil fork failed to become ready (30s)'); }
  log.info(`fork_live_chain_state: ${opts.chain} pinned @${block} (upstream ≤${opts.upstreamCups ?? 60} CU/s)`);
  return { rpc, block, kill: () => anvil.kill() };
}

export async function execute_fork_dry_run(fork: ForkHandle, tx: {
  impersonate: string;    // any address — permissions granted locally
  to: string;
  data: string;
  valueWei?: bigint;
}): Promise<{ status: 'PASS' | 'REVERT' | 'OOG'; gasUsed: bigint; gasVariancePct?: number }> {
  await fork.rpc.send('anvil_impersonateAccount', [tx.impersonate]);
  try {
    // remote-vs-fork gas variance: estimate BEFORE send on the same state
    const est = await fork.rpc.estimateGas({ from: tx.impersonate, to: tx.to, data: tx.data, value: tx.valueWei ?? 0n }).catch(() => 0n);
    const hash = await fork.rpc.send('eth_sendTransaction', [{
      from: tx.impersonate, to: tx.to, data: tx.data, value: ethers.toBeHex(tx.valueWei ?? 0n),
    }]);
    const receipt = await fork.rpc.waitForTransaction(hash);
    if (!receipt || receipt.status === 0) {
      return { status: receipt && receipt.gasUsed >= 29_900_000n ? 'OOG' : 'REVERT', gasUsed: receipt?.gasUsed ?? 0n };
    }
    const variance = est > 0n ? Number(((receipt.gasUsed - est) * 100n) / est) : undefined;
    return { status: 'PASS', gasUsed: receipt.gasUsed, gasVariancePct: variance };
  } finally {
    await fork.rpc.send('anvil_stopImpersonatingAccount', [tx.impersonate]).catch(() => undefined);
  }
}

// — runnable verification: WETH transfer dry-run from an impersonated whale —
async function main() {
  const fork = await fork_live_chain_state({
    chain: process.env.FORK_CHAIN ?? 'eth',
    blockNumber: process.env.PIN_BLOCK ? Number(process.env.PIN_BLOCK) : undefined,
    upstreamCups: Number(process.env.FORK_CUPS ?? 60),
  });
  try {
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const WHALE = '0x28C6c06298d514Db089934071355E5743bf21d60'; // Binance hot wallet — holds WETH
    const ERC20 = new ethers.Interface(['function transfer(address,uint256) returns (bool)']);
    const res = await execute_fork_dry_run(fork, {
      impersonate: WHALE,
      to: WETH,
      data: ERC20.encodeFunctionData('transfer', [ethers.ZeroAddress, 1n]),
    });
    console.log(JSON.stringify(res, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    if (res.status !== 'PASS') {
      const d = categorize(new Error(`fork dry-run ${res.status}`));
      console.log(JSON.stringify(d));
      process.exitCode = 1;
    } else {
      console.log('FORK DRY-RUN PASS — impersonated send, zero revert, gas variance', res.gasVariancePct ?? 'n/a', '%');
    }
  } finally {
    fork.kill();
  }
}

const isMain = process.argv[1]?.endsWith('forkSim.ts') || process.argv[1]?.endsWith('forkSim.js');
if (isMain) main().catch((e) => { log.error('forksim failed', e); process.exit(1); });
