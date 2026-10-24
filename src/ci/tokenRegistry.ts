/**
 * Comprehensive tiered token registry — canonical key = chain:address.
 * Broad knowledge, selective resource allocation, restrictive eligibility.
 * Tier A core | B established | C long-tail | D restricted/unverified.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';

export type Tier = 'A_core' | 'B_established' | 'C_longtail' | 'D_restricted';
export interface TokenRec {
  chain: string; address: string; decimals?: number; symbol?: string;
  tier: Tier; provenance: string[];      // token_list | factory_event | dexscreener | manual
  firstSeenBlock?: number; lastSeenAt: number;
  verified: boolean;                     // on-chain decimals() resolved
  quarantined?: { reason: string; at: number };
}

export class TokenRegistry {
  private m = new Map<string, TokenRec>();
  constructor(private file = 'data/ci/tokens.json') {
    if (existsSync(file)) for (const r of JSON.parse(readFileSync(file, 'utf8')) as TokenRec[]) this.m.set(`${r.chain}:${r.address}`, r);
  }
  static key(chain: string, addr: string) { return `${chain}:${addr.toLowerCase()}`; }
  has(chain: string, addr: string) { return this.m.has(TokenRegistry.key(chain, addr)); }
  get(chain: string, addr: string) { return this.m.get(TokenRegistry.key(chain, addr)); }
  upsert(r: Omit<TokenRec, 'lastSeenAt'> & { provenance: string }) {
    const k = TokenRegistry.key(r.chain, r.address);
    const ex = this.m.get(k);
    if (ex) {
      if (!ex.provenance.includes(r.provenance)) ex.provenance.push(r.provenance);
      ex.lastSeenAt = Date.now();
      if (r.decimals !== undefined && ex.decimals === undefined) ex.decimals = r.decimals;
      if (r.firstSeenBlock !== undefined && (ex.firstSeenBlock === undefined || r.firstSeenBlock < ex.firstSeenBlock)) ex.firstSeenBlock = r.firstSeenBlock;
      if (ex.tier === 'C_longtail' && r.tier !== 'C_longtail' && r.tier !== undefined) ex.tier = r.tier; // promote only upward
    } else this.m.set(k, { ...r, provenance: [r.provenance], lastSeenAt: Date.now() });
  }
  quarantine(chain: string, addr: string, reason: string) { const r = this.get(chain, addr); if (r) r.quarantined = { reason, at: Date.now() }; }
  eligible(chain: string) { return [...this.m.values()].filter((r) => r.chain === chain && !r.quarantined && r.tier !== 'D_restricted'); }
  counts(chain: string) { const c: Record<string, number> = {}; for (const r of this.m.values()) if (r.chain === chain) c[r.tier] = (c[r.tier] ?? 0) + 1; return c; }
  size() { return this.m.size; }
  flush() { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file + '.tmp', JSON.stringify([...this.m.values()])); renameSync(this.file + '.tmp', this.file); }
}

/** Seeds: majors per chain — core tier. Add chain-specific majors here only. */
export const CORE_TOKENS: Record<string, { addr: string; symbol: string }[]> = {
  eth: [
    { addr: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH' },
    { addr: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC' },
    { addr: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT' },
    { addr: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI' },
    { addr: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC' },
    { addr: '0x0000000000085d4780b73119b644ae5ecd22b376', symbol: 'TUSD' },
    { addr: '0x514910771af9ca656af840dff83e8264ecf986ca', symbol: 'LINK' },
    { addr: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', symbol: 'UNI' },
    { addr: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', symbol: 'AAVE' },
    { addr: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', symbol: 'stETH' },
  ],
};
