import 'dotenv/config';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * State-transition smoke test — proves the SUSPENDED -> LIVE promotion
 * path end-to-end WITHOUT touching the live rpc_pool_config.json (the
 * sync daemon owns that file). Uses a scratch config via
 * RPC_POOL_CONFIG_PATH so the loader's hot-reload picks each flip.
 *
 *   npx tsx test/rpc_config_transition.ts
 */

const SCRATCH = resolve(process.cwd(), 'test/_scratch_pool_config.json');
process.env.RPC_POOL_CONFIG_PATH = SCRATCH;

const base = {
  provider_catalog: {
    chainstack: { safe_rps: 22.5, status: 'SUSPENDED_CONSOLE_ATTACH_PENDING', supported_chains: [], priority: 99 },
    alchemy: { status: 'LIVE_RESTRICTED_L1_ONLY', supported_chains: ['eth'], priority: 2 },
  },
};

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? pass++ : fail++;
};

// late import so the env override is set before the module resolves the path
const { keyedEndpointsFor } = await import('../src/providers/providerCatalog.js');
const { reloadPoolConfig, isSuspended } = await import('../src/providers/rpcPoolConfig.js');

// Phase 1 — SUSPENDED emits zero chainstack endpoints on every chain
writeFileSync(SCRATCH, JSON.stringify(base));
reloadPoolConfig();
let csCount = 0;
for (const c of ['eth', 'arb', 'bsc', 'poly', 'base']) {
  csCount += keyedEndpointsFor(c).filter((e) => e.provider === 'chainstack').length;
}
check('SUSPENDED chainstack emits 0 endpoints across 5 chains', csCount === 0);
check('isSuspended("chainstack") === true', isSuspended('chainstack'));

// Phase 2 — flip to LIVE => endpoints emit on whitelisted chains
const promoted = JSON.parse(JSON.stringify(base));
promoted.provider_catalog.chainstack = { status: 'LIVE', supported_chains: ['eth', 'arb'], daily_budget: 100000, priority: 2 };
writeFileSync(SCRATCH, JSON.stringify(promoted));
reloadPoolConfig();
const ethCs = keyedEndpointsFor('eth').filter((e) => e.provider === 'chainstack').length;
const arbCs = keyedEndpointsFor('arb').filter((e) => e.provider === 'chainstack').length;
const bscCs = keyedEndpointsFor('bsc').filter((e) => e.provider === 'chainstack').length;
check('LIVE chainstack emits eth endpoint', ethCs === 1);
check('LIVE chainstack emits arb endpoint (whitelisted)', arbCs === 1);
check('LIVE chainstack emits NO bsc endpoint (not whitelisted)', bscCs === 0);

// Phase 3 — whitelist: alchemy emits on eth, never on L2
const alchEth = keyedEndpointsFor('eth').filter((e) => e.provider === 'alchemy').length;
const alchArb = keyedEndpointsFor('arb').filter((e) => e.provider === 'alchemy').length;
check('L1-restricted alchemy emits eth', alchEth === 1);
check('L1-restricted alchemy emits NO arb', alchArb === 0);

// Phase 4 — torn write mid-edit keeps LAST GOOD config (partial-write safety)
writeFileSync(SCRATCH, JSON.stringify(base).slice(0, 60)); // truncated JSON
reloadPoolConfig();
const tornCs = keyedEndpointsFor('eth').filter((e) => e.provider === 'chainstack').length;
check('torn JSON keeps last-good config (chainstack still LIVE on eth)', tornCs === 1);

unlinkSync(SCRATCH);
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
