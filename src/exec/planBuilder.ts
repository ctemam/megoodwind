import { ethers } from 'ethers';
import { Candidate } from '../strategies/solver.js';
import { FLASH_SOURCE_ENUM, FlashSourceKey } from './flashVenues.js';

/**
 * Encodes the executor contract's `exec(bytes)` calldata.
 * ArbPlan ABI must mirror contracts/AllBrightExecutor.sol exactly:
 *   enum FlashSource { BALANCER, AAVE, MORPHO, ERC3156 }
 *   enum DexKind { V2_PAIR, V3_ROUTER }
 *   struct Hop { uint8 kind; address venue; address tokenIn; address tokenOut; uint24 fee; uint16 feeBps }
 *   struct ArbPlan { uint8 source; address borrowToken; uint256 borrowAmount;
 *                    Hop[] hops; uint256 minOut; uint256 minProfit }
 */

export const EXECUTOR_ABI = new ethers.Interface([
  `function exec(bytes planBytes)`,
  `function sweep(address token, address to, uint256 amount)`,
  `function setVenues(address balancerVault, address aavePool)`,
  `function balancerVault() view returns (address)`,
  `function aavePool() view returns (address)`,
]);

const PLAN_TUPLE =
  'tuple(uint8 source, address borrowToken, uint256 borrowAmount, ' +
  'tuple(uint8 kind, address venue, address tokenIn, address tokenOut, uint24 fee, uint16 feeBps)[] hops, ' +
  'uint256 minOut, uint256 minProfit)';

const coder = ethers.AbiCoder.defaultAbiCoder();

export interface PlanOpts {
  source: FlashSourceKey;
  /** flash premium in borrowToken units (AAVE: amount*9/10000; BALANCER: 0) */
  premium: bigint;
  /** minProfit in borrowToken units derived from MIN_PROFIT_USD at quote time */
  minProfit: bigint;
}

export function buildPlan(c: Candidate, o: PlanOpts): { planBytes: string; execData: string } {
  const hops = c.legs.map((l) => ({
    kind: l.pool.kind === 'v3' ? 1 : 0,          // DexKind: V2_PAIR=0, V3_ROUTER=1
    venue: l.pool.kind === 'v3' ? v3RouterFor(l.pool) : l.pool.address,
    tokenIn: l.tokenIn,
    tokenOut: l.tokenOut,
    fee: l.pool.kind === 'v3' ? l.pool.feeBps * 100 : 0, // bps -> centi-bps (30bps=3000)
    feeBps: l.pool.kind === 'v2' ? l.pool.feeBps : 0,
  }));

  // Verify-before-submit rule: last-hop minOut = flash amount (+premium).
  // A decayed spread reverts rather than loses money. Whale-lane plans
  // bind minOut to repay + floor — a thin-margin fill never clears the
  // $25 lane bar anyway, so revert beats a dust-profit settle.
  const minOut = c.borrowAmount + o.premium + (c.lane === 'whale' ? o.minProfit : 0n);

  const plan = {
    source: FLASH_SOURCE_ENUM[o.source],
    borrowToken: c.borrowToken,
    borrowAmount: c.borrowAmount,
    hops,
    minOut,
    minProfit: o.minProfit,
  };

  const planBytes = coder.encode([PLAN_TUPLE], [plan]);
  const execData = EXECUTOR_ABI.encodeFunctionData('exec', [planBytes]);
  return { planBytes, execData };
}

/** UniV3 SwapRouter per chain/dex — canonical addresses.
 *  WO-8: base's only UniV3 router is SwapRouter02 0x2626… whose
 *  exactInputSingle takes NO deadline field (7 params) — the executor's
 *  8-param ABI reverts bare on it. 0xE592 is NOT a router on base (4kB
 *  stub, factory() reverts). v3 legs on base need a contract change —
 *  the fallback below MUST NOT silently route there. */
const V3_ROUTERS: Record<string, string> = {
  uniswap: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  'uniswap-base': '0x2626664c2603336E57B271c5C0b26F421741e481', // SwapRouter02 — BLOCKED by ABI, flagged
  'pancakeswap-eth': '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
  'pancakeswap-bsc': '0x13f4EA83D0ee40E75C5Df61B19381241d52dD75d',
  'pancakeswap-poly': '0x4C60051384bd2d3C01bfc845Cf5F4b44bcbE9de5',
  'sushiswap': '0xF96Fd3B2648e346a151941B14cE9B513Ba9478C4',
};

export function v3RouterFor(pool: { dexId: string; chain: string }): string {
  return (
    V3_ROUTERS[`${pool.dexId}-${pool.chain}`] ??
    V3_ROUTERS[pool.dexId] ??
    V3_ROUTERS.uniswap
  );
}
