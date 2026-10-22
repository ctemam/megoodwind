/**
 * WO-2 proof: DIAG_ONLY structurally cannot reach the send path.
 *
 * Asserts:
 *  1. DIAG_ONLY=1 forces AUTO_EXECUTE=false at config load even when the
 *     env arms it.
 *  2. executeCandidate returns before touching rpc / scheduler / probe —
 *     every collaborator is a throwing stub; any call fails the test.
 *  3. The only side effect is the bounded diag_exec_skipped counter.
 */
export {};

process.env.DIAG_ONLY = '1';
process.env.AUTO_EXECUTE = 'true';              // armed on purpose — must lose
process.env.PRIVATE_KEY = '0x' + '1'.repeat(64); // schema-required, dummy

const { cfg } = await import('../src/config/index.js');
const { executeCandidate } = await import('../src/exec/executor.js');
const { metrics } = await import('../src/telemetry/metrics.js');

const fail = (msg: string): never => { throw new Error(`DIAG_ONLY breached: ${msg}`); };
const assert = (cond: boolean, msg: string) => { if (!cond) fail(msg); };

assert(cfg.DIAG_ONLY === true, 'cfg.DIAG_ONLY not true');
assert(cfg.AUTO_EXECUTE === false, `AUTO_EXECUTE survived DIAG_ONLY: ${cfg.AUTO_EXECUTE}`);

const chain = { key: 'eth', chainId: 1, executor: '0x6614ecc774e4d5d595a6403058e2a0792f72025a' } as never;
const rpc = new Proxy({}, {
  get: (_t, prop) => () => fail(`rpc.${String(prop)} called`),
}) as never;
const scheduler = new Proxy({}, {
  get: (_t, prop) => () => fail(`scheduler.${String(prop)} called`),
}) as never;
const cand = new Proxy({}, { get: (_t, prop) => prop === 'variant' ? {} : 0n }) as never;

const before = metrics.counterSum('diag_exec_skipped');
await executeCandidate(chain, rpc, cand, scheduler);
assert(metrics.counterSum('diag_exec_skipped') === before + 1, 'diag_exec_skipped not incremented');
assert(metrics.counterSum('arb_probe_pass_total') === 0, 'probe ran under DIAG_ONLY');
assert(metrics.counterSum('arb_submit_total') === 0, 'submit ran under DIAG_ONLY');

console.log('PASS diag_only: AUTO_EXECUTE forced false; executeCandidate structurally unreachable');
process.exit(0);
