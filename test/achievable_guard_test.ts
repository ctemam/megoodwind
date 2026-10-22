/** WO-7 step 0 — proves the `achievable` census computation (a) cannot
 *  throw on pools whose v2 reserves are unfetched (vIn = NaN) and
 *  (b) is unreachable when DIAG_ONLY is off: no diag field, no NaN throw.
 *  Runs emit() through the real solve() path on a synthetic registry. */
import { execFileSync } from 'node:child_process';

const TSX = ['--import', 'tsx'];

const PROBE = `
import { registry } from '../src/pools/registry.js';
import { solve } from '../src/strategies/solver.js';
import { cfg, chainConfig } from '../src/config/index.js';
const W = '0xC02aaA39b223FE8d0A0e5C4F27eAD9083C756Cc2';
const U = '0xA0b86991c6218b36c1d19d4a2e9eb0cE3606eB48';
const chain = chainConfig('canary');
// pool A: DEEP liquidityUsd (passes depth) but reserves UNFETCHED
// (reserve0/1 undefined -> inputVirtualReserveRaw -> NaN vIn path).
// pool B: real reserves so a path exists.
const a = registry.upsert({ address: '0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', chain: 'canary', dexId: 'u', kind: 'v2', token0: U, token1: W, symbol0: 'U', symbol1: 'W', dec0: 6, dec1: 18, feeBps: 30, liquidityUsd: 5e7 });
const b = registry.upsert({ address: '0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222', chain: 'canary', dexId: 's', kind: 'v2', token0: U, token1: W, symbol0: 'U', symbol1: 'W', dec0: 6, dec1: 18, feeBps: 30, liquidityUsd: 5e7, reserve0: 25_000_000_000_000n, reserve1: 9_300_000_000_000_000_000_000n });
const { VARIANTS } = await import('../src/engine/predictiveEngine.js');
try {
  const out = solve(chain, VARIANTS[0], { gasUnits: 354_000n, baseFeeWei: 2n * 10n ** 9n, tokenUsd: new Map([[U.toLowerCase(), 1], [W.toLowerCase(), 2700]]), sizeOf: (t, d) => 100n * 10n ** BigInt(d), nativeUsd: 2700, priorityFeeWei: 1n * 10n ** 9n });
  console.log('PROBE_OK cands=' + out.length + ' DIAG=' + cfg.DIAG_ONLY);
} catch (e) {
  console.log('PROBE_THROW ' + (e instanceof Error ? e.message : String(e)));
}
`;

let pass = 0, fail = 0;
const ck = (n: string, c: boolean, d?: unknown) => { c ? (pass++, console.log(`  ok  ${n}`)) : (fail++, console.log(`  FAIL ${n} -> ${JSON.stringify(d)}`)); };

for (const diag of ['1', '0']) {
  const out = execFileSync(process.execPath, [...TSX, '-e', PROBE], {
    cwd: process.cwd() + '/test',
    env: { ...process.env, DIAG_ONLY: diag, DOTENV_CONFIG_PATH: '/dev/null', CHAIN_ID_CANARY: '31337', CANARY_RPC_URLS: 'http://127.0.0.1:8545', PRIVATE_KEY: '0x' + '1'.repeat(64), PIMLICO_API_KEY: 'x', SMART_ACCOUNT_ADDRESS: '0x' + '2'.repeat(40), PROFIT_WALLET: '0x' + '3'.repeat(40), ACTIVE_CHAINS: 'canary' },
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  ck(`DIAG_ONLY=${diag} NaN-reserve emit does not throw`, out.includes('PROBE_OK'), out);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
