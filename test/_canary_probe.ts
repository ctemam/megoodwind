/** WO-5 step 0 probe — prints canary-surface reachability for the env
 *  it's spawned under. All URLs masked (apikeys never leave the box). */
import { cfg, chainConfig, assertPrivateUrl } from '../src/config/index.js';
import { bundlerUrl, selfPayUserOps } from '../src/exec/pimlico.js';
import { pickFlashSource } from '../src/exec/flashVenues.js';

const out: Record<string, unknown> = {};
const mask = (u: string) => (u.includes('api.pimlico.io') ? 'PIMLICO' : u);

for (const key of cfg.activeChains) {
  try {
    const c = chainConfig(key);
    out[`bundlerUrl:${key}`] = mask(bundlerUrl(c));
    out[`selfPay:${key}`] = selfPayUserOps(c);
  } catch (e) {
    out[`bundlerUrl:${key}`] = 'REFUSED:' + String((e as Error).message).slice(0, 60);
  }
}
try {
  out.pickFlashSource_canary = pickFlashSource('canary', '0x0');
} catch (e) {
  out.pickFlashSource_canary = 'THROWS:' + String((e as Error).message).slice(0, 60);
}
for (const key of ['eth', 'canary']) {
  try {
    chainConfig(key);
    out[`loopback_cfg:${key}`] = 'OK';
  } catch (e) {
    out[`loopback_cfg:${key}`] = 'REFUSED:' + String((e as Error).message).slice(0, 60);
  }
}
try {
  assertPrivateUrl('http://127.0.0.1:8545', false, false);
  out.assertPrivateUrl_loopback_default = 'ALLOWED';
} catch {
  out.assertPrivateUrl_loopback_default = 'REFUSED';
}
console.log(JSON.stringify(out));
