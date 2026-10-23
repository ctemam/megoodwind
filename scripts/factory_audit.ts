/** WO-8 step 4 — factory registry audit: every FACTORIES entry per
 *  keyed chain gets (a) getCode non-empty, (b) one sample pool query on
 *  majors returns a sane address. Read-only. */
import { ethers } from 'ethers';
import { chainConfig, activeChainConfigs } from '../src/config/index.js';
import { poolFor } from '../src/providers/rpcPool.js';
import { FACTORIES, FactoryRef } from '../src/discovery/factories.js';

const SAMPLE_TOKENS: Record<string, [string, string]> = {
  eth: ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
  bsc: ['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x55d398326f99059ff775485246999027b3197955'],
  poly: ['0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'],
  arb: ['0x82af49447d8a07e3bd95bd0d56f35241523fbab1', '0xaf88d065e77c8cc2239327c5edb3a432268e5831'],
  op: ['0x4200000000000000000000000000000000000006', '0x0b2c639c533813f4aa9d7837caf62653d097ff85'],
  base: ['0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
  avax: ['0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7'],
  linea: ['0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', '0x176211869ca2b568f2a7d4ee941e073a821ee1ff'],
  scroll: ['0x5300000000000000000000000000000000000004', '0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4'],
};
const ABI = new ethers.Interface([
  'function getPool(address,address,uint24) view returns (address)',
  'function getPool(address,address,bool) view returns (address)',
  'function getPair(address,address) view returns (address)',
  'function poolByPair(address,address) view returns (address)',
]);

async function probeFactory(chainKey: string, f: FactoryRef) {
  const rpc = poolFor(chainConfig(chainKey));
  const code = await rpc.call<string>('eth_getCode', [f.address, 'latest']).catch(() => '0x');
  const codeBytes = Math.max(0, code.length - 2) / 2;
  const [tA, tB] = SAMPLE_TOKENS[chainKey] ?? [];
  let sample = 'n/a', found = 0, tries = 0;
  const addrs: string[] = [];
  if (tA && codeBytes > 0) {
    const calls: [string, unknown[]][] =
      f.kind === 'v3' ? f.feeTiers.map((fee) => ['getPool(address,address,uint24)', [tA, tB, fee]])
        : f.kind === 'velodrome' ? [[true, false] as boolean[]].flatMap(() => [['getPool(address,address,bool)', [tA, tB, true]] as [string, unknown[]], ['getPool(address,address,bool)', [tA, tB, false]]])
          : f.kind === 'algebra' ? [['poolByPair', [tA, tB]]]
            : [['getPair', [tA, tB]]];
    for (const [fn, args] of calls) {
      tries++;
      const r = await rpc.callContract(f.address, ABI.encodeFunctionData(fn, args), 'latest').catch(() => '0x');
      const a = r.length >= 66 ? '0x' + r.slice(-40) : ethers.ZeroAddress;
      if (a !== ethers.ZeroAddress && (await rpc.call<string>('eth_getCode', [a, 'latest']).catch(() => '0x')).length > 4) { found++; addrs.push(a); }
    }
    sample = addrs.length ? `${found}/${tries} e.g. ${addrs[0].slice(0, 12)}…` : `0/${tries} found`;
  }
  console.log(`${chainKey.padEnd(6)} ${f.name.padEnd(16)} ${f.kind.padEnd(9)} code=${codeBytes}B ${sample}`);
  return { chain: chainKey, name: f.name, kind: f.kind, address: f.address, codeBytes, found, tries };
}

const chains = Object.keys(FACTORIES).filter((k) => SAMPLE_TOKENS[k] && (process.env.CHAINS ? process.env.CHAINS.split(',').includes(k) : true));
const results = [];
for (const c of chains) for (const f of FACTORIES[c] ?? []) results.push(await probeFactory(c, f));
const bad = results.filter((r) => r.codeBytes === 0 || (r.tries > 0 && r.found === 0));
console.log(`\n=== AUDIT: ${results.length} entries, ${bad.length} empty/dead ===`);
for (const b of bad) console.log(`  ${b.chain}/${b.name} ${b.address} code=${b.codeBytes}B pools=${b.found}/${b.tries}`);
