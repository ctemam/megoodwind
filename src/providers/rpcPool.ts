import { ethers } from 'ethers';
import { ChainConfig } from '../config/index.js';
import { logger } from '../config/logger.js';

/**
 * Item #12 — Agent-to-RPC integration.
 * Pooled JsonRpcProviders with keep-alive, EWMA latency pick, and
 * automatic failover on HTTP 429 / transport timeout. One merged
 * transport object per chain (never serialized per-item on hot paths).
 */

interface Member {
  url: string;
  provider: ethers.JsonRpcProvider;
  ewmaMs: number;
  failures: number;
  cooldownUntil: number;
}

const TIMEOUT_MS = 8_000;
const COOLDOWN_MS = 20_000;
const EWMA_ALPHA = 0.3;

export class RpcPool {
  readonly chain: ChainConfig;
  private members: Member[] = [];
  private cursor = 0;
  private log = logger('rpcPool');

  constructor(chain: ChainConfig) {
    this.chain = chain;
    const urls = [...chain.rpcUrls];
    if (chain.fallbackRpcUrl && !urls.includes(chain.fallbackRpcUrl)) {
      urls.push(chain.fallbackRpcUrl);
    }
    if (!urls.length) throw new Error(`no private RPC endpoints for ${chain.key}`);
    for (const url of urls) {
      this.members.push({
        url,
        provider: new ethers.JsonRpcProvider(url, chain.chainId, {
          staticNetwork: true,
          polling: false,
        }),
        ewmaMs: 500,
        failures: 0,
        cooldownUntil: 0,
      });
    }
  }

  private pick(): Member {
    const now = Date.now();
    const live = this.members.filter((m) => m.cooldownUntil <= now);
    const set = live.length ? live : this.members;
    // round-robin bias toward lowest EWMA
    const best = set.reduce((a, b) => (a.ewmaMs <= b.ewmaMs ? a : b));
    this.cursor = (this.cursor + 1) % set.length;
    return set[this.cursor] === best ? set[(this.cursor + 1) % set.length] : best;
  }

  /** Ms until the earliest member exits cooldown (0 when one is live). */
  private cooldownWaitMs(): number {
    const now = Date.now();
    if (this.members.some((m) => m.cooldownUntil <= now)) return 0;
    return Math.min(...this.members.map((m) => m.cooldownUntil)) - now;
  }

  private penalize(m: Member, is429: boolean) {
    m.failures++;
    m.cooldownUntil = Date.now() + (is429 ? COOLDOWN_MS * 3 : COOLDOWN_MS) * Math.min(m.failures, 5);
    // throttle log spam — only state transitions and powers of 10
    if (m.failures <= 3 || m.failures % 25 === 0) {
      this.log.warn(`${this.chain.key} endpoint cooled down`, { url: hostOf(m.url), failures: m.failures, is429 });
    }
  }

  /** Raw JSON-RPC call with failover. Waits out cooldowns instead of
   *  hot-looping 429s; retries each member once per invocation. */
  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown;
    for (let round = 0; round < 2; round++) {
      const wait = this.cooldownWaitMs();
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 5_000)));
      for (let i = 0; i < this.members.length; i++) {
        const m = this.pick();
        const t0 = performance.now();
        try {
          const res = await Promise.race([
            m.provider.send(method, params),
            new Promise((_, rej) => setTimeout(() => rej(new Error('rpc_timeout')), TIMEOUT_MS)),
          ]);
          m.ewmaMs = m.ewmaMs * (1 - EWMA_ALPHA) + (performance.now() - t0) * EWMA_ALPHA;
          m.failures = 0;
          return res as T;
        } catch (e) {
          lastErr = e;
          if (isTransportError(e)) this.penalize(m, isRateLimit(e));
          else throw e; // deterministic payload errors are not transport faults
        }
      }
    }
    throw lastErr;
  }

  /** ethers provider bound to this pool (uses best member's provider object). */
  get provider(): ethers.JsonRpcProvider {
    return this.pick().provider;
  }

  async blockNumber(): Promise<number> {
    return this.call<number>('eth_blockNumber', []).then((h) => parseInt(h as unknown as string, 16));
  }

  async callContract(to: string, data: string, blockTag: string | number = 'latest'): Promise<string> {
    return this.call<string>('eth_call', [{ to, data }, blockTag]);
  }

  /** exec-probe: eth_call from an explicit identity (smart account under 4337). */
  async callFrom(from: string, to: string, data: string, value = '0x0'): Promise<string> {
    return this.call<string>('eth_call', [{ from, to, data, value }, 'latest']);
  }
}

const isTransportError = (e: unknown): boolean => {
  const s = String((e as { message?: string })?.message ?? e);
  return (
    s.includes('rpc_timeout') ||
    s.includes('429') ||
    s.includes('TIMEOUT') ||
    s.includes('ETIMEDOUT') ||
    s.includes('ECONNRESET') ||
    s.includes('ENOTFOUND') ||
    s.includes('SERVER_ERROR')
  );
};

const isRateLimit = (e: unknown): boolean => {
  const s = String((e as { message?: string })?.message ?? e);
  return s.includes('429') || s.includes('rate limit') || s.includes('code\":15') || s.includes('"code":15');
};

const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url; }
};

const pools = new Map<string, RpcPool>();
export const poolFor = (chain: ChainConfig): RpcPool => {
  let p = pools.get(chain.key);
  if (!p) { p = new RpcPool(chain); pools.set(chain.key, p); }
  return p;
};
