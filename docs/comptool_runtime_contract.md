# COMPTOOL runtime contract — design only (rev 8e68c05)
## 1. Current invocation path (actual, traced)
`npx tsx scripts/competitor_scan.ts <chain>` → RpcPool+tokensForChain+Discovery.boot → swap decode → attrib → CiStore.ingest → triggers → rank/aggregate → import('./ci_dashboard.js') → writeFileSync(docs/comptool_<chain>.md + data/ci/dashboard_<chain>.json).
- No scheduler, no PM2, no startup hook — manual invocation only.
- Outputs: docs/comptool_eth.md (display), data/ci/dashboard_eth.json (canonical).
- Downstream consumer: discoveryPriority() reads store freshness via mtime (≤24h → evidence else fallback_empty).
- Failure: dashboard write wrapped try/catch (log+preserve prev); CMMC gate exit-3 on contract fail.
## 2. Contract spec — exists vs proposed
| concern | exists | proposed |
|---|---|---|
| invocation | manual tsx command | + `data/ci/last_run.json` status record per run (runId,chain,ts,result,error) |
| freshness | store mtime in discoveryPriority | + lastRun.timestamp consumed by consumers |
| run identity | none explicit | runId = sha256(store+rev+ts).slice(12) written into last_run+dashboard |
| dup runs | none — concurrent runs share store file | file lock or runId guard; concurrent→second run waits or skips w/ status |
| failure recovery | prev md preserved on dashboard fail | last_run.status='failed' preserves + records reason |
| health | none | last_run.json = health surface: lastAttempt/lastSuccess/streak |
| consumer safety | discoveryPriority stale→fallback | unchanged — contract declares fallback normative |
| strategy isolation | no consumer of weights | invariant: consumers may only read pools/tokens, never thresholds |
## 3. Reuse vs gaps
REUSE: CiStore (atomic persist), CMMC gate, checkpoint.ts (atomic+prev), discoveryPriority freshness.
GAPS (genuine): runId tracking, dup-run guard, last_run health file, explicit run status enum.
## 4. Failure modes
concurrent: store write last-wins today → need run guard | interrupted: checkpoint preserves | stale input: discoveryPriority already handles | empty corpus: fallback_empty verdicts, never zero-claims.
## 5. Implementation plan (for approval)
+ ~60 LOC: `src/ci/runStatus.ts` (runId, write last_run.json atomically via checkpoint.ts save), guard flag in scan, status enum (success/failed/partial). Tests: runId unique, dup-run detected, failed→prev preserved, last_run schema. No scheduler, no PM2, no exec.
## 6. Decisions required
- dup-run policy: skip-vs-queue (recommend skip+status) — needs approval
- runId derivation: include code rev? (recommend yes)
