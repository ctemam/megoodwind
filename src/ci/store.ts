/**
 * WO-03 — CI data-integrity layer: canonical event ids, idempotent ingest,
 * provenance, quarantine, quality counters. Durable JSON store, atomic writes.
 * Trusted set = records not quarantined. Quarantined records are PRESERVED
 * (never silently erased) but excluded from rankings/learning via trusted().
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';

export type ClassLabel =
  | 'verified_active_contract' | 'verified_active_eoa_signer' | 'verified_active_eoa_direct'
  | 'provisional_contract' | 'provisional_eoa_signer' | 'provisional_eoa_direct'
  | 'unverified_frontrunner' | 'suspected_deceptive' | 'confirmed_malicious'
  | 'inactive_historical' | 'unclassifiable' | 'unclassifiable_decode_artifact';

export interface CiRecord {
  eventId: string;            // canonical: chain:txHash[:logIndex]
  schema: string;             // decoder+schema version e.g. 'ci-v3'
  chain: string;
  kind: 'arb' | 'liquidation';
  block?: number;             // absent ≠ zero; undefined = unknown
  txIndex?: number;
  tx: string;
  signer?: string;            // tx.from — NOT assumed to be the operator
  executor?: string;          // tx.to — execution contract, when contract
  pools: string[];
  routeLen?: number;
  profitRaw?: string;         // raw token units
  profitToken?: string;
  profitUsd?: number;         // absent = unpriced, never fabricated
  gasUsed?: string;
  receiptVerified?: boolean;  // status=1 confirmed
  econ?: { status: string; netUsd?: number; gasCostUsd?: number; unknowns: string[]; confidence: number };
  entityClass?: ClassLabel;
  classConfidence?: number;   // 0..1
  fingerprint?: string;
  clusterId?: string;         // shared-executor cluster
  evidence: { source: string; ingestedAt: number; decoder: string }[];
  corrections: { at: number; field: string; from: unknown; to: unknown }[];
  quarantine?: { reason: string; evidence: string; at: number; released?: number };
}

export interface QualityCounters {
  received: number; unique: number; dupsSuppressed: number;
  incomplete: number; quarantined: number; released: number;
  unpricedProfit: number; unresolvedIdentity: number;
  reconciled: number; reprocessed: number;
}

interface Store { records: Record<string, CiRecord>; counters: QualityCounters; classHistory: Record<string, { at: number; cls: ClassLabel; evidence: string }[]>; }

export class CiStore {
  private s: Store;
  private file: string;
  constructor(file = 'data/ci/store.json') {
    this.file = file;
    this.s = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { records: {}, counters: { received: 0, unique: 0, dupsSuppressed: 0, incomplete: 0, quarantined: 0, released: 0, unpricedProfit: 0, unresolvedIdentity: 0, reconciled: 0, reprocessed: 0 }, classHistory: {} };
  }
  static eventId(chain: string, tx: string, logIndex?: number) {
    return `${chain}:${tx.toLowerCase()}${logIndex !== undefined ? ':' + logIndex : ''}`;
  }
  /** Fingerprint of full record content — ingest is idempotent only for identical content */
  private contentHash(r: Partial<CiRecord>) {
    const { evidence, corrections, ...core } = r;
    return createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 16);
  }

  /** Idempotent ingest. Returns 'new' | 'dup' | 'reconciled' (new evidence on existing) | 'corrected'. */
  ingest(r: Omit<CiRecord, 'eventId' | 'evidence' | 'corrections'> & { eventId?: string; source?: string }): 'new' | 'dup' | 'reconciled' | 'corrected' {
    this.s.counters.received++;
    const eventId = r.eventId ?? CiStore.eventId(r.chain, r.tx);
    const ev = { source: r.source ?? 'competitor_scan', ingestedAt: Date.now(), decoder: r.schema };
    const existing = this.s.records[eventId];
    if (existing) {
      const same = this.contentHash(existing) === this.contentHash({ ...r, eventId } as CiRecord);
      if (same) { this.s.counters.dupsSuppressed++; return 'dup'; }
      // reconcile: fill previously-missing fields; track corrections for changed ones
      let changed = false;
      for (const [k, v] of Object.entries(r) as [keyof CiRecord, unknown][]) {
        if (k === 'schema' || v === undefined) continue;
        if (existing[k] === undefined) { (existing as any)[k] = v; changed = true; this.s.counters.reconciled++; }
        else if (JSON.stringify(existing[k]) !== JSON.stringify(v)) {
          existing.corrections.push({ at: Date.now(), field: k, from: existing[k], to: v });
          (existing as any)[k] = v; changed = true;
        }
      }
      if (changed) existing.evidence.push(ev);
      return changed ? 'corrected' : 'dup';
    }
    this.s.records[eventId] = { ...(r as CiRecord), eventId, evidence: [ev], corrections: [] };
    this.s.counters.unique++;
    if (r.profitRaw !== undefined && r.profitUsd === undefined) this.s.counters.unpricedProfit++;
    if (!r.entityClass || String(r.entityClass).startsWith('provisional')) this.s.counters.unresolvedIdentity++;
    if (r.block === undefined || r.txIndex === undefined) this.s.counters.incomplete++;
    return 'new';
  }

  setClass(eventId: string, cls: ClassLabel, confidence: number, evidence: string) {
    const r = this.s.records[eventId];
    if (!r) throw new Error(`unknown event ${eventId}`);
    r.entityClass = cls; r.classConfidence = confidence;
    (this.s.classHistory[eventId] ??= []).push({ at: Date.now(), cls, evidence });
  }

  quarantine(eventId: string, reason: string, evidence: string) {
    const r = this.s.records[eventId];
    if (!r) throw new Error(`unknown event ${eventId}`);
    if (!r.quarantine) this.s.counters.quarantined++;
    r.quarantine = { reason, evidence, at: Date.now() };
  }
  /** Release only when `criteria` explicitly satisfied — caller asserts policy. */
  release(eventId: string, satisfied: boolean, evidence: string) {
    const r = this.s.records[eventId];
    if (!r?.quarantine) return false;
    if (!satisfied) return false;
    r.quarantine.released = Date.now();
    r.corrections.push({ at: Date.now(), field: 'quarantine.release', from: r.quarantine.reason, to: evidence });
    this.s.counters.released++;
    return true;
  }

  /** Trusted set for rankings/learning — quarantined NEVER included. */
  trusted(): CiRecord[] { return Object.values(this.s.records).filter((r) => !r.quarantine || r.quarantine.released !== undefined); }
  quarantined(): CiRecord[] { return Object.values(this.s.records).filter((r) => r.quarantine && r.quarantine.released === undefined); }
  get(eventId: string) { return this.s.records[eventId]; }
  counters() { return { ...this.s.counters }; }
  classHistory(eventId: string) { return this.s.classHistory[eventId] ?? []; }

  /** Atomic persist: tmp + rename survives crash mid-write. */
  flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.s));
    renameSync(tmp, this.file);
  }
}
