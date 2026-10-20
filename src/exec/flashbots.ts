import { ethers } from 'ethers';
import { ChainConfig, cfg, privKeyHex } from '../config/index.js';
import { logger } from '../config/logger.js';

/**
 * Item #8 — Flashbots private relay (Ethereum mainnet only).
 * Force private routing via mev_sendBundle to block frontrunning on the
 * one chain with a public auction market (AUCTION_CHAINS=eth).
 * Requires FLASHBOOTS_AUTH_KEY — disabled (never faked) without it.
 * BSC/Polygon/L2s have no Flashbots relay — they go through Pimlico.
 */

const log = logger('flashbots');

export function flashbotsAvailable(chain: ChainConfig): boolean {
  return chain.key === 'eth' && Boolean(cfg.FLASHBOOTS_AUTH_KEY);
}

export interface BundleResult {
  kind: 'sent' | 'skipped' | 'failed';
  bundleHash?: string;
  reason?: string;
}

/** Submit a signed raw tx inside a single-tx bundle to the relay. */
export async function sendBundle(
  chain: ChainConfig,
  signedTx: string,
  targetBlock: number,
): Promise<BundleResult> {
  if (!flashbotsAvailable(chain)) {
    return { kind: 'skipped', reason: 'flashbots_unavailable_on_chain_or_no_key' };
  }
  try {
    const { FlashbotsBundleProvider } = await import('@flashbots/ethers-provider-bundle');
    const provider = new ethers.JsonRpcProvider(chain.rpcUrls[0], chain.chainId, { staticNetwork: true });
    const authSigner = new ethers.Wallet(privKeyHex());
    const fb = await FlashbotsBundleProvider.create(provider, authSigner, cfg.FLASHBOOTS_RELAY);
    const res = await fb.sendRawBundle([signedTx], targetBlock);
    if ('error' in res) {
      return { kind: 'failed', reason: String((res as { error: { message: string } }).error.message) };
    }
    const bundleHash = (res as { bundleHash?: string }).bundleHash;
    log.info(`bundle sent for block ${targetBlock}`, { bundleHash });
    return { kind: 'sent', bundleHash };
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    log.error('bundle submit failed', msg.slice(0, 200));
    return { kind: 'failed', reason: msg.slice(0, 200) };
  }
}
