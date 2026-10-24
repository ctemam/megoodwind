import { ethers } from 'ethers';
import { ChainConfig, cfg } from '../config/index.js';
import { logger } from '../config/logger.js';
import { providerOf, specOf } from './providerCatalog.js';
import { isSuspended, providerServesChain } from './rpcPoolConfig.js';
import { rpcRegistry } from '../discovery/rpcRegistry.js';

/**
 * Item #12 — Agent-to-RPC integration.
 * Pooled JsonRpcProviders with keep-alive, EWMA latency pick, and
 * automatic failover on HTTP 429 / transport timeout. One merged
 * transport object per chain (never serialized per-item on hot paths).
 *
 * Account budget doctrine (measured, not assumed): provider rate limits
 * bind per ACCOUNT KEY, not per URL — so members are grouped by account
 * and each group gets ONE token bucket sized to the provider's documented
 * free-tier ceiling × 0.9 (10% reserve, never ordinary workload).
 * Cross-provider diversity is the real headroom lever; same-account
 * "failover" is self-amplifying churn and gets no extra budget.
 */

interface Member {
  url: string;
  provider: ethers.JsonRpcProvider;
  account: string;    // provider:key-token group — the real quota pool
  ewmaMs: number;
  failures: number;
  cooldownUntil: number;
  dead?: boolean;     // auth/config-fatal (401/403/not-enabled) — never retry
}

/** Token bucket shared by every URL on one provider account. */
class AccountBucket {
  tokens: number;
  last = Date.now();
  constructor(readonly cap: number) { this.tokens = cap; }
  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.cap, this.tokens + ((now - this.last) / 1000) * this.cap);
    this.last = now;
  }
  /** consume one token if available */
  take(): boolean { this.refill(); if (this.tokens >= 1) { this.tokens -= 1; return true; } return false; }
  /** ms until a full token is available */
  waitMs(): number { this.refill(); if (this.tokens >= 1) return 0; return Math.ceil(((1 - this.tokens) / this.cap) * 1000); }
}

const DEFAULT_SAFE_RPS = 5;      // unknown providers — conservative floor
const SAFE_FACTOR = 0.9;         // 10% reserve is never ordinary workload

const TIMEOUT_MS = 8_000;
const COOLDOWN_MS = 20_000;
const EWMA_ALPHA = 0.3;

export class RpcPool {
  readonly chain: ChainConfig;
  private members: Member[] = [];
  private buckets = new Map<string, AccountBucket>();
  private cursor = 0;
  private log = logger('rpcPool');

  constructor(chain: ChainConfig) {
    this.chain = chain;
    // Last-line interception: the config gates apply even to explicit
    // <CHAIN>_RPC_URLS env entries — suspended providers never get a
    // provider object, so no connect/probe/retry can ever reach them.
    const urls = [...chain.rpcUrls, ...(chain.fallbackRpcUrl ? [chain.fallbackRpcUrl] : [])]
      .filter((u, i, a) => a.indexOf(u) === i)
      .filter((u) => {
        const { id } = providerOf(u);
        return !isSuspended(id) && providerServesChain(id, chain.key);
      });
    if (!urls.length) throw new Error(`no private RPC endpoints for ${chain.key}`);
    for (const url of urls) {
      const { id, account } = providerOf(url);
      if (!this.buckets.has(account)) {
        const rps = specOf(id)?.rps ?? DEFAULT_SAFE_RPS;
        this.buckets.set(account, new AccountBucket(Math.max(0.01, rps * SAFE_FACTOR)));
      }
      this.members.push({
        url,
        provider: new ethers.JsonRpcProvider(url, chain.chainId, {
          staticNetwork: true,
          polling: false,
        }),
        account,
        // hydrate from the persistent registry: known-dead skips its
        // boot handshake entirely; known-good keeps its learned latency
        ewmaMs: rpcRegistry.ewmaSeed(chain.key, url) ?? 500,
        failures: 0,
        cooldownUntil: 0,
        dead: rpcRegistry.isDead(chain.key, url) || undefined,
      });
    }
    const deadCount = this.members.filter((m) => m.dead).length;
    this.log.info(`${chain.key}: ${this.members.length} endpoints across ${this.buckets.size} provider account(s)${deadCount ? ` (${deadCount} registry-dead, skipped)` : ''}`, {
      accounts: [...this.buckets.entries()].map(([a, b]) => `${a.split(':')[0]}@${b.cap.toFixed(0)}rps`),
    });
  }

