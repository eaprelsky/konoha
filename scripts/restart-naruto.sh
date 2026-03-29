#!/bin/bash
# Restart Naruto (Claude Agent #1) via systemd.
# Can be called by Sasuke or any trusted process.
# Usage: restart-naruto.sh [delay_seconds]
#
# The delay (default 5s) gives the calling agent time to finish
# before the service restarts and kills the tmux session.

DELAY="${1:-5}"
echo "[$(date)] Restart requested. Waiting ${DELAY}s before restart..."
sleep "$DELAY"
echo "[$(date)] Restarting claude-naruto.service..."
sudo systemctl restart claude-naruto.service
echo "[$(date)] Restart complete."
