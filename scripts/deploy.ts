import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { activeChainConfigs, ChainConfig, cfg } from '../src/config/index.js';
import { logger } from '../src/config/logger.js';
import { FLASH_VENUES } from '../src/exec/flashVenues.js';

/**
 * Deployment lane — executor rollout via CREATE2 through the Kernel
 * smart account (sponsored UserOp, gasless) matching the fleet pattern:
 * same CREATE2 address on every chain, owner = smart account.
 *
 * Venues per chain (single source: src/exec/flashVenues.ts):
 *   BALANCER 0% primary | MORPHO 0% | ERC3156 Maker DssFlash 0% (eth/DAI)
 *   | AAVE 0.09% fallback.  BSC has no Balancer V2 -> vault = address(0).
 *
 * ── Base network contract registry (chainId 8453) ─────────────────
 *  Balancer V2 Vault   0xBA12222222228d8Ba445958a75a0704d566BF2C8
 *                      (canonical deterministic Vault — same address
 *                      on every chain; PRIMARY capital source, 0% fee)
 *  Aave V3 Pool        0xa238dd80C259A72E81D7E4664A74715939677AC0
 *                      (SECONDARY fallback loop, 0.09% premium)
 *  Uniswap V3 Factory  0x1F98431c8aD98523631AE4a59f267346ea31F984
 *                      (live in src/discovery/factories.ts base row)
 *  Aerodrome SlipStrm  0x420DD381b31aEf6683db6B902084cB0FFECe40Da
 *                      (Base-native CL factory — discovery lane)
 *  Reference routers   UniV3 SwapRouter02 0x2626664c2603336E57B271c5C0b26F421741e481
 *                      UniV3 QuoterV2     0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a
 *                      Aerodrome Router   0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
 *                      (execution swaps on pool contracts directly —
 *                      routers are documented for ops reference only)
 *
 * ISOLATION GATE: live broadcast requires DEPLOY=1 + CREATE2_DEPLOYER;
 * default path is dry-run (initCode + venues logged, zero broadcast).
 */

const log = logger('deploy');

const VENUES = FLASH_VENUES;

/**
 * DEX router reference map — documentation surface for ops tooling.
 * The executor contract swaps directly on pool contracts inside the
 * flash callback (no router hop), so these are NOT wired into initCode;
 * they exist so audits/monitors can resolve venue routers per chain.
 */
export const DEX_ROUTERS: Record<string, Record<string, string>> = {
  base: {
    uniswapV3SwapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
    uniswapV3QuoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    uniswapV3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    aerodromeRouter: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
    aerodromeFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
  },
  eth: {
    uniswapV3SwapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    uniswapV3QuoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    uniswapV3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    sushiswapRouter: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  },
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
    log.info(`${chain.key}: venues balancer=${v.balancer} aave=${v.aave} morpho=${v.morpho} erc3156=${v.erc3156}`);
    for (const [name, addr] of Object.entries(DEX_ROUTERS[chain.key] ?? {})) {
      log.info(`${chain.key}: router ${name}=${addr}`);
    }
    return;
  }
  const { submitUserOp, awaitUserOp } = await import('../src/exec/pimlico.js');
  const { deployAndTransferOwnership } = await import('../src/exec/deployment.js');
  // Encode factory call: CREATE2 deployer pattern — place deployer addr here.
  const DEPLOYER = process.env.CREATE2_DEPLOYER;
  if (!DEPLOYER) throw new Error('CREATE2_DEPLOYER env required for live deploy');
  const { ethers, keccak256, concat } = await import('ethers');
  const data = new ethers.Interface(['function deploy(bytes32 salt, bytes initCode)'])
    .encodeFunctionData('deploy', [salt, initCode]);
  const { poolFor } = await import('../src/providers/rpcPool.js');

  // Deployment goes directly to the CREATE2 deployer — NOT through
  // submitExecUserOp, which targets chain.executor (chicken-and-egg:
  // you cannot deploy the executor by calling the executor itself).
  const rpc = poolFor(chain);
  const initCodeHash = keccak256(initCode);
  const create2Hash = keccak256(concat([
    '0xff',
    DEPLOYER,
    salt,
    initCodeHash,
  ]));
  const deployedExecutor = '0x' + create2Hash.slice(-40);
  const ownerIface = new ethers.Interface([
    'function transferOwnership(address)',
    'function owner() view returns (address)',
  ]);
  const ownerData = ownerIface.encodeFunctionData('transferOwnership', [
    cfg.SMART_ACCOUNT_ADDRESS,
  ]);

  // Do not submit ownership transfer until deployment is mined and code
  // exists; an eth_call to the predicted empty address would otherwise pass.
  await deployAndTransferOwnership({
    submitDeployment: async () => {
      const result = await submitUserOp(chain, rpc, DEPLOYER, data);
      log.info(`${chain.key} deploy CREATE2`, result);
      return result;
    },
    waitForUserOp: (hash) => awaitUserOp(chain, hash),
    getCode: () => rpc.call<string>('eth_getCode', [deployedExecutor, 'latest']),
    submitOwnershipTransfer: async () => {
      const result = await submitUserOp(chain, rpc, deployedExecutor, ownerData);
      log.info(`${chain.key} transferOwnership -> ${cfg.SMART_ACCOUNT_ADDRESS}`, result);
      return result;
    },
    getOwner: async () => {
      const result = await rpc.callContract(
        deployedExecutor,
        ownerIface.encodeFunctionData('owner'),
      );
      return String(ownerIface.decodeFunctionResult('owner', result)[0]);
    },
    expectedOwner: cfg.SMART_ACCOUNT_ADDRESS,
  });
  log.info(`${chain.key} executor deployed at ${deployedExecutor} and owned by smart account`);
}

async function main() {
  const bytecode = buildBytecode();
  for (const chain of activeChainConfigs()) {
    await deployChain(chain, bytecode);
  }
  log.info(`done — smart account ${cfg.SMART_ACCOUNT_ADDRESS}`);
}

main().catch((e) => { log.error('deploy failed', e); process.exit(1); });
