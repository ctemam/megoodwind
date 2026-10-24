import { LatencyTracker } from '../src/speed/latency.js';
import { readFileSync, rmSync } from 'fs';
rmSync('data/speed', { recursive: true, force: true });
const t = new LatencyTracker('test');
t.detect();
await new Promise(r=>setTimeout(r,10)); t.solved();
await new Promise(r=>setTimeout(r,10)); t.probed();
await new Promise(r=>setTimeout(r,10)); t.submitted();
await new Promise(r=>setTimeout(r,10)); t.landed();
t.emit('settled',{path:'a>b'});
const row = JSON.parse(readFileSync('data/speed/latency.jsonl','utf8').trim());
console.log(row);
// assert: each stage positive, total ~ sum, labels correct
const ok = row.detect_ms>0 && row.solve_ms>0 && row.probe_ms>0 && row.submit_ms>0 && row.land_ms===row.submit_ms && Math.abs(row.total_ms - (row.detect_ms+row.solve_ms+row.probe_ms+row.submit_ms))<1;
console.log('PASS:', ok);
