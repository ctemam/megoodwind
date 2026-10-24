/** Seed verified hypotheses from WO-07 evidence. Run: npx tsx scripts/ci_seed_hypotheses.ts */
import { HypothesisRegister } from '../src/ci/hypotheses.js';
import { ChangeControl } from '../src/ci/changeControl.js';
const reg = HypothesisRegister.load('data/ci/hypotheses.json', new ChangeControl());
if (!reg.get('H-001')) {
  reg.register({
    id: 'H-001', description: 'Expand pool discovery beyond the 207-pool registry (additional factory matrices + creation-log coverage)',
    source: 'WO-07 attribution, eth 80-blk window @mc-v1, commit 128a73f',
    observed: 'visibility_failure=26/34 receipt-verified competitor arbs — routes touch pools absent from registry',
    inferred: 'broader discovery recovers stage-1 coverage; does NOT prove recovered routes are profitable',
    confidence: 0.8, family: 'coverage', chains: ['eth', 'base'],
    mechanism: 'more factories/pools discovered → fewer visibility_failure attributions → more candidates reach projection',
    alternatives: ['added pools may be bait/stale/illiquid', 'added coverage may not yield profitable routes', 'registry gap may be deliberate venue exclusion'],
    requirements: { protocols: ['additional DEX factories'], feeds: ['token lists'], cost: 'bounded RPC calls (Multicall3-batched)' },
    constraints: ['no manual pool seeding', 'forensics gates unchanged', 'data-quality denominators preserved per mc-v1'],
    acceptance: { metric: 'visibility_failure_rate', direction: 'lt', threshold: 0.5, minSample: 20 },
    rollback: 'revert factory registry addition; drop added pools from solver universe',
    status: undefined as any, history: undefined as any,
  });
  reg.setBaseline('H-001', { metric: 'visibility_failure_rate', value: 0.765, window: 'eth 80-blk @mc-v1 (26/34)' });
}
if (!reg.get('H-002')) {
  reg.register({
    id: 'H-002', description: 'Pinned-block counterfactual replay for the 8 indeterminate attributions',
    source: 'WO-07 attribution, eth 80-blk window, commit 128a73f',
    observed: 'indeterminate=8 — in-registry/partial routes with unresolved counterfactual executability',
    inferred: 'some may convert to confirmed_missed or not_economically_viable under replay',
    confidence: 0.5, family: 'attribution', chains: ['eth'],
    mechanism: 'fork-replay at pinned block resolves counterfactual → upgrades indeterminate to a causal outcome',
    alternatives: ['replay may fail on state reconstruction', 'timing/ordering advantage not reproducible'],
    requirements: { feeds: ['archive RPC at pinned block'], cost: 'Anvil fork runs' },
    constraints: ['replay evidence labeled estimated-vs-verified', 'no decision-time lookahead'],
    acceptance: { metric: 'indeterminate_rate', direction: 'lt', threshold: 0.1, minSample: 8 },
    rollback: 'none — replay is read-only evaluation',
    status: undefined as any, history: undefined as any,
  });
  reg.setBaseline('H-002', { metric: 'indeterminate_rate', value: 0.235, window: 'eth 80-blk @mc-v1 (8/34)' });
}
reg.save('data/ci/hypotheses.json');
for (const h of reg.all()) console.log(`${h.id} [${h.status}] ${h.description.slice(0, 80)} | baseline ${h.baseline?.metric}=${h.baseline?.value}`);
