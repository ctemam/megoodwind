/** WO-12 — recompute data/allocation.json from measured diag data. */
import { computeAllocation } from '../src/alloc/allocation.js';
const lanes = computeAllocation();
for (const l of lanes.slice(0, 12)) {
  console.log(`${l.chain.padEnd(7)} ${l.lane.padEnd(13)} score=${l.score.toExponential(2)} $/day=${l.observedUsdPerDay.toFixed(2)} probeRate=${l.probePassRate.toExponential(2)} settleRate=${l.execSettleRate.toFixed(2)} dataH=${l.dataHours.toFixed(1)}`);
}
console.log(`wrote data/allocation.json (${lanes.length} lane-scores)`);
