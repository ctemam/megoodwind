import { ChainKey } from '../config/index.js';

/**
 * Flash-loan venue registry — the single source of truth shared by the
 * deploy lane (ctor args) and the executor (source selection).
 *
 * Fee ladder:
 *   BALANCER  0%      — Balancer V2 Vault, canonical deterministic
 *                        0xBA12…F2C8 on every chain it exists on
 *   MORPHO    0%      — Morpho Blue flashLoan(); pull-repay via
 *                        allowance inside onMorphoFlashLoan callback
 *   ERC3156   0%      — MakerDAO DssFlash (DAI only, eth only,
 *                        ~500M ceiling). flashFee read live in the
 *                        callback — currently zero but governable
 *   AAVE      0.09%   — fallback only; paid capital
 *
 * address(0) = venue absent on that chain (verified boundary, not a gap).
 * Morpho Blue: canonical vanity deployer 0xBBBB…FFCb on eth/base/arb/op.
 * Chains whose Morpho deployment uses a different address stay 0 until
 * verified from Morpho docs — a wrong venue address is worse than none.
 */

export type FlashSourceKey = 'BALANCER' | 'AAVE' | 'MORPHO' | 'ERC3156';

/** Mirrors contracts/AllBrightExecutor.sol `enum FlashSource` exactly. */
export const FLASH_SOURCE_ENUM: Record<FlashSourceKey, number> = {
  BALANCER: 0,
  AAVE: 1,
  MORPHO: 2,
  ERC3156: 3,
};

export interface FlashVenueSet {
  balancer: string;
  aave: string;
  morpho: string;
  erc3156: string;
}

const ZERO = '0x0000000000000000000000000000000000000000';

const BALANCER_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const AAVE_V3_CANONICAL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const MAKER_DSS_FLASH = '0x60744434d6339a6b27d73d9EdA8b9F98DB5a4D45'; // eth only, DAI only

export const FLASH_VENUES: Record<string, FlashVenueSet> = {
  eth:   { balancer: BALANCER_VAULT, aave: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', morpho: MORPHO_BLUE, erc3156: MAKER_DSS_FLASH },
  poly:  { balancer: BALANCER_VAULT, aave: AAVE_V3_CANONICAL, morpho: ZERO, erc3156: ZERO },
  arb:   { balancer: BALANCER_VAULT, aave: AAVE_V3_CANONICAL, morpho: MORPHO_BLUE, erc3156: ZERO },
  op:    { balancer: BALANCER_VAULT, aave: AAVE_V3_CANONICAL, morpho: MORPHO_BLUE, erc3156: ZERO },
  base:  { balancer: BALANCER_VAULT, aave: '0xa238dd80C259A72E81D7E4664A74715939677AC0', morpho: MORPHO_BLUE, erc3156: ZERO },
  avax:  { balancer: BALANCER_VAULT, aave: AAVE_V3_CANONICAL, morpho: ZERO, erc3156: ZERO },
  bsc:   { balancer: ZERO, aave: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB', morpho: ZERO, erc3156: ZERO },
  linea: { balancer: ZERO, aave: '0xc47B8c00b0f69a36fa203fEaeafdB1557614c0E6', morpho: ZERO, erc3156: ZERO },
  scroll:{ balancer: ZERO, aave: '0x11fCfe756c05AD438e312a7fd934381537D3cFfe', morpho: ZERO, erc3156: ZERO },
  blast: { balancer: ZERO, aave: ZERO, morpho: ZERO, erc3156: ZERO },
};

/** Mainnet DAI — the only asset Maker DssFlash lends. */
const DAI_ETH = '0x6b175474e89094c44da98b954eedeac495271d0f';

export function flashFeeBps(source: FlashSourceKey): number {
  return source === 'AAVE' ? 9 : 0; // Balancer/Morpho/DssFlash = fee-free
}

/** Flash premium in borrowToken units (AAVE charges amount*9/10000). */
export function flashPremium(source: FlashSourceKey, borrowAmount: bigint): bigint {
  return source === 'AAVE' ? (borrowAmount * 9n) / 10_000n : 0n;
}

/**
 * Source selection — prefer fee-free capital, Aave only as last resort.
 * Order: Balancer (deepest multi-token vault) -> Morpho -> Maker(DAI) ->
 * Aave. A venue whose pool can't cover the borrow fails deterministic-
 * ally inside exec-probe (recorded revert, zero capital at risk) — the
 * probe gate is the capacity check, not a venue heuristic.
 */
export function pickFlashSource(chain: ChainKey, borrowToken: string): FlashSourceKey {
  const v = FLASH_VENUES[chain];
  if (!v) return 'AAVE';
  if (v.balancer !== ZERO) return 'BALANCER';
  if (v.morpho !== ZERO) return 'MORPHO';
  if (v.erc3156 !== ZERO && chain === 'eth' && borrowToken.toLowerCase() === DAI_ETH) return 'ERC3156';
  return 'AAVE';
}
