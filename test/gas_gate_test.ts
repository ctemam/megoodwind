/** WO-5 steps 2+3 unit checks — route gas table and the belowGasMultiple
 *  boundary (K from config, strict less-than, zero-gas pass). */
import { belowGasMultiple } from '../src/math/profit.js';
import { routeGasUnits, GAS_TABLE } from '../src/exec/gasModel.js';

let pass = 0, fail = 0;
const ck = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} -> ${JSON.stringify(detail)}`); }
};

// --- below_gas_multiple boundaries (K = 1.5) -------------------------
ck('gross < K*gas rejects', belowGasMultiple(10, 10, 1.5) === true);
ck('gross == K*gas passes', belowGasMultiple(15, 10, 1.5) === false);
ck('gross > K*gas passes', belowGasMultiple(15.01, 10, 1.5) === false);
ck('gross just under rejects', belowGasMultiple(14.999, 10, 1.5) === true);
ck('gas=0 always passes', belowGasMultiple(0.0001, 0, 1.5) === false);
ck('gross=0, gas=0 passes', belowGasMultiple(0, 0, 1.5) === false);
ck('K=1 requires net positive', belowGasMultiple(9.99, 10, 1) === true && belowGasMultiple(10, 10, 1) === false);
ck('K=2 stricter', belowGasMultiple(19, 10, 2) === true && belowGasMultiple(20, 10, 2) === false);
ck('K<1 looser than break-even', belowGasMultiple(5, 10, 0.5) === false && belowGasMultiple(4.9, 10, 0.5) === true);

// --- route gas table --------------------------------------------------
const leg = (kind: 'v2' | 'v3') => ({ pool: { kind } });
ck('v2x2 = measured 354k', routeGasUnits([leg('v2'), leg('v2')], 0) === 354_000n);
ck('v2x3 = measured 434k', routeGasUnits([leg('v2'), leg('v2'), leg('v2')], 0) === 434_000n);
ck('v3x2 fallback above v2', routeGasUnits([leg('v3'), leg('v3')], 0) > GAS_TABLE['v2x2']);
ck('mixed v2/v3 takes v3 worst', routeGasUnits([leg('v2'), leg('v3')], 0) === 480_000n);
ck('4+ hop falls to fail-expensive', routeGasUnits([leg('v2'), leg('v2'), leg('v2'), leg('v2')], 0) === 620_000n);
ck('margin +10% applied', routeGasUnits([leg('v2'), leg('v2')], 1000) === 354_000n * 11n / 10n);
ck('margin 0 exact', routeGasUnits([leg('v2'), leg('v2')], 0) === 354_000n);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
