/**
 * WO-10 — liquidation lane. Indexes Aave V3 borrowers from Borrow events,
 * batches health-factor reads via Multicall3, and on HF < 1 sizes a
 * flash-funded liquidation per RESEARCH_BRIEF R5:
 *   close factor 50% (100% only when HF < 0.95);
 *   seized collateral = debt-covered value * liquidationBonus (per-asset,
 *   on-chain read), capped by borrower balance;
 *   liquidator net bonus = (bonus - 1) * (1 - liquidationProtocolFee).
 * No manual market lists — pools/users come from on-chain logs only.
 */
import { ethers } from 'ethers';
import { ChainConfig } from '../config/index.js';
import { RpcPool } from '../providers/rpcPool.js';
import { multicall } from '../providers/multicall.js';
import { FLASH_VENUES } from '../exec/flashVenues.js';

const ZERO = '0x0000000000000000000000000000000000000000';
import { logger } from '../config/logger.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

const log = logger('liquidation');

const POOL_ABI = new ethers.Interface([
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getUserConfiguration(address user) view returns (uint256)',
  'function getReservesList() view returns (address[])',
  'function getReserveConfiguration(address asset) view returns (uint256)',
]);
const DATA_PROVIDER_ABI = new ethers.Interface([
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
]);

const BORROW_TOPIC = ethers.id('Borrow(address,address,address,uint256,uint8,uint256,uint16)');
export const HF_LIQUIDATABLE = 10n ** 18n;   // 1.0
const CLOSE_FACTOR_HF_THRESHOLD = 95n * 10n ** 16n; // 0.95

export interface LiqConfig {
  chain: ChainConfig;
  rpc: RpcPool;
  dataDir?: string;
}

export interface Position {
  user: string;
  hf: bigint;
  totalDebtBase: bigint;
  collateralBase: bigint;
  at: number;
}

export class LiquidationIndexer {
  borrowers = new Set<string>();
  private rpc: RpcPool;
  private chain: ChainConfig;
  private poolAddr: string;
  private dataDir: string;
  private lastScan = 0;

  constructor(c: LiqConfig) {
    this.chain = c.chain;
    this.rpc = c.rpc;
    this.dataDir = c.dataDir ?? `data/liquidation`;
    this.poolAddr = FLASH_VENUES[this.chain.key]?.aave ?? ZERO;
    const f = this.file();
    if (existsSync(f)) for (const u of JSON.parse(readFileSync(f, 'utf8'))) this.borrowers.add(u);
  }

  enabled(): boolean { return this.poolAddr !== ZERO; }
  private file(): string { return `${this.dataDir}/borrowers_${this.chain.key}.json`; }
  private save() {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.file(), JSON.stringify([...this.borrowers]));
  }

  /** Index borrowers from Borrow logs (onBehalfOf) since lastScan. */
  async syncBorrowers(fromBlock: number, toBlock: number): Promise<number> {
    if (!this.enabled()) return 0;
    let added = 0;
    const CHUNK = 5000;
    for (let b = fromBlock; b < toBlock; b += CHUNK) {
      const end = Math.min(b + CHUNK - 1, toBlock);
      const logs = await this.rpc.call<unknown[]>('eth_getLogs', [{
        address: this.poolAddr,
        topics: [BORROW_TOPIC, null, null],
        fromBlock: '0x' + b.toString(16),
        toBlock: '0x' + end.toString(16),
      }]).catch(() => [] as unknown[]);
      for (const l of logs as { topics: string[] }[]) {
        if (l.topics.length >= 4) { this.borrowers.add(ethers.getAddress('0x' + l.topics[3].slice(-40))); added++; }
      }
    }
    this.lastScan = toBlock;
    if (added) this.save();
    return added;
  }

  /** Batch getUserAccountData over the borrower set — one aggregate3 per ≤200. */
  async refreshHealth(): Promise<Position[]> {
    const users = [...this.borrowers];
    if (!users.length) return [];
    const calls = users.map((u) => ({ to: this.poolAddr, data: POOL_ABI.encodeFunctionData('getUserAccountData', [u]), ci: 0 }));
    const res = await multicall(this.rpc, calls, calls.length);
    const out: Position[] = [];
    res.forEach((v, i) => {
      if (!v || v.length < 66) return;
      const r = POOL_ABI.decodeFunctionResult('getUserAccountData', v);
      if (r.totalDebtBase > 0n) out.push({ user: users[i], hf: r.healthFactor, totalDebtBase: r.totalDebtBase, collateralBase: r.totalCollateralBase, at: Date.now() });
    });
    return out;
  }

  /** Positions within `band` of HF=1.0 (e.g. band=0.1 -> 0.9..1.1). */
  async watchBand(band = 0.1): Promise<Position[]> {
    const pos = await this.refreshHealth();
    const lo = HF_LIQUIDATABLE - BigInt(Math.floor(band * 1e18));
    const hi = HF_LIQUIDATABLE + BigInt(Math.floor(band * 1e18));
    return pos.filter((p) => p.hf <= hi && p.hf >= lo);
  }
}

/** R5 mechanics: liquidator economics for one position. All on-chain reads. */
export function closeFactor(hf: bigint): number {
  return hf < CLOSE_FACTOR_HF_THRESHOLD ? 1.0 : 0.5;
}

/** liquidator net bonus fraction = (bonus - 1) * (1 - protocolFee). */
export function liquidatorBonusFrac(liquidationBonusBps: number, protocolFeeBps: number): number {
  return (liquidationBonusBps / 10_000 - 1) * (1 - protocolFeeBps / 10_000);
}
