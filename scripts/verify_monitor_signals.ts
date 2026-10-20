import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Signal integrity verifier — validates the first (and every) batch of
 * data/monitor/<chain>_signals.jsonl records the liquidity monitor emits.
 *
 *   npx tsx scripts/verify_monitor_signals.ts
 *
 * Verdicts:
 *   is_simulation:true on EVERY record     — settled-vs-sim separation law
 *   block heights strictly non-decreasing  — monitor can't replay old state
 *   event kinds ⊆ known topic set          — no garbage log decode leaked in
 *   candidate records carry sim verdict    — the gate ran, not just the solver
 */

const SIGNAL_DIR = resolve(process.cwd(), 'data/monitor');
const KNOWN_EVENTS = new Set(['V2_SWAP', 'V2_MINT', 'V2_BURN', 'V3_SWAP', 'V3_MINT', 'V3_BURN', 'unknown']);
const SIM_VERDICTS = new Set(['PASS', 'REVERT', 'OOG']);

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  cond ? pass++ : fail++;
};

if (!existsSync(SIGNAL_DIR)) {
  console.log(`no signal dir yet — monitor hasn't emitted (run scripts/monitor_dex_liquidity.ts)`);
  process.exit(2);
}

const files = readdirSync(SIGNAL_DIR).filter((f) => f.endsWith('_signals.jsonl'));
check('signal files present', files.length > 0, files.join(', ') || 'none found');

for (const file of files) {
  const chain = file.replace(/_signals\.jsonl$/, '');
  const lines = readFileSync(resolve(SIGNAL_DIR, file), 'utf8').split('\n').filter(Boolean);
  const recs: Record<string, unknown>[] = [];
  let badJson = 0;
  for (const l of lines) {
    try { recs.push(JSON.parse(l)); } catch { badJson++; }
  }
  console.log(`\n── ${chain}: ${lines.length} records ──`);
  check(`${chain} all lines parse as JSON`, badJson === 0, `${badJson} corrupt`);
  check(`${chain} every record is_simulation:true`, recs.every((r) => r.is_simulation === true));

  // cycle records vs candidate records
  const cycles = recs.filter((r) => 'block' in r && 'pools_watched' in r);
  const cands = recs.filter((r) => 'candidate' in r);

  const blocks = cycles.map((r) => r.block as number);
  check(`${chain} block heights non-decreasing`, blocks.every((b, i) => i === 0 || b >= blocks[i - 1]));

  const eventKinds = new Set(cycles.flatMap((r) => Object.keys((r.events ?? {}) as Record<string, number>)));
  check(`${chain} event kinds ⊆ known topics`, [...eventKinds].every((k) => KNOWN_EVENTS.has(k)),
    [...eventKinds].join(', ') || 'none yet');

  const missingSim = cands.filter((r) => !('sim' in r));
  check(`${chain} every candidate carries a sim verdict`, missingSim.length === 0,
    `${cands.length} candidate records`);

  const sims = cands.map((r) => (r as { sim: Record<string, unknown> }).sim);
  const execd = sims.filter((s) => SIM_VERDICTS.has(s.status as string));
  const skipped = sims.filter((s) => s.sim_gate === 'skipped_no_executor_deployed');
  const errored = sims.filter((s) => s.sim_gate === 'error');
  console.log(`   sim outcomes: ${execd.length} executed (${execd.filter((s) => s.status === 'PASS').length} PASS), ${skipped.length} no-executor, ${errored.length} errored`);
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
