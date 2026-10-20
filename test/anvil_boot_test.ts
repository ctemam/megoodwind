import { spawn } from 'node:child_process';
async function main() {
  const m = await import('../src/config/index.js');
  const { RpcPool } = await import('../src/providers/rpcPool.js');
  const { Discovery } = await import('../src/discovery/discovery.js');
  const { registry } = await import('../src/pools/registry.js');
  const eth = m.chainConfig('eth');
  const anvil = spawn('anvil', ['--fork-url', eth.rpcUrls[0], '--port', '8545', '--silent'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 6000));
  try {
    const sandbox = { key: 'eth', chainId: 1, rpcUrls: ['http://localhost:8545'], role: 'predictive' as const };
    const rpc = new RpcPool(sandbox);
    console.log('anvil block:', await rpc.blockNumber());
    const d = new Discovery(sandbox, rpc);
    const t0 = performance.now();
    await d.boot();
    console.log('boot ms:', (performance.now() - t0).toFixed(0));
    console.log('pools discovered:', registry.all('eth').length);
    console.log(registry.all('eth').slice(0, 6).map((p) => `${p.symbol0}/${p.symbol1}@${p.dexId}`).join(' | '));
  } finally {
    anvil.kill();
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