  private bucket(m: Member): AccountBucket { return this.buckets.get(m.account)!; }

  private pick(): Member {
    const now = Date.now();
    // peek budget (waitMs refills without consuming) — take() runs only
    // on the member actually chosen, or every candidate would drain it.
    // Dead members (auth/config-fatal) are never eligible again.
    const live = this.members.filter(
      (m) => !m.dead && m.cooldownUntil <= now && this.bucket(m).waitMs() === 0,
    );
    const set = live.length ? live : this.members.filter((m) => !m.dead);
    const best = set.reduce((a, b) => (a.ewmaMs <= b.ewmaMs ? a : b));
    this.cursor = (this.cursor + 1) % set.length;
    const chosen = set[this.cursor] === best ? set[(this.cursor + 1) % set.length] : best;
    this.bucket(chosen).take();
    return chosen;
  }

  /** Ms until any endpoint is usable (live member with bucket budget). */
  private budgetWaitMs(): number {
    const now = Date.now();
    const eligible = this.members.filter((m) => !m.dead);
    if (!eligible.length) return Infinity;
    if (eligible.some((m) => m.cooldownUntil <= now && this.bucket(m).waitMs() === 0)) return 0;
    const waits = eligible.map((m) => Math.max(
      m.cooldownUntil - now > 0 ? m.cooldownUntil - now : 0,
      this.bucket(m).waitMs(),
    ));
    return Math.min(...waits);
  }

  /** Ms until the earliest member exits cooldown (0 when one is live). */
  private cooldownWaitMs(): number {
    const now = Date.now();
    const eligible = this.members.filter((m) => !m.dead);
    if (!eligible.length) return Infinity;
    if (eligible.some((m) => m.cooldownUntil <= now)) return 0;
    return Math.min(...eligible.map((m) => m.cooldownUntil)) - now;
  }


  /** Mark a member permanently dead — auth/config-fatal errors never
   *  heal by retrying (Alchemy "not enabled", bad key, 401/403/404). */
  private kill(m: Member, reason: string) {
    if (m.dead) return;
    m.dead = true;
    const { id, account } = providerOf(m.url);
    rpcRegistry.markDead(this.chain.key, m.url, reason, id, account);
    this.log.warn(`${this.chain.key} endpoint DEAD — ${reason}`, { url: hostOf(m.url) });
  }

