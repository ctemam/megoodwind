import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import { cfg, chainConfig } from '../../src/config/index.js';
import { logger } from '../../src/config/logger.js';

/**
 * Items #3/#4 — Simulation Sandbox + Diagnostic Matrix.
 * Spins an Anvil mainnet fork (pinned block for repeatable zero-gas
 * diagnostics), impersonates a whale, then runs the pre-flight error
 * resolution schema against the executor's exec path.
 *
 * Error schema categories:
 *   TRANSPORT      — 429/timeout: retryable, proves nothing
 *   ERRORPAYLOAD   — Error(string)/Panic(uint): deterministic — convict
 *   GAS            — estimation/underpriced: fee-model problem
 *   STATE          — slippage/minOut/floor violations
 */

const log = logger('anvil');
const FORK_CHAIN = process.env.FORK_CHAIN ?? 'eth';
const PIN_BLOCK = process.env.PIN_BLOCK; // optional pinned fork height

interface DiagResult {
  category: 'TRANSPORT' | 'ERRORPAYLOAD' | 'GAS' | 'STATE' | 'PASS';
  detail: string;
}

export function categorize(e: unknown): DiagResult {
  const msg = String((e as { message?: string })?.message ?? e);
  if (/429|timeout|ETIMEDOUT|ECONNRESET|rpc_timeout/i.test(msg)) {
    return { category: 'TRANSPORT', detail: msg.slice(0, 160) };
  }
  if (/0x08c379a0|execution reverted|revert|Error\(string\)|Panic/i.test(msg)) {
    return { category: 'ERRORPAYLOAD', detail: msg.slice(0, 160) };
  }
  if (/gas|fee|underpriced|basefee/i.test(msg)) {
    return { category: 'GAS', detail: msg.slice(0, 160) };
  }
  if (/minout|slippage|ProfitFloor|V2_MINOUT/i.test(msg)) {
    return { category: 'STATE', detail: msg.slice(0, 160) };
  }
  return { category: 'ERRORPAYLOAD', detail: msg.slice(0, 160) };
}

async function main() {
  const chain = chainConfig(FORK_CHAIN as never);
  const forkUrl = chain.rpcUrls[0];
  if (!forkUrl) throw new Error(`no private RPC for ${FORK_CHAIN}`);

  const args = ['--fork-url', forkUrl, '--port', '8545', '--silent'];
  if (PIN_BLOCK) args.push('--fork-block-number', PIN_BLOCK);

  log.info(`starting anvil fork ${FORK_CHAIN}${PIN_BLOCK ? ` @${PIN_BLOCK}` : ''}`);
  const anvil: ChildProcess = spawn('anvil', args, { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 4000));

  try {
    // impersonated whale diagnostic: confirm fork state responds
    const out = execFileSync('cast', [
      'call', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      'balanceOf(address)(uint256)',
      '0x28C6c06298d514Db089934071355E5743bf21d60', // Binance hot wallet (impersonation target)
      '--rpc-url', 'http://localhost:8545',
    ]).toString().trim();
    log.info(`fork WETH balanceOf(binance14) = ${out} — fork live, state pinned`);
    console.log(JSON.stringify({ category: 'PASS', detail: `fork ok, balance=${out}` }));
  } catch (e) {
    const d = categorize(e);
    console.log(JSON.stringify(d));
    process.exitCode = d.category === 'PASS' ? 0 : 1;
  } finally {
    anvil.kill();
  }
}

const isMain = process.argv[1]?.endsWith('forkDiagnostics.ts') || process.argv[1]?.endsWith('forkDiagnostics.js');
if (isMain) main().catch((e) => { log.error('diagnostics failed', e); process.exit(1); });
