/** WO-5 step 0 — canary surfaces must be INERT when the active chain is
 *  not the 31337 fork. Each case boots config in a subprocess with a
 *  controlled env (same harness as bool_env_test). */
import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

const probe = (env: Record<string, string>): Record<string, unknown> => {
  const probeEnv: Record<string, string> = {
    PATH: process.env.PATH!, NODE_ENV: 'test',
    DOTENV_CONFIG_PATH: '.env.canary_probe',
    PRIVATE_KEY: '0x' + 'ab'.repeat(32),
    PROFIT_WALLET: '0x' + 'cd'.repeat(20),
    SMART_ACCOUNT_ADDRESS: '0x' + 'ef'.repeat(20),
    PIMLICO_API_KEY: 'testkey',
    ...env,
  };
  writeFileSync('.env.canary_probe', 'DUMMY=1\n');
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'test/_canary_probe.ts'], {
      env: probeEnv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const line = out.trim().split('\n').pop()!;
    return JSON.parse(line);
  } finally {
    if (existsSync('.env.canary_probe')) unlinkSync('.env.canary_probe');
  }
};

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail: unknown) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} -> ${JSON.stringify(detail)}`); }
};

// --- case A: active chain = eth (chainId 1), canary envs all set -------
{
  const r = probe({
    ACTIVE_CHAINS: 'eth',
    ETH_RPC_URLS: 'https://eth-mainnet.example.com/dkey=abc',
    ALLBRIGHT_EXECUTOR_ETH: '0x' + '11'.repeat(20),
    BUNDLER_URL: 'http://127.0.0.1:8546',
    CANARY_SELF_PAY: '1',
  });
  const unselectable = r.pickFlashSource_canary === 'AAVE' || String(r.pickFlashSource_canary).startsWith('THROWS');
  check('BUNDLER_URL ignored on eth', r['bundlerUrl:eth'] === 'PIMLICO', r['bundlerUrl:eth']);
  check('CANARY_SELF_PAY off on eth', r['selfPay:eth'] === false, r['selfPay:eth']);
  check('canary venue row unselectable', unselectable, r.pickFlashSource_canary);
  check('loopback refused by default', r.assertPrivateUrl_loopback_default === 'REFUSED', r);
}

// --- case B: ACTIVE_CHAINS=canary CHAIN_ID_CANARY=31337 ----------------
{
  const r = probe({
    ACTIVE_CHAINS: 'canary',
    CHAIN_ID_CANARY: '31337',
    CANARY_RPC_URLS: 'http://127.0.0.1:8545',
    ALLBRIGHT_EXECUTOR_CANARY: '0x' + '22'.repeat(20),
    BUNDLER_URL: 'http://127.0.0.1:8546',
    CANARY_SELF_PAY: '1',
  });
  check('BUNDLER_URL honored on 31337', r['bundlerUrl:canary'] === 'http://127.0.0.1:8546', r['bundlerUrl:canary']);
  check('CANARY_SELF_PAY on at 31337', r['selfPay:canary'] === true, r['selfPay:canary']);
  check('canary venue selectable', r.pickFlashSource_canary === 'BALANCER', r.pickFlashSource_canary);
  check('loopback ok on canary cfg', r['loopback_cfg:canary'] === 'OK', r);
}

// --- case C: eth chain with a LOOPBACK rpc — must refuse ---------------
{
  const r = probe({
    ACTIVE_CHAINS: 'eth',
    ETH_RPC_URLS: 'http://127.0.0.1:8545',
    ALLBRIGHT_EXECUTOR_ETH: '0x' + '33'.repeat(20),
    BUNDLER_URL: 'http://127.0.0.1:8546',
    CANARY_SELF_PAY: '1',
  });
  const refused = typeof r['loopback_cfg:eth'] === 'string' && String(r['loopback_cfg:eth']).startsWith('REFUSED');
  check('eth loopback rpc refused', refused, r['loopback_cfg:eth']);
  // bundlerUrl is unreachable once boot refuses — either state counts as inert
  const bundlerInert = r['bundlerUrl:eth'] === 'PIMLICO' || String(r['bundlerUrl:eth']).startsWith('REFUSED');
  check('BUNDLER_URL still inert on eth', bundlerInert, r['bundlerUrl:eth']);
  const unsel = r.pickFlashSource_canary === 'AAVE' || String(r.pickFlashSource_canary).startsWith('THROWS');
  check('canary venue row unselectable', unsel, r.pickFlashSource_canary);
}

// --- case D: ACTIVE_CHAINS=canary WITHOUT chain-id 31337 ---------------
// A canary key pointing at a non-31337 id must NOT unlock the surfaces.
{
  const r = probe({
    ACTIVE_CHAINS: 'canary',
    CHAIN_ID_CANARY: '56',
    CANARY_RPC_URLS: 'https://bsc.example.com/dkey=abc',
    ALLBRIGHT_EXECUTOR_CANARY: '0x' + '44'.repeat(20),
    BUNDLER_URL: 'http://127.0.0.1:8546',
    CANARY_SELF_PAY: '1',
  });
  check('BUNDLER_URL ignored when id!=31337', r['bundlerUrl:canary'] === 'PIMLICO', r['bundlerUrl:canary']);
  check('CANARY_SELF_PAY off when id!=31337', r['selfPay:canary'] === false, r['selfPay:canary']);
  check('canary venue unselectable when id!=31337', r.pickFlashSource_canary === 'AAVE', r.pickFlashSource_canary);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
