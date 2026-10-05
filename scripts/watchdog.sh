#!/usr/bin/env bash
# Fleet watchdog — keeps arb-runners and the dashboard alive.
# Runs via cron every minute: relaunches any dead process, never
# double-starts, and logs every action to logs/watchdog.log.
set -u
cd "$(dirname "$0")/.."
LOG=logs/watchdog.log
mkdir -p logs data/leaders

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# chain:port:config triples for the runners.
RUNNERS="bsc:9100:config/bsc.toml ethereum:9102:config/ethereum.toml polygon:9103:config/polygon.toml"

set -a; source .env 2>/dev/null; set +a
export PRIVATE_KEY="0x${PRIVATE_KEY#0x}"

for spec in $RUNNERS; do
  chain="${spec%%:*}"; rest="${spec#*:}"
  port="${rest%%:*}"; cfg="${rest#*:}"
  if ! pgrep -f "arb-runner $cfg" >/dev/null 2>&1; then
    echo "$(ts) relaunch runner $chain ($cfg) port $port" >> "$LOG"
    METRICS_PORT=$port setsid ./target/release/arb-runner "$cfg" \
      >> "logs/$chain.log" 2>&1 < /dev/null &
    disown
  fi
done

# Dashboard server.
if ! pgrep -f "server/index.js" >/dev/null 2>&1; then
  echo "$(ts) relaunch dashboard server :9205" >> "$LOG"
  NODE=$(command -v node || echo "$HOME/.nvm/versions/node/v24.19.0/bin/node")
  (cd apps/dashboard && DASHBOARD_PORT=9205 setsid "$NODE" server/index.js \
    >> ../../logs/dashboard.log 2>&1 < /dev/null &)
  disown || true
fi
