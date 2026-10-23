import { ethers } from 'ethers';
import { ChainKey } from '../config/index.js';

/**
 * Expansion vector #1 — All DEXs & Pools (factory arbitrage).
 * On-chain factory registry: getPool/getPair discovery + PoolCreated /
 * PairCreated event feeds. Factory addresses are infrastructure (like
 * chain IDs) — env-overridable via UNIV3_FACTORY_<KEY> / V2_FACTORY_<KEY>.
 * Manual POOL or TOKEN registration remains strictly forbidden.
 */

export interface FactoryRef {
  name: string;
  // v2 = UniV2 getPair(a,b) · v3 = UniV3 getPool(a,b,fee) ·
  // velodrome = Velodrome/Aerodrome V1 getPool(a,b,bool stable) — both
  // stable and volatile slots probed per pair · algebra = Algebra-style
  // poolByPair(a,b) (Camelot et al., no fee arg)
  kind: 'v2' | 'v3' | 'velodrome' | 'algebra';
  address: string;
  feeTiers: number[];      // v3: [100,500,3000,10000]; others: [] (fee from feeBps)
  defaultFeeBps: number;   // v2 swap fee in bps
}

const UNIV3 = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
/** Per-chain UniV3 factory overrides — the canonical 0x1F98 deployment
 *  is absent on newer chains; base hosts UniV3 at 0x33128a8f. */
const UNIV3_BY_CHAIN: Record<string, string> = {
  base: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  avax: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD', // WO-8 audit: 0x1F98 absent on avax (verified getCode)
};
const PCS_V3 = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const UNI_V2 = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const SUSHI_V2 = '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac';
const SUSHI_V2_L2 = '0xc35DADB65012eC5796536bD9864eD8773aBc74C4'; // WO-8 audit: mainnet addr absent on poly/arb; cross-chain deploy verified live
const PCS_V2 = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const QUICK_V2 = '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32';
const AERO = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da'; // Aerodrome SlipStream(CL)+basic
const CAMELOT_V2 = '0x6EcCab422D763aC031210895C81787E87B43A652'; // WO-8 audit: the 0x1a3c9b Algebra factory is dead (code=0); Camelot's live V2 factory answers getPair
const CAMELOT_V3 = '0x1A3C9b1d2f0529D97f2afC2536CC4045457CB983'; // DEAD on arb (audit code=0) — kept for reference, not registered

const V3_TIERS = [100, 500, 3000, 10000];

export const FACTORIES: Record<string, FactoryRef[]> = {
  eth: [
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
    { name: 'uniswap-v2', kind: 'v2', address: UNI_V2, feeTiers: [], defaultFeeBps: 30 },
    { name: 'sushiswap-v2', kind: 'v2', address: SUSHI_V2, feeTiers: [], defaultFeeBps: 30 },
    { name: 'pancakeswap-v3', kind: 'v3', address: PCS_V3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
  ],
  bsc: [
    { name: 'pancakeswap-v3', kind: 'v3', address: PCS_V3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
    { name: 'pancakeswap-v2', kind: 'v2', address: PCS_V2, feeTiers: [], defaultFeeBps: 25 },
    // WO-8 audit: canonical 0x1F98 has NO code on bsc — removed (no verified UniV3 factory on BSC)
  ],
  poly: [
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
    { name: 'quickswap-v2', kind: 'v2', address: QUICK_V2, feeTiers: [], defaultFeeBps: 30 },
    { name: 'sushiswap-v2', kind: 'v2', address: SUSHI_V2_L2, feeTiers: [], defaultFeeBps: 30 },
  ],
  arb: [
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
    { name: 'camelot-v2', kind: 'v2', address: CAMELOT_V2, feeTiers: [], defaultFeeBps: 30 },
    { name: 'sushiswap-v2', kind: 'v2', address: SUSHI_V2_L2, feeTiers: [], defaultFeeBps: 30 },
  ],
  op: [
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
    { name: 'velodrome-v2', kind: 'velodrome', address: '0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746', feeTiers: [], defaultFeeBps: 30 },
  ],
  avax: [
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3_BY_CHAIN.avax, feeTiers: V3_TIERS, defaultFeeBps: 30 },
  ],
  base: [
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3_BY_CHAIN.base, feeTiers: V3_TIERS, defaultFeeBps: 30 },
    { name: 'aerodrome', kind: 'velodrome', address: AERO, feeTiers: [], defaultFeeBps: 30 },
  ],
  linea: [
    { name: 'pancakeswap-v3', kind: 'v3', address: PCS_V3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
  ],
  scroll: [
    // WO-8 audit: 0x1F98 on scroll is a 2.1kB stub that returns 0x0 for
    // all getPool calls — entry kept for structure, marked dead.
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
  ],
  blast: [],
};

/** Env overrides — append/replace a factory without code edits:
 *  UNIV3_FACTORY_BSC=0x... (v3) · V2_FACTORY_BSC=0x... (v2) */
export function factoriesFor(chain: ChainKey): FactoryRef[] {
  const base = [...(FACTORIES[chain] ?? [])];
  const v3o = process.env[`UNIV3_FACTORY_${chain.toUpperCase()}`];
  const v2o = process.env[`V2_FACTORY_${chain.toUpperCase()}`];
  if (v3o) base.push({ name: 'env-v3', kind: 'v3', address: v3o, feeTiers: V3_TIERS, defaultFeeBps: 30 });
  if (v2o) base.push({ name: 'env-v2', kind: 'v2', address: v2o, feeTiers: [], defaultFeeBps: 30 });
  return base;
}

// ---- ABIs + event topics ----
export const FACTORY_ABI = new ethers.Interface([
  'function getPool(address,address,uint24) view returns (address)',
  'function getPool(address,address,bool) view returns (address)',
  'function getPair(address,address) view returns (address)',
  'function poolByPair(address,address) view returns (address)',
]);
export const POOL_CREATED_TOPIC = ethers.id('PoolCreated(address,address,uint24,int24,address)');
export const PAIR_CREATED_TOPIC = ethers.id('PairCreated(address,address,address,uint256)');
export const POOL_CREATED_ABI = new ethers.Interface([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
]);
export const PAIR_CREATED_ABI = new ethers.Interface([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
]);
