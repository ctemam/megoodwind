/**
 * WO-14 — speed lane: event→submit latency measurement + lost-race
 * attribution. Instruments the hot path with monotonic timestamps and
 * attributes every missed opportunity to a stage:
 *   detect_ms    — block/event arrival -> candidate emit
 *   solve_ms     — candidate emit -> plan built
 *   probe_ms     — plan -> execProbe verdict
 *   submit_ms    — probe -> tx sent
 *   land_ms      — sent -> mined (race window)
 * Lost-race check: for every probe-pass that didn't land, compare our
 * submission's block to the first post-state-changing tx on the touched
 * pools — if another tx moved the state in our target block, the race
 * was lost to latency, not to model error.
 */
import { appendFileSync, mkdirSync } from 'fs';

export interface LatencyStamp {
  detect_ms?: number;
  solve_ms?: number;
  probe_ms?: number;
  submit_ms?: number;
  land_ms?: number;
  total_ms?: number;
  outcome: 'settled' | 'lost_race' | 'revert' | 'filtered' | 'timeout';
  chain: string;
  path?: string;
  competitorTx?: string;   // tx that moved the pool state first (lost-race attribution)
  txHash?: string;
  note?: string;
}

export class LatencyTracker {
  private t0 = 0; private marks: Partial<LatencyStamp> = {};
  constructor(private chain: string) {}
  detect() { this.t0 = performance.now(); }
  solved() { this.marks.detect_ms = performance.now() - this.t0; this.t0 = performance.now(); }
  probed() { this.marks.solve_ms = performance.now() - this.t0; this.t0 = performance.now(); }
  submitted() { this.marks.probe_ms = performance.now() - this.t0; this.t0 = performance.now(); }
  landed() {
    this.marks.submit_ms = performance.now() - this.t0;
    this.marks.land_ms = this.marks.submit_ms; // sent->mined race window
    this.marks.total_ms = (this.marks.detect_ms ?? 0) + (this.marks.solve_ms ?? 0) + (this.marks.probe_ms ?? 0) + this.marks.submit_ms;
  }
  emit(outcome: LatencyStamp['outcome'], extra: Partial<LatencyStamp> = {}) {
    mkdirSync('data/speed', { recursive: true });
    appendFileSync('data/speed/latency.jsonl', JSON.stringify({ ts: Date.now(), chain: this.chain, outcome, ...this.marks, ...extra }) + '\n');
  }
}

/**
 * Lost-race attribution: did a competitor tx hit the touched pools in the
 * same block we would have landed? Scans the block's Swap logs on the
 * pools and returns the first mover's txHash.
 */
export async function firstMover(
  rpc: { call<T>(m: string, p: unknown[]): Promise<T> },
  pools: string[], block: number,
): Promise<string | null> {
  const SWAP_TOPICS = [
    '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', // v2
    '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', // v3
  ];
  for (const topic of SWAP_TOPICS) {
    const logs = await rpc.call<{ transactionHash: string }[]>('eth_getLogs', [{
      topics: [topic], address: pools,
      fromBlock: '0x' + block.toString(16), toBlock: '0x' + block.toString(16),
    }]).catch(() => [] as { transactionHash: string }[]);
    if (logs.length) return logs[0].transactionHash;
  }
  return null;
}
