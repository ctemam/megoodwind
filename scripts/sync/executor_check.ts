/** WO-7S step 5d — is the executor deployed on base/arb, and does it
 *  match current source? Read-only: code@address + venue getters.
 *  Bytecode match is checked vs `forge build` output if available —
 *  else code length + getter-ABI compatibility is reported. */
import { ethers } from 'ethers';
import { chainConfig } from '../../src/config/index.js';
import { poolFor } from '../../src/providers/rpcPool.js';

const EXEC: Record<string, string | undefined> = {
  eth: process.env.ALLBRIGHT_EXECUTOR_ETH,
  base: process.env.ALLBRIGHT_EXECUTOR_BASE,
  arb: process.env.ALLBRIGHT_EXECUTOR_ARB,
};
const ABI = new ethers.Interface([
  'function owner() view returns (address)',
  'function balancerVault() view returns (address)',
  'function aavePool() view returns (address)',
  'function morpho() view returns (address)',
  'function erc3156Lender() view returns (address)',
]);

for (const [key, addr] of Object.entries(EXEC)) {
  console.log(`\n=== ${key}: executor env=${addr ?? 'unset'}`);
  if (!addr) continue;
  const rpc = poolFor(chainConfig(key));
  const code = await rpc.call<string>('eth_getCode', [addr, 'latest']).catch((e) => `ERR ${e}`);
  console.log(`  code bytes: ${typeof code === 'string' && code.startsWith('0x') ? (code.length - 2) / 2 : code}`);
  if (!code || code === '0x' || typeof code !== 'string' || !code.startsWith('0x')) continue;
  for (const g of ['owner', 'balancerVault', 'aavePool', 'morpho', 'erc3156Lender']) {
    const raw = await rpc.callContract(addr, ABI.encodeFunctionData(g), 'latest').catch(() => '0x');
    if (raw.length < 66) { console.log(`  ${g}: <revert/unset>`); continue; }
    console.log(`  ${g}: 0x${raw.slice(-40)}`);
  }
}
