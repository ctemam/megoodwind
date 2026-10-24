/**
 * WO-09 — Autonomous trigger engine. Triggers open investigations and attach
 * evidence to hypotheses; they NEVER auto-accept, auto-integrate, or touch
 * protected targets. Hysteresis + persistence + dedupe + cooldown + quality
 * gates. Persistent state for restart safety. Kill switch under governance.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';

export interface TriggerDef {
  id: string;
  family: 'visibility' | 'attribution' | 'econ_accuracy' | 'regime' | 'source_health' | 'competitor';
  metric: string;
  threshold: number;
  direction: 'gt' | 'lt';
  recovery?: number;            // hysteresis: must return past this to reset
  persistence: number;          // consecutive qualifying windows required
  minSample: number;
  minCoverage?: number;         // data-quality prerequisite (0..1)
  cooldownMs: number;
  dedupeKey: (obs: Observation) => string;
  hypothesisId?: string;
  severity: 'info' | 'warn' | 'critical';
  maxEvalPerDay?: number;
}

export interface Observation {
  metric: string; value: number; sample: number; coverage?: number;
  window: string; evidenceId: string;   // evidenceId dedupes identical evidence
}

export type TriggerAction =
  | { kind: 'investigate'; hypothesisId?: string; evidence: string }
  | { kind: 'request_replay'; hypothesisId?: string; cases: string[] }
  | { kind: 'recommend_review'; target: string }
  | { kind: 'escalate_commander'; reason: string };

interface TrigState { armed: Record<string, boolean>; streak: Record<string, number>; lastFired: Record<string, number>; seen: Record<string, number>; evalCount: Record<string, number>; day: string; }
interface Counters { fired: number; suppressed_dup: number; suppressed_cooldown: number; suppressed_hysteresis: number; suppressed_quality: number; suppressed_minsample: number; suppressed_killed: number; actions: number; }

export class TriggerEngine {
  private st: TrigState;
  private counters: Counters = { fired: 0, suppressed_dup: 0, suppressed_cooldown: 0, suppressed_hysteresis: 0, suppressed_quality: 0, suppressed_minsample: 0, suppressed_killed: 0, actions: 0 };
  private killed = false;
  constructor(private defs: TriggerDef[], private file = 'data/ci/triggers.json') {
    this.st = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))
      : { armed: {}, streak: {}, lastFired: {}, seen: {}, evalCount: {}, day: '' };
  }
  kill() { this.killed = true; }
  revive() { this.killed = false; }

  /** Evaluate one observation against matching defs. Returns actions (may be []). */
  evaluate(obs: Observation, now = Date.now()): TriggerAction[] {
    const out: TriggerAction[] = [];
    const today = new Date(now).toISOString().slice(0, 10);
    if (this.st.day !== today) { this.st.evalCount = {}; this.st.day = today; }
    for (const d of this.defs) {
      if (d.metric !== obs.metric) continue;
      // quality + min-sample gates first — bad data never fires anything
      if (obs.sample < d.minSample) { this.counters.suppressed_minsample++; continue; }
      if (d.minCoverage !== undefined && (obs.coverage ?? 0) < d.minCoverage) { this.counters.suppressed_quality++; continue; }
      // dedupe: identical evidence re-ingested → suppressed
      const dk = `${d.id}:${d.dedupeKey(obs)}`;
      if (this.st.seen[dk]) { this.counters.suppressed_dup++; continue; }
      this.st.seen[dk] = now;
      // hysteresis + persistence
      const breach = d.direction === 'gt' ? obs.value > d.threshold : obs.value < d.threshold;
      const recovered = d.recovery !== undefined && (d.direction === 'gt' ? obs.value < d.recovery : obs.value > d.recovery);
      if (this.st.armed[d.id] && recovered) { this.st.armed[d.id] = false; this.st.streak[d.id] = 0; continue; }
      if (!breach) { this.st.streak[d.id] = 0; continue; }
      this.st.streak[d.id] = (this.st.streak[d.id] ?? 0) + 1;
      if (this.st.streak[d.id] < d.persistence) { this.counters.suppressed_hysteresis++; continue; }
      // cooldown + daily cap
      if (this.st.lastFired[d.id] && now - this.st.lastFired[d.id] < d.cooldownMs) { this.counters.suppressed_cooldown++; continue; }
      if (d.maxEvalPerDay && (this.st.evalCount[d.id] ?? 0) >= d.maxEvalPerDay) { this.counters.suppressed_cooldown++; continue; }
      if (this.killed) { this.counters.suppressed_killed++; continue; }
      // FIRE — produce an investigation action only
      this.st.armed[d.id] = true; this.st.lastFired[d.id] = now;
      this.st.evalCount[d.id] = (this.st.evalCount[d.id] ?? 0) + 1;
      this.counters.fired++;
      out.push(d.hypothesisId
        ? { kind: 'investigate', hypothesisId: d.hypothesisId, evidence: `${obs.metric}=${obs.value} (${obs.window}, n=${obs.sample})` }
        : { kind: 'investigate', evidence: `${obs.metric}=${obs.value} (${obs.window}, n=${obs.sample})` });
    }
    if (out.length) this.persist();
    return out;
  }
  actionResult(_a: TriggerAction) { this.counters.actions++; this.persist(); }
  stats() { return { ...this.counters, armed: { ...this.st.armed } }; }
  persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify(this.st));
    renameSync(this.file + '.tmp', this.file);
  }
}

/** Default trigger set — H-001/H-002 wired, all thresholds evidence-derived. */
export const DEFAULT_TRIGGERS: TriggerDef[] = [
  {
    id: 'vis-fail-gt-50', family: 'visibility', metric: 'visibility_failure_rate',
    threshold: 0.5, direction: 'gt', recovery: 0.35, persistence: 2,
    minSample: 20, minCoverage: 0.95, cooldownMs: 30 * 60_000, maxEvalPerDay: 4,
    dedupeKey: (o) => o.evidenceId, hypothesisId: 'H-001', severity: 'warn',
  },
  {
    id: 'indet-gt-10', family: 'attribution', metric: 'indeterminate_rate',
    threshold: 0.1, direction: 'gt', recovery: 0.05, persistence: 1,
    minSample: 8, minCoverage: 0.95, cooldownMs: 60 * 60_000, maxEvalPerDay: 2,
    dedupeKey: (o) => o.evidenceId, hypothesisId: 'H-002', severity: 'info',
  },
];
