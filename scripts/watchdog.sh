#!/usr/bin/env bash
# External watchdog: runs OUTSIDE the app process tree via launchd, so it can
# detect and recover from a *full* outage (crash, laptop sleep, someone
# killing the process). The in-process batch-watchdog Inngest cron can't do
# this — it dies along with everything else when the server goes down, which
# is exactly why a stalled follow-up batch went silent until manual restart.
set -uo pipefail

# launchd runs with a minimal environment — nvm's node/npm aren't on PATH
# unless we add them explicitly.
export PATH="/Users/tokki/.nvm/versions/node/v24.11.1/bin:/usr/local/bin:/usr/bin:/bin"

REPO_DIR="/Users/tokki/Documents/Files/repositories/leads-scraper-ig"
cd "$REPO_DIR"

ENV_FILE="$REPO_DIR/.env.local"
BOT_TOKEN=$(grep '^TELEGRAM_ALERTS_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
CHAT_ID=$(grep '^TELEGRAM_ALERT_CHAT_ID=' "$ENV_FILE" | cut -d= -f2-)
STATE_FILE="/tmp/leads-scraper-watchdog.state"
HEALTH_URL="http://localhost:3000/api/inngest"
LOG_FILE="/tmp/leads-scraper-dev.log"

send_alert() {
  local text="$1"
  if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\": \"${CHAT_ID}\", \"text\": \"${text}\"}" > /dev/null
  fi
}

is_up() {
  code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null)
  [ "$code" = "200" ]
}

prev_state="up"
[ -f "$STATE_FILE" ] && prev_state=$(cat "$STATE_FILE")

if is_up; then
  if [ "$prev_state" = "down" ]; then
    send_alert "✅ leads-scraper-ig dev server is back up."
  fi
  echo "up" > "$STATE_FILE"
  exit 0
fi

# Only alert on the up->down transition, not every check, so a sustained
# outage doesn't spam the chat every couple of minutes.
if [ "$prev_state" = "up" ]; then
  send_alert "🔴 leads-scraper-ig dev server is DOWN. Attempting auto-restart..."
fi
echo "down" > "$STATE_FILE"

pkill -f "concurrently -k -n next,inngest,telegram" 2>/dev/null || true
sleep 2

nohup npm run dev > "$LOG_FILE" 2>&1 &
disown

sleep 20

if is_up; then
  send_alert "✅ leads-scraper-ig dev server auto-restarted successfully."
  echo "up" > "$STATE_FILE"
else
  send_alert "⚠️ leads-scraper-ig auto-restart FAILED — needs manual attention. Check $LOG_FILE"
fi
