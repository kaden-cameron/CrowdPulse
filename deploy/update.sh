#!/usr/bin/env bash
# Deploy the latest main on the Vultr server: pull, install, build, restart, health-check.
# Run on the server:  sudo /opt/crowdpulse/deploy/update.sh
set -euo pipefail
APP=/opt/crowdpulse
cd "$APP"

echo "→ pulling latest code"
sudo -u crowdpulse git fetch --quiet origin
sudo -u crowdpulse git reset --hard --quiet origin/main
echo "  now at $(git log --oneline -1)"

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
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
    curl -fsS http://127.0.0.1:8787/api/health; echo
    echo "✓ CrowdPulse is up"
    exit 0
  fi
  sleep 1
done
echo "✗ CrowdPulse did not become healthy — recent logs:"
journalctl -u crowdpulse -n 40 --no-pager
exit 1
