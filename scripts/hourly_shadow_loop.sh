#!/usr/bin/env bash
# WO-8.6 — hourly shadow-report snapshots until the 24h window ends.
mkdir -p data/reports
while true; do
  h=$(( ($(date +%s) - $(date -r data/shadow_candidates.jsonl +%s 2>/dev/null || date +%s)) / 3600 ))
  CHAIN=base npx tsx scripts/shadow_report.ts > "data/reports/wo8_shadow_$(date +%Y%m%dT%H).txt" 2>&1
  sleep 3600
done
