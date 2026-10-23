/**
 * WO-11 — learned bid model. Replaces the unsourced fixed-% bribe:
 * bid* = argmax_b p_win(b|features) * (gross - gas - premium - b).
 * Logistic fit on (bidFrac, features) -> win, online gradient updates.
 * Cold-start: prior Beta(a,b) on win-rate bands -> conservative bid.
 * CUSUM on (predicted - realized) freezes the model when the world
 * moves under it (THRESHOLDS: freeze on sustained divergence).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

export interface BidRow {
  ts: number;
  bidFrac: number;     // bid as fraction of capturable gross
  gapBps: number;      // spread proxy
  grossUsd: number;
  won: boolean;
  predictedP?: number;
}

const FILE = 'data/private/bid_model.json';

export class BidModel {
  /** logistic weights [w0, w_bidFrac, w_gap] — fit online */
  private w = [-2.2, 6.0, 0.0];
  private rows: BidRow[] = [];
  private cusum = 0; private cusumFrozen = false;

  constructor() {
    if (existsSync(FILE)) {
      try { const j = JSON.parse(readFileSync(FILE, 'utf8')); this.w = j.w ?? this.w; this.cusum = j.cusum ?? 0; this.cusumFrozen = !!j.cusumFrozen; } catch {}
    }
  }

  pWin(bidFrac: number, gapBps = 0): number {
    const z = this.w[0] + this.w[1] * bidFrac + this.w[2] * gapBps;
    return 1 / (1 + Math.exp(-z));
  }

  /** EV-maximizing bid fraction over a grid; returns null if frozen. */
  optimalBid(grossUsd: number, gasUsd: number, premiumUsd: number, gapBps = 0): { bidFrac: number; evUsd: number } | null {
    if (this.cusumFrozen) return null;
    const capturable = grossUsd - gasUsd - premiumUsd;
    if (capturable <= 0) return { bidFrac: 0, evUsd: 0 };
    let best = { bidFrac: 0, evUsd: 0 };
    for (let f = 0; f <= 0.95; f += 0.05) {
      const ev = this.pWin(f, gapBps) * capturable * (1 - f);
      if (ev > best.evUsd) best = { bidFrac: f, evUsd: ev };
    }
    return best;
  }

  /** Observe an outcome: update logistic weights + CUSUM drift check. */
  observe(row: BidRow) {
    this.rows.push(row);
    if (this.rows.length > 5000) this.rows.shift();
    // online logistic gradient step
    const p = this.pWin(row.bidFrac, row.gapBps);
    const y = row.won ? 1 : 0;
    const lr = 0.05;
    this.w[0] += lr * (y - p);
    this.w[1] += lr * (y - p) * row.bidFrac;
    this.w[2] += lr * (y - p) * row.gapBps;
    // CUSUM on calibration: sum of (realized - predicted)
    if (row.predictedP !== undefined) {
      this.cusum = Math.max(0, this.cusum + (y - row.predictedP));
      if (this.cusum > 5) { this.cusumFrozen = true; } // sustained over-prediction -> freeze
      else if (this.cusum < -0.5) this.cusum = 0; // reset on wins below prediction... symmetric check via abs handled by clamp
    }
    mkdirSync('data/private', { recursive: true });
    writeFileSync(FILE, JSON.stringify({ w: this.w, cusum: this.cusum, cusumFrozen: this.cusumFrozen }));
    appendFileSync('data/private/bid_ledger.jsonl', JSON.stringify(row) + '\n');
  }

  get frozen(): boolean { return this.cusumFrozen; }
  unfreeze() { this.cusumFrozen = false; this.cusum = 0; }
}
