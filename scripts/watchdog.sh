#!/usr/bin/env bash
# watchdog.sh — keep arb-runner alive. Install under cron:
#   * * * * * /path/to/MyAllBright/scripts/watchdog.sh
#   @reboot   /path/to/MyAllBright/scripts/watchdog.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
mkdir -p data

if ! pgrep -f "arb-r[u]nner|arbRunner" >/dev/null; then
  echo "$(date -Is) watchdog: restarting arb-runner" >> data/runner.log
  nohup npx tsx src/runner/arbRunner.ts >> data/runner.log 2>&1 &
fi
