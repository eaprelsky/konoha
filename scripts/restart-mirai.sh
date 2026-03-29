#!/bin/bash
# Restart Mirai (Claude Agent #3) via systemd.
# Can be called by Naruto, Sasuke or any trusted process.
# Usage: restart-mirai.sh [delay_seconds]

DELAY="${1:-5}"
echo "[$(date)] Restart requested. Waiting ${DELAY}s before restart..."
sleep "$DELAY"
echo "[$(date)] Restarting claude-mirai.service..."
sudo systemctl restart claude-mirai.service
echo "[$(date)] Restart complete."