  private aliveCount(): number { return this.members.filter((m) => !m.dead).length; }

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
      // fail fast when every endpoint is auth-dead — nothing to wait for
      if (!this.aliveCount()) throw lastErr ?? new Error(`${this.chain.key}: all RPC endpoints dead`);
      // wait for the earliest usable member — cooldown OR budget refill,
      // whichever the constraint is; never hot-loop a drained quota pool
      const wait = Math.max(this.cooldownWaitMs(), this.budgetWaitMs());
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 5_000)));
      for (let i = 0; i < this.members.length; i++) {
        const m = this.pick();
        const t0 = performance.now();
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        try {
          const res = await Promise.race([
            m.provider.send(method, params),
            new Promise((_, rej) => setTimeout(() => rej(new Error('rpc_timeout')), TIMEOUT_MS)),
          ]);
          m.ewmaMs = m.ewmaMs * (1 - EWMA_ALPHA) + (performance.now() - t0) * EWMA_ALPHA;
          m.failures = 0;
          const { id, account } = providerOf(m.url);
          rpcRegistry.markOk(this.chain.key, m.url, m.ewmaMs, this.chain.chainId, id, account);
          return res as T;
        } catch (e) {
          lastErr = e;
          const fatal = isDeadEndpoint(e);
          // never dead-mark the LAST live member — a single-endpoint pool
          // has no failover; permanent death guarantees zombie mode where
          // every call throws while callers swallow errors on stale state.
          // Penalize as transport instead: cooldown + retry is strictly
          // better, and an auth-fatal endpoint fails fast anyway.
          if (fatal && this.aliveCount() > 1) { this.kill(m, fatal); continue; }
          if (isTransportError(e) || fatal) this.penalize(m, isRateLimit(e));
          else throw e; // deterministic payload errors are not transport faults
        } finally {
          inFlight--;
        }
      }
    }
    throw lastErr;
  }

  /** ethers provider bound to this pool (uses best member's provider object). */
  get provider(): ethers.JsonRpcProvider {
    return this.pick().provider;
  }

  /** WO-regime: share of members neither dead nor cooling (0..1) —
   *  degraded-information signal for the market regime classifier. */
  healthFrac(): number {
    if (!this.members.length) return 0;
    const now = Date.now();
    const live = this.members.filter((m) => !m.dead && m.cooldownUntil <= now).length;
    return live / this.members.length;
  }

  async blockNumber(): Promise<number> {
    return this.call<number>('eth_blockNumber', []).then((h) => parseInt(h as unknown as string, 16));
  }

  async callContract(to: string, data: string, blockTag: string | number = 'latest'): Promise<string> {
    return this.call<string>('eth_call', [{ to, data }, blockTag]);
  }

  /** exec-probe: eth_call from an explicit identity (smart account under
   *  4337). blockTag enables pinned-state forensics; overrides carry the
   *  eth_call state-override bundle (balance/code/stateDiff) — omitted
   *  entirely when unset since not every backend accepts the param. */
  async callFrom(
    from: string, to: string, data: string, value = '0x0',
    blockTag: string | number = 'latest',
    overrides?: Record<string, { balance?: string; code?: string; stateDiff?: Record<string, string> }>,
  ): Promise<string> {
    const params: unknown[] = [{ from, to, data, value }, blockTag];
    if (overrides) params.push(overrides);
    return this.call<string>('eth_call', params);
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

/** Rate-limit detection — inspects the WHOLE error tree (ethers wraps
 *  provider errors: top message is 'could not coalesce error', the real
 *  'free plan rate limit' / code-15 lives in nested error/payload). */
const isRateLimit = (e: unknown): boolean => {
  let s = '';
  try { s = JSON.stringify(e) + String((e as { message?: string })?.message ?? ''); }
  catch { s = String(e); }
  return /429|rate limit|paid plan|code.{0,3}15|quota/i.test(s);
};

/** Auth/config-fatal detection — these NEVER heal by retrying:
 *  Alchemy "<NET> is not enabled for this app", invalid/rejected keys,
 *  plain 401/403/404 auth walls. Scans the whole nested error tree. */
const isDeadEndpoint = (e: unknown): string | null => {
  let s = '';
  try { s = JSON.stringify(e) + ' ' + String((e as { message?: string })?.message ?? ''); }
  catch { s = String(e); }
  if (/not enabled for this app/i.test(s)) return 'network not enabled on account';
  if (/must be authenticated|unauthorized|invalid api key|invalid project|\b401\b/i.test(s)) return 'auth rejected';
  if (/\b403\b|forbidden/i.test(s)) return 'access forbidden';
  // method-level failures are NOT endpoint death — a node that doesn't
  // serve a method still serves everything else
  if (/method not found|unsupported method|not implemented/i.test(s)) return null;
  if (/\b404\b/i.test(s)) return 'endpoint not found';
  return null;
};

const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url; }
};

let inFlight = 0;
let maxInFlight = 0;
/** memWatch sampler — live + peak concurrent RPC attempts across pools. */
export function rpcPoolStats(): { inFlight: number; maxInFlight: number } {
  return { inFlight, maxInFlight };
}

const pools = new Map<string, RpcPool>();
export const poolFor = (chain: ChainConfig): RpcPool => {
  let p = pools.get(chain.key);
  if (!p) { p = new RpcPool(chain); pools.set(chain.key, p); }
  return p;
};
