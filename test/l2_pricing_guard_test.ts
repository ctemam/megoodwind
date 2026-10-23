/** WO-8 step 0 — L2 pricing guard: WNATIVE resolves to the real wrapped-
 *  native per chain, and every L2's major stables/wrapped-native have a
 *  USD price so poolDepthUsd isn't silently 0. */
import { WNATIVE, TOKEN_USD } from '../src/config/pricing.js';
import { test } from 'node:test';
import assert from 'node:assert';

const EXPECTED_NATIVE: Record<string, string> = {
  eth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  arb: '0x82af49447d8a07e3bd95bd0d56f35241523fBab1',
  op: '0x4200000000000000000000000000000000000006',
  base: '0x4200000000000000000000000000000000000006',
  bsc: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  poly: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
};

const MAJORS: Record<string, string[]> = {
  arb: ['0xaf88d065e77c8cc2239327c5edb3a432268e5831', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1'],
  base: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x50c5725949a6f0c72e6c4a641f24049a917db0cb'],
  op: ['0x0b2c639c533813f4aa9d7837caf62653d097ff85'],
};

test('WNATIVE is the real wrapped-native on L2s', () => {
  for (const [chain, want] of Object.entries(EXPECTED_NATIVE)) {
    const got = WNATIVE[chain];
    assert.ok(got, `WNATIVE missing for ${chain}`);
    assert.strictEqual(got.toLowerCase(), want.toLowerCase(), `WNATIVE[${chain}] = ${got}, want ${want}`);
  }
});

test('L2 major tokens are priced in TOKEN_USD', () => {
  for (const [chain, addrs] of Object.entries(MAJORS)) {
    for (const a of addrs) {
      const px = TOKEN_USD[a.toLowerCase()];
      assert.ok(px !== undefined && px > 0, `${chain} major ${a} unpriced`);
    }
  }
  for (const chain of ['arb', 'op', 'base']) {
    const w = WNATIVE[chain];
    assert.ok(TOKEN_USD[w.toLowerCase()] !== undefined, `WNATIVE[${chain}] ${w} itself unpriced`);
  }
});
