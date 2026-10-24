# COMPTOOL legacy retirement — Phase 1 dependency map (rev 1005b7c)
## CURRENT competitor-analysis mode (preserve ALL)
- scripts/competitor_scan.ts — THE pipeline entry (scan→store→attribution→triggers→rank→dashboard in one run)
- src/ci/* — 20 modules: store/rank/benchmark/scorecard/canonicalReport/cmmc/metricRegistry/economics/attribute/measure/diagnostics/triggers/hypotheses/changeControl/checkpoint/tokenRegistry/discoveryPriority/deconstruct/projAccuracy
- scripts/ci_*.ts — scan helpers: dashboard, deconstruct, backfill, lookback, h001/h005 experiments, diagnostics, projacc, verify, audit_runs, replay, report, seed_hypotheses
- data/ci/store.json + hypotheses.json + tokens.json + dashboard_eth.json (live state — NEVER delete)
## LEGACY candidates (review before retirement — NOT auto-remove)
| file | role | status |
|---|---|---|
| scripts/backrun_census.ts | earlier bot census scanner | supersedes by competitor_scan? VERIFY — may still collect distinct evidence |
| src/private/backrun.ts | backrun lane | strategy not CI — shared, preserve |
| data/leaders/*_bait_pools.json | forensics convictions | shared — feed attribution, preserve |
| scripts/factory_audit.ts | pre-H-001 factory scan | superseded by ci_h001_factory_audit — candidate for removal |
| scripts/wo*.ts | one-off work-order canaries | historical — archive candidates, not active |
## NOT legacy (shared infra, keep)
src/private/, src/exec/, src/strategies/, src/engine/, src/feed/, src/providers/, src/ops/, src/math/, src/pools/, src/discovery/, src/telemetry/, src/runner/, src/forensics/ — the LIVE trading pipeline; COMPTOOL is the observational layer over it.
## Startup/runtime path
competitor_scan.ts (manual invocation) → CiStore → aggregate/rank → scorecard→benchmark→dashboard. NO auto-startup hook — no scheduler, no PM2 profile, no engine registration. Legacy vs current distinction: there is no "two COMPTOOLs" — the only active path is the ci/* system; legacy = superseded helper scripts + data artifacts, not a parallel runtime.
## Retirement proposal (needs your approval, not done)
REMOVE: superseded scripts (factory_audit.ts, wo*_canary.ts one-offs) — pure archival noise.
KEEP: backrun_census (verify evidence distinct first), ALL src/ci, ALL data/ci, ALL shared trading modules.
## Startup-mode enforcement: add single-mode config check? Current scan has no mode ambiguity — it's the only path. A "mode" flag is unnecessary; the risk isn't legacy-vs-current selection, it's that competitor_scan is manual-invoked not scheduler-integrated.
