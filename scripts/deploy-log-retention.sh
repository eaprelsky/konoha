#!/usr/bin/env bash
# Deploy Konoha agent log retention system.
# Idempotent and safe to run multiple times.
# refs: docs/agent-log-retention-policy.md, #795
set -euo pipefail

REPO="/home/ubuntu/konoha"
SYSTEMD_DIR="/etc/systemd/system"
JOURNALD_DROPIN_DIR="/etc/systemd/journald.conf.d"

echo "=== Deploying Konoha agent log retention ==="

# 1. Copy systemd units
echo "Installing systemd units..."
sudo cp "$REPO/systemd/konoha-agent-log-retention.service" "$SYSTEMD_DIR/"
sudo cp "$REPO/systemd/konoha-agent-log-retention.timer" "$SYSTEMD_DIR/"

# 2. Install journald dropin
echo "Installing journald dropin..."
sudo mkdir -p "$JOURNALD_DROPIN_DIR"
sudo cp "$REPO/systemd/journald-konoha-retention.conf" "$JOURNALD_DROPIN_DIR/konoha.conf"

# 3. Ensure script is executable
chmod +x "$REPO/scripts/konoha-agent-log-retention.sh"

# 4. Remove old /usr/local/sbin copy if present
if [ -f /usr/local/sbin/konoha-agent-log-retention.sh ]; then
  echo "Removing old /usr/local/sbin copy..."
  sudo rm -f /usr/local/sbin/konoha-agent-log-retention.sh
fi

# 5. Reload systemd
echo "Reloading systemd..."
sudo systemctl daemon-reload

# 6. Enable and start timer
echo "Enabling timer..."
sudo systemctl enable konoha-agent-log-retention.timer
sudo systemctl start konoha-agent-log-retention.timer

# 7. Apply journald config
echo "Applying journald config..."
sudo systemctl restart systemd-journald || true

# 8. Dry-run verification
echo ""
echo "=== Dry-run verification ==="
"$REPO/scripts/konoha-agent-log-retention.sh" --json --dry-run
echo ""
echo "=== Retention system deployed ==="
systemctl status konoha-agent-log-retention.timer --no-pager
