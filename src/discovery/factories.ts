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
  kind: 'v2' | 'v3';
  address: string;
  feeTiers: number[];      // v3: [100,500,3000,10000]; v2: [] (fee from feeBps)
  defaultFeeBps: number;   // v2 swap fee in bps
}

const UNIV3 = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const PCS_V3 = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const UNI_V2 = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const SUSHI_V2 = '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac';
const PCS_V2 = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const QUICK_V2 = '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32';
const AERO = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da'; // Aerodrome SlipStream(CL)+basic
const CAMELOT_V3 = '0x1a3c9B1d2F0529D97f2afC2536Cc4045457cb983';

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
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
  ],
  poly: [
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
    { name: 'quickswap-v2', kind: 'v2', address: QUICK_V2, feeTiers: [], defaultFeeBps: 30 },
    { name: 'sushiswap-v2', kind: 'v2', address: SUSHI_V2, feeTiers: [], defaultFeeBps: 30 },
  ],
  arb: [
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
    { name: 'camelot-v3', kind: 'v3', address: CAMELOT_V3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
    { name: 'sushiswap-v2', kind: 'v2', address: SUSHI_V2, feeTiers: [], defaultFeeBps: 30 },
  ],
  op: [
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
    { name: 'velodrome-v2', kind: 'v2', address: '0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746', feeTiers: [], defaultFeeBps: 30 },
  ],
  avax: [
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
  ],
  base: [
    { name: 'uniswap-v3', kind: 'v3', address: UNIV3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
    { name: 'aerodrome', kind: 'v3', address: AERO, feeTiers: V3_TIERS, defaultFeeBps: 30 },
  ],
  linea: [
    { name: 'pancakeswap-v3', kind: 'v3', address: PCS_V3, feeTiers: V3_TIERS, defaultFeeBps: 30 },
  ],
  scroll: [
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
  'function getPair(address,address) view returns (address)',
]);
export const POOL_CREATED_TOPIC = ethers.id('PoolCreated(address,address,uint24,int24,address)');
export const PAIR_CREATED_TOPIC = ethers.id('PairCreated(address,address,address,uint256)');
export const POOL_CREATED_ABI = new ethers.Interface([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
]);
export const PAIR_CREATED_ABI = new ethers.Interface([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
]);
