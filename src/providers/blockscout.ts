import { ChainKey, chainIdFor } from '../config/index.js';
import { logger } from '../config/logger.js';

/**
 * Blockscout PRO API — explorer-indexed REST surface (Item: provider tier).
 * One `proapi_` key serves every supported chain via `/{chain_id}/...`;
 * the JSON-RPC gateway (eth_call lane) lives in providerCatalog — this
 * module is the INDEXED side: enriched data the explorer already has.
 *
 * Free tier: 100k credits/day, 5 RPS (authoritative: /api/json/plans).
 * Every response carries `x-credits-remaining` — surfaced on the last
 * logged call so a drained budget is visible, never silent.
 *
 * Skill: .devin/skills/blockscout-web3-dev (auth: Bearer, named UA, narrow
 * projections — never dump whole enriched payloads).
 */

const log = logger('blockscout');
const BASE = 'https://api.blockscout.com';
const UA = 'allbright/1.0 (+https://devin.ai)';

let lastCredits: number | undefined;
let warnedLow = false;

export function blockscoutKey(): string | undefined {
  return process.env.BLOCKSCOUT_PRO_API_KEY;
}

/** Thin GET wrapper — Bearer auth + CDN-safe headers + credit telemetry. */
async function bsGet<T>(path: string): Promise<T | null> {
  const key = blockscoutKey();
  if (!key) return null;
  try {
    const r = await fetch(`${BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        'User-Agent': UA,
        Accept: 'application/json',
      },
    });
    const cr = r.headers.get('x-credits-remaining');
    if (cr) {
      lastCredits = Number(cr);
      if (lastCredits < 10_000 && !warnedLow) {
        warnedLow = true;
        log.warn(`blockscout credits low: ${lastCredits} remaining today`);
      }
    }
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        log.warn(`blockscout auth rejected (${r.status}) — key invalid/revoked; lane disabled this boot`);
      }
      return null;
    }
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export interface AddressReputation {
  isScam: boolean;
  isVerified: boolean;
  reputation: 'ok' | 'warning' | 'scam' | string;
  name: string | null;
}

/** Explorer verdict on an address — 1 credit. `null` = unsupported chain / no key / transport fail. */
export async function addressReputation(
  chain: ChainKey,
  address: string,
): Promise<AddressReputation | null> {
  const j = await bsGet<{ is_scam?: boolean; is_verified?: boolean; reputation?: string; name?: string | null }>(
    `/${chainIdFor(chain)}/api/v2/addresses/${address}`,
  );
  if (!j) return null;
  return {
    isScam: j.is_scam === true,
    isVerified: j.is_verified === true,
    reputation: j.reputation ?? 'ok',
    name: j.name ?? null,
  };
}

export function creditsRemaining(): number | undefined {
  return lastCredits;
}
