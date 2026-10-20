import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { activeChainConfigs, ChainConfig, cfg } from '../src/config/index.js';
import { logger } from '../src/config/logger.js';

/**
 * Deployment lane — executor rollout via CREATE2 through the Kernel
 * smart account (sponsored UserOp, gasless) matching the fleet pattern:
 * same CREATE2 address on every chain, owner = smart account.
 *
 * Venues per chain (Balancer V2 Vault / Aave V3 Pool):
 *   BSC has no Balancer V2 -> vault = address(0), AAVE path only.
 */

const log = logger('deploy');

const VENUES: Record<string, { balancer: string; aave: string }> = {
  eth:  { balancer: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', aave: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' },
  poly: { balancer: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  arb:  { balancer: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  op:   { balancer: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  base: { balancer: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', aave: '0xA238Dd80C259a72e81d7e4664a74715939677ac0' },
  avax: { balancer: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', aave: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  bsc:  { balancer: '0x0000000000000000000000000000000000000000', aave: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB' },
  linea:{ balancer: '0x0000000000000000000000000000000000000000', aave: '0xc47b8C00b0f69a36fa203FeaEafDb1557614C0E6' },
  scroll:{ balancer: '0x0000000000000000000000000000000000000000', aave: '0x11fCfe756c05AD438e312a7fd934381537D3cFfe' },
  blast:{ balancer: '0x0000000000000000000000000000000000000000', aave: '0x0000000000000000000000000000000000000000' },
};

function buildBytecode(): string {
  execFileSync('forge', ['build', '--quiet'], { stdio: 'inherit' });
  const artifact = JSON.parse(
    readFileSync('out/AllBrightExecutor.sol/AllBrightExecutor.json', 'utf8'),
  );
  return artifact.bytecode.object as string;
}

async function deployChain(chain: ChainConfig, bytecode: string) {
  const v = VENUES[chain.key];
  if (!v) { log.warn(`no venues for ${chain.key} — skip`); return; }
  const { AbiCoder, concat, keccak256 } = await import('ethers');
  const ctorArgs = AbiCoder.defaultAbiCoder().encode(
    ['address', 'address'],
    [v.balancer === '0x0000000000000000000000000000000000000000' ? '0x0000000000000000000000000000000000000000' : v.balancer, v.aave],
  );
  const initCode = concat([bytecode, ctorArgs]);
  const salt = keccak256(AbiCoder.defaultAbiCoder().encode(['string'], ['allbright-v1']));

  // Deployment goes through the smart account calling a CREATE2 deployer.
  // NOTE: live deployment is gated — run with DEPLOY=1 and AUTO_EXECUTE funded.
  if (process.env.DEPLOY !== '1') {
    log.info(`${chain.key}: dry-run — initCode ${initCode.slice(0, 66)}… salt ${salt}`);
    log.info(`${chain.key}: venues balancer=${v.balancer} aave=${v.aave}`);
    return;
  }
  const { submitExecUserOp } = await import('../src/exec/pimlico.js');
  // Encode factory call: CREATE2 deployer pattern — place deployer addr here.
  const DEPLOYER = process.env.CREATE2_DEPLOYER;
  if (!DEPLOYER) throw new Error('CREATE2_DEPLOYER env required for live deploy');
  const { ethers } = await import('ethers');
  const data = new ethers.Interface(['function deploy(bytes32 salt, bytes initCode)'])
    .encodeFunctionData('deploy', [salt, initCode]);
  const { poolFor } = await import('../src/providers/rpcPool.js');
  const res = await submitExecUserOp(chain, poolFor(chain), data);
  log.info(`${chain.key} deploy`, res);
}

async function main() {
  const bytecode = buildBytecode();
  for (const chain of activeChainConfigs()) {
    await deployChain(chain, bytecode);
  }
  log.info(`done — smart account ${cfg.SMART_ACCOUNT_ADDRESS}`);
}

main().catch((e) => { log.error('deploy failed', e); process.exit(1); });
