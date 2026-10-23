/** USD reference prices for major tokens — used ONLY for depth gating,
 *  gas valuation and borrow-size USD conversion. NOT a price oracle for
 *  profit math (that stays on-chain reserve math). Importable without
 *  side effects — tests must never boot the runner. */
import { cfg } from './index.js';

export const TOKEN_USD: Record<string, number> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': cfg.NATIVE_USD, // WETH eth
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 600,
  '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 0.30,
  '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7': 35,   // WAVAX
  // L2 majors — WO-7: the L2 funnel was blind (depthUsd=0 on every pool
  // since no L2 address was priced); all rejected pre-emit.
  '0x4200000000000000000000000000000000000006': cfg.NATIVE_USD, // WETH base/op
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': cfg.NATIVE_USD, // WETH arb
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 1,
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 1,
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 1,
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 1,
  '0x55d398326f99059ff775485246999027b3197955': 1,
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 1,
  '0x6b175474e89094c44da98b954eedeac495271d0f': 1,
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 1, // USDC base
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 1, // USDC arb
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 1, // USDC.e arb
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 1, // USDT arb
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 1, // DAI base
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 1, // DAI arb
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 1, // USDC op
  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': 1, // USDT op
};

/** Wrapped-native per chain — gas must be priced in THIS chain's native
 *  USD, never a global ETH figure. */
export const WNATIVE: Record<string, string> = {
  eth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  arb: '0x82af49447d8a07e3bd95bd0d56f35241523fBab1',
  op: '0x4200000000000000000000000000000000000006',
  base: '0x4200000000000000000000000000000000000006',
  linea: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f',
  scroll: '0x5300000000000000000000000000000000000004',
  blast: '0x4300000000000000000000000000000000000004',
  bsc: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  poly: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  avax: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
};

export const nativeUsdFor = (key: string): number =>
  (WNATIVE[key] && TOKEN_USD[WNATIVE[key]]) || cfg.NATIVE_USD;
