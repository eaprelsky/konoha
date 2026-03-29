#!/bin/bash
# Restart Sasuke (Claude Agent #2) via systemd.
# Can be called by Naruto or any trusted process.
# Usage: restart-sasuke.sh [delay_seconds]

DELAY="${1:-5}"
echo "[$(date)] Restart requested. Waiting ${DELAY}s before restart..."
sleep "$DELAY"
echo "[$(date)] Restarting claude-sasuke.service..."
sudo systemctl restart claude-sasuke.service
echo "[$(date)] Restart complete."
