#!/usr/bin/env bash
# Deploy the latest main on the Vultr server: pull, install, build, restart, health-check.
# Run on the server:  sudo /opt/crowdpulse/deploy/update.sh
set -euo pipefail
APP=/opt/crowdpulse
cd "$APP"
# Root runs this script; the tree is owned by crowdpulse — allow git without "dubious ownership".
git config --global --add safe.directory "$APP" 2>/dev/null || true
sudo -u crowdpulse git config --global --add safe.directory "$APP" 2>/dev/null || true

PREV=$(sudo -u crowdpulse git rev-parse HEAD)
# If installing, building or starting fails, go back to the version that was running, rebuilt, so
# a later restart never runs half-updated code.
rollback() {
  trap - ERR
  echo "✗ update failed — going back to $PREV"
  sudo -u crowdpulse git reset --hard --quiet "$PREV"
  sudo -u crowdpulse npm ci --no-audit --no-fund --loglevel=error
  sudo -u crowdpulse npm run build --silent
  systemctl restart crowdpulse
  exit 1
}
trap rollback ERR

echo "→ pulling latest code"
sudo -u crowdpulse git fetch --quiet origin
sudo -u crowdpulse git reset --hard --quiet origin/main
# Normalize if the script was edited on Windows (CRLF breaks the shebang).
sed -i 's/\r$//' "$APP/deploy/update.sh" 2>/dev/null || true
echo "  now at $(sudo -u crowdpulse git log --oneline -1)"

echo "→ installing dependencies"
sudo -u crowdpulse npm ci --no-audit --no-fund --loglevel=error

echo "→ building web app"
sudo -u crowdpulse npm run build --silent

echo "→ restarting service"
cp "$APP/deploy/crowdpulse.service" /etc/systemd/system/crowdpulse.service
systemctl daemon-reload
systemctl restart crowdpulse

echo "→ waiting for health"
for i in $(seq 1 30); do
  health=$(curl -fsS http://127.0.0.1:8787/api/health 2>/dev/null || true)
  # Up, and the database reachable (unless it runs without one).
  if [ -n "$health" ] && ! grep -q '"database":"down"' <<<"$health"; then
    echo "$health"
    echo "✓ CrowdPulse is up"
    exit 0
  fi
  sleep 1
done
echo "✗ CrowdPulse did not become healthy — recent logs:"
journalctl -u crowdpulse -n 40 --no-pager
trap - ERR
rollback
