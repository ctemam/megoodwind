/**
 * WO-3 fail-closed config — full boolean matrix + ARM_LIVE gating.
 * Each case runs in a subprocess (cfg is a load-time singleton) with an
 * empty dotenv file so .env can't contaminate the case.
 *
 * Matrix per boolean field: false/0/no/off -> false | TRUE/1 -> true |
 * unset -> schema default | flase -> refuse | "" -> refuse.
 * Arming: LIVE only when AUTO_EXECUTE parses true AND chainId ∈ ARM_LIVE.
 * DIAG_ONLY forces disarmed regardless.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export {};

const EMPTY = join(process.cwd(), 'test', '.empty_env');
writeFileSync(EMPTY, '');

const BASE: Record<string, string> = {
  PRIVATE_KEY: '0x' + '1'.repeat(64),
  PIMLICO_API_KEY: 'probe',
  SMART_ACCOUNT_ADDRESS: '0x' + '2'.repeat(40),
  PROFIT_WALLET: '0x' + '3'.repeat(40),
  DOTENV_CONFIG_PATH: EMPTY, // isolate from .env
};

type Probe = {
  armedChains: number[]; armedFor1: boolean; armedFor56: boolean; armedFor137: boolean;
} & Record<string, boolean | number[]>;

let pass = 0, failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} ${detail}`); }
};

function probe(env: Record<string, string>): { out?: Probe; refused: boolean; err: string } {
  try {
    const s = execFileSync(process.execPath, ['--import', 'tsx', 'test/_cfg_probe.ts'], {
      env: { ...process.env, ...BASE, ...env },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = s.trim().split('\n').pop() ?? '';
    return { out: JSON.parse(line) as Probe, refused: false, err: '' };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return { refused: true, err: (err.stderr ?? '') + (err.stdout ?? '') };
  }
}

// Every boolEnv field must appear here — generated to match the schema:
// {name, default} for each BOOL_FIELDS entry. If a new boolean flag is
// added to config/index.ts, add its default here or it goes untested.
const FIELDS = [
  { name: 'AUTO_EXECUTE', def: false },
  { name: 'DIAG_ONLY', def: false },
  { name: 'STRICT_PROFIT_FLOOR_GUARD', def: true },
  { name: 'P09_ENABLED', def: false },
  { name: 'MEM_WATCH', def: false },
] as const;

for (const f of FIELDS) {
  console.log(`== ${f.name} (default ${f.def})`);
  for (const [v, want] of [['false', false], ['0', false], ['no', false], ['off', false], ['TRUE', true], ['1', true]] as const) {
    const r = probe({ [f.name]: v });
    check(`${f.name}="${v}" -> ${want}`, !r.refused && r.out?.[f.name] === want, r.err.slice(0, 200));
  }
  const u = probe({}); // unset
  check(`${f.name} unset -> default ${f.def}`, !u.refused && u.out?.[f.name] === f.def, u.err.slice(0, 200));
  for (const bad of ['flase', '']) {
    const r = probe({ [f.name]: bad });
    check(`${f.name}="${bad}" -> refuse to start`, r.refused && r.err.includes(f.name), (r.refused ? r.err.split('\n').find((l) => l.includes(f.name)) ?? '' : 'NO REFUSAL').slice(0, 160));
  }
}

console.log('== schema coverage');
{
  const u = probe({});
  const flagKeys = Object.keys(u.out ?? {}).filter((k) => !k.startsWith('armed'));
  const missing = flagKeys.filter((k) => !FIELDS.some((f) => f.name === k));
  check('every schema boolEnv field is in the test matrix', missing.length === 0, `untested: ${missing.join(',')}`);
}

console.log('== ARM_LIVE gating');
{
  const r = probe({ AUTO_EXECUTE: 'true' }); // no ARM_LIVE
  check('AUTO_EXECUTE=true, ARM_LIVE unset -> armedFor(1)=false', !r.refused && r.out?.armedFor1 === false);
}
{
  const r = probe({ AUTO_EXECUTE: 'true', ARM_LIVE: '1' });
  check('ARM_LIVE=1 -> armedFor(1)=true', !r.refused && r.out?.armedFor1 === true);
  check('ARM_LIVE=1 -> armedFor(56)=false', !r.refused && r.out?.armedFor56 === false);
}
{
  const r = probe({ AUTO_EXECUTE: 'true', ARM_LIVE: '1,56,137' });
  check('ARM_LIVE=1,56,137 arms all three', !r.refused && !!r.out && r.out.armedFor1 && r.out.armedFor56 && r.out.armedFor137);
}
{
  const r = probe({ AUTO_EXECUTE: 'true', ARM_LIVE: 'garbage' });
  check('ARM_LIVE=garbage -> disarmed', !r.refused && r.out?.armedFor1 === false && r.out.armedChains.length === 0);
}
{
  const r = probe({ AUTO_EXECUTE: 'true', ARM_LIVE: '1,abc,56' });
  check('ARM_LIVE with one bad token -> disarmed', !r.refused && r.out?.armedChains.length === 0);
}
{
  const r = probe({ AUTO_EXECUTE: 'true', DIAG_ONLY: '1', ARM_LIVE: '1' });
  check('DIAG_ONLY forces disarmed even with AUTO_EXECUTE+ARM_LIVE', !r.refused && r.out?.AUTO_EXECUTE === false && r.out.armedFor1 === false);
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
