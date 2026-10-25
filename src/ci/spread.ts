/**
 * Stage-3F — spreadFor(): cross-venue price divergence DIAGNOSTIC.
 * spreadRatio=(max−min)/min over comparable same-pair same-direction quotes
 * at a consistent snapshot. Diagnostic emit only — never a trade decision.
 * unavailable≠zero; stale/invalid rejected explicitly.
 */
export interface VenueQuote { venue: string; price: number; block?: number; ageMs?: number }
export type SpreadStatus = 'ok' | 'unavailable' | 'stale' | 'invalid';
export interface SpreadResult {
  status: SpreadStatus; reason?: string;
  pair?: string; spreadRatio?: number; spreadBps?: number;
  maxVenue?: string; minVenue?: string; validQuotes: number;
  quotes?: { venue: string; price: number; ageMs?: number }[];
}
const STALE_MS = 30_000;

export function spreadFor(pair: string, quotes: VenueQuote[], opts: { maxAgeMs?: number; block?: number } = {}): SpreadResult {
  const maxAge = opts.maxAgeMs ?? STALE_MS;
  if (!quotes?.length) return { status: 'unavailable', reason: 'no quotes', validQuotes: 0 };
  // validity: positive finite price, consistent block if given, fresh age
  const valid = quotes.filter((q) => Number.isFinite(q.price) && q.price > 0
    && (q.block === undefined || opts.block === undefined || q.block === opts.block)
    && (q.ageMs === undefined || q.ageMs <= maxAge));
  const staleCount = quotes.length - valid.length;
  if (staleCount === quotes.length) return { status: 'stale', reason: `all ${quotes.length} quotes stale/invalid`, validQuotes: 0 };
  if (valid.length < 2) return { status: 'unavailable', reason: `${valid.length} valid quote(s) — need ≥2 venues`, validQuotes: valid.length };
  const sorted = [...valid].sort((a, b) => a.price - b.price);
  const min = sorted[0], max = sorted[sorted.length - 1];
  const ratio = (max.price - min.price) / min.price;
  return {
    status: 'ok', pair, spreadRatio: +ratio.toFixed(8), spreadBps: Math.round(ratio * 10_000 * 100) / 100,
    maxVenue: max.venue, minVenue: min.venue, validQuotes: valid.length,
    quotes: valid.map((q) => ({ venue: q.venue, price: q.price, ageMs: q.ageMs })),
  };
}
