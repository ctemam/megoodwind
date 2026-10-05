#!/usr/bin/env bash
# Fleet watchdog — runs via cron every minute.
# Keeps arb-runners and the dashboard alive, detects funnel stalls
# (scans not advancing = hung runner → restart), and appends landed
# trades / notable events to logs/alerts.log for the monitor agent.
set -u
cd "$(dirname "$0")/.."
LOG=logs/watchdog.log
ALERTS=logs/alerts.log
STATE_DIR=logs/.watchdog
mkdir -p logs "$STATE_DIR"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

RUNNERS="bsc:9100:config/bsc.toml ethereum:9102:config/ethereum.toml polygon:9103:config/polygon.toml"

set -a; source .env 2>/dev/null; set +a
export PRIVATE_KEY="0x${PRIVATE_KEY#0x}"

relaunch() { # $1=chain $2=port $3=cfg
  echo "$(ts) relaunch runner $1 ($3) port $2" >> "$LOG"
  METRICS_PORT=$2 setsid ./target/release/arb-runner "$3" \
    >> "logs/$1.log" 2>&1 < /dev/null &
  disown
}

for spec in $RUNNERS; do
  chain="${spec%%:*}"; rest="${spec#*:}"
  port="${rest%%:*}"; cfg="${rest#*:}"

  if ! pgrep -f "arb-runner $cfg" >/dev/null 2>&1; then
    relaunch "$chain" "$port" "$cfg"
    continue
  fi

  # Funnel stall check: scans counter must advance between minutes.
  mfile="$STATE_DIR/$chain.scans"
  scans=$(curl -s --max-time 3 "localhost:$port/metrics" 2>/dev/null \
    | awk '/^arb_paths_evaluated_total/{s+=$2} END{print s+0}')
  if [ -n "$scans" ] && [ -f "$mfile" ]; then
    prev=$(cat "$mfile")
    if [ "$scans" = "$prev" ]; then
      echo "$(ts) $chain stalled (scans=$scans for 2 checks) — restarting" >> "$LOG"
      pgrep -f "arb-runner $cfg" | xargs -r kill -9
      sleep 1
      relaunch "$chain" "$port" "$cfg"
      continue
    fi
  fi
  [ -n "$scans" ] && echo "$scans" > "$mfile"

  # Landed-trade alert: any success landing is a real event.
  lfile="$STATE_DIR/$chain.landed"
  landed=$(curl -s --max-time 3 "localhost:$port/metrics" 2>/dev/null \
    | awk '/^arb_submit_landed_total{status="success"}/{s+=$2} END{print s+0}')
  if [ -n "$landed" ] && [ "$landed" != "0" ]; then
    prev=$(cat "$lfile" 2>/dev/null || echo 0)
    if [ "$landed" != "$prev" ]; then
      echo "$(ts) LANDED TRADE on $chain — cumulative success=$landed" >> "$ALERTS"
      echo "$landed" > "$lfile"
    fi
  fi
done

# Dashboard server.
if ! pgrep -f "server/index.js" >/dev/null 2>&1; then
  echo "$(ts) relaunch dashboard server :9205" >> "$LOG"
  NODE=$(command -v node || echo "$HOME/.nvm/versions/node/v24.19.0/bin/node")
  (cd apps/dashboard && DASHBOARD_PORT=9205 setsid "$NODE" server/index.js \
    >> ../../logs/dashboard.log 2>&1 < /dev/null &)
fi
