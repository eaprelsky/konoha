#!/bin/bash
# =============================================================================
# Setup script for agent.eaprelsky.ru
# Installs: Node.js 22, Claude Code, Paperclip, Telegram bot
# Run as: ubuntu user (not root)
# =============================================================================

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[x]${NC} $1"; exit 1; }

# ---------------------------------------------------------------------------
# 0. Pre-flight
# ---------------------------------------------------------------------------
log "Updating system packages..."
sudo apt-get update -qq && sudo apt-get upgrade -y -qq

log "Installing essentials..."
sudo apt-get install -y -qq \
  curl git tmux jq build-essential python3 python3-pip python3-venv unzip

# ---------------------------------------------------------------------------
# 1. Node.js 22 LTS
# ---------------------------------------------------------------------------
if ! command -v node &>/dev/null || [[ "$(node -v)" != v22* ]]; then
  log "Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
else
  log "Node.js 22 already installed: $(node -v)"
fi

log "Node: $(node -v) | npm: $(npm -v)"

# ---------------------------------------------------------------------------
# 2. pnpm (for Paperclip)
# ---------------------------------------------------------------------------
if ! command -v pnpm &>/dev/null; then
  log "Installing pnpm..."
  sudo npm install -g pnpm
else
  log "pnpm already installed: $(pnpm -v)"
fi

# ---------------------------------------------------------------------------
# 3. Claude Code
# ---------------------------------------------------------------------------
if ! command -v claude &>/dev/null; then
  log "Installing Claude Code..."
  sudo npm install -g @anthropic-ai/claude-code
else
  log "Claude Code already installed: $(claude --version 2>/dev/null || echo 'installed')"
fi

# ---------------------------------------------------------------------------
# 4. Claude Code configuration
# ---------------------------------------------------------------------------
log "Setting up Claude Code config..."

mkdir -p ~/.claude

# Allowlist: agent can read/write/edit files, run safe bash commands, no confirms
cat > ~/.claude/settings.json << 'SETTINGS'
{
  "permissions": {
    "allow": [
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "Bash(git:*)",
      "Bash(npm:*)",
      "Bash(npx:*)",
      "Bash(pnpm:*)",
      "Bash(node:*)",
      "Bash(python3:*)",
      "Bash(pip:*)",
      "Bash(cat:*)",
      "Bash(ls:*)",
      "Bash(mkdir:*)",
      "Bash(cp:*)",
      "Bash(mv:*)",
      "Bash(rm:*)",
      "Bash(find:*)",
      "Bash(grep:*)",
      "Bash(sed:*)",
      "Bash(awk:*)",
      "Bash(curl:*)",
      "Bash(docker:*)",
      "Bash(docker-compose:*)",
      "Bash(cd:*)",
      "Bash(echo:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(wc:*)",
      "Bash(sort:*)",
      "Bash(chmod:*)",
      "Bash(chown:*)",
      "Bash(test:*)",
      "Bash(touch:*)",
      "Bash(tar:*)",
      "Bash(unzip:*)"
    ],
    "deny": []
  }
}
SETTINGS

log "Claude Code allowlist configured."

# ---------------------------------------------------------------------------
# 5. Environment file (user fills in keys later)
# ---------------------------------------------------------------------------
ENV_FILE="$HOME/.agent-env"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << 'ENV'
# =============================================================================
# Agent environment variables
# Fill in your keys and source this file: source ~/.agent-env
# =============================================================================

# Anthropic API key (for Claude Code headless mode)
export ANTHROPIC_API_KEY="sk-ant-REPLACE_ME"

# Telegram bot token (from @BotFather)
export TELEGRAM_BOT_TOKEN="REPLACE_ME"

# Your Telegram user ID (for authorization, get from @userinfobot)
export TELEGRAM_OWNER_ID="REPLACE_ME"

# Paperclip (optional overrides)
export PAPERCLIP_PORT=3100
ENV
  warn "Created $ENV_FILE - EDIT IT with your API keys!"
else
  log "$ENV_FILE already exists, skipping."
fi

# ---------------------------------------------------------------------------
# 6. Paperclip
# ---------------------------------------------------------------------------
PAPERCLIP_DIR="$HOME/paperclip"

if [ ! -d "$PAPERCLIP_DIR" ]; then
  log "Cloning Paperclip..."
  git clone https://github.com/paperclipai/paperclip.git "$PAPERCLIP_DIR"
  cd "$PAPERCLIP_DIR"
  log "Installing Paperclip dependencies..."
  pnpm install
  log "Paperclip installed."
else
  log "Paperclip already cloned."
fi

# ---------------------------------------------------------------------------
# 7. Telegram bot (bridges messages to Claude Code)
# ---------------------------------------------------------------------------
BOT_DIR="$HOME/claude-telegram-bot"
mkdir -p "$BOT_DIR"

log "Creating Telegram bot..."

cat > "$BOT_DIR/requirements.txt" << 'REQ'
python-telegram-bot==21.10
REQ

cat > "$BOT_DIR/bot.py" << 'BOTPY'
"""
Telegram bot that bridges messages to Claude Code on this machine.
Only responds to TELEGRAM_OWNER_ID.
Supports /run (single prompt), /session (interactive tmux session), /status.
"""

import os
import sys
import asyncio
import subprocess
import logging
from datetime import datetime

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
OWNER_ID = int(os.environ.get("TELEGRAM_OWNER_ID", "0"))
WORK_DIR = os.environ.get("CLAUDE_WORK_DIR", os.path.expanduser("~/projects"))
MAX_MESSAGE_LEN = 4000  # Telegram limit ~4096, leave margin


def owner_only(func):
    """Decorator: only allow the owner to use the bot."""
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        if update.effective_user.id != OWNER_ID:
            await update.message.reply_text("Access denied.")
            return
        return await func(update, context)
    return wrapper


def truncate(text: str, limit: int = MAX_MESSAGE_LEN) -> str:
    if len(text) <= limit:
        return text
    half = (limit - 20) // 2
    return text[:half] + "\n\n... (truncated) ...\n\n" + text[-half:]


async def run_claude(prompt: str, work_dir: str = None) -> str:
    """Run claude -p with the given prompt, return output."""
    cmd = [
        "claude", "-p", prompt,
        "--output-format", "text",
        "--max-turns", "20",
    ]
    env = {**os.environ, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=work_dir or WORK_DIR,
        env=env,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=600)

    result = stdout.decode("utf-8", errors="replace").strip()
    if proc.returncode != 0 and stderr:
        err_text = stderr.decode("utf-8", errors="replace").strip()
        result += f"\n\n[stderr] {err_text}"

    return result or "(empty response)"


@owner_only
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Agent bot ready.\n\n"
        "Send any message - it goes to `claude -p`.\n"
        "/project <path> - set working directory\n"
        "/status - system info\n"
        "/help - this message",
        parse_mode="Markdown",
    )


@owner_only
async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await cmd_start(update, context)


@owner_only
async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        mem = subprocess.check_output(["free", "-h"], text=True)
        disk = subprocess.check_output(["df", "-h", "/"], text=True)
        load = subprocess.check_output(["uptime"], text=True).strip()
        tmux_sessions = subprocess.run(
            ["tmux", "list-sessions"], capture_output=True, text=True
        ).stdout.strip() or "no tmux sessions"

        text = (
            f"```\n"
            f"Host: {os.uname().nodename}\n"
            f"Load: {load}\n\n"
            f"Memory:\n{mem}\n"
            f"Disk:\n{disk}\n"
            f"Tmux:\n{tmux_sessions}\n"
            f"Work dir: {WORK_DIR}\n"
            f"```"
        )
        await update.message.reply_text(text, parse_mode="Markdown")
    except Exception as e:
        await update.message.reply_text(f"Error: {e}")


@owner_only
async def cmd_project(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global WORK_DIR
    if context.args:
        path = " ".join(context.args)
        expanded = os.path.expanduser(path)
        if os.path.isdir(expanded):
            WORK_DIR = expanded
            await update.message.reply_text(f"Working directory: `{WORK_DIR}`", parse_mode="Markdown")
        else:
            await update.message.reply_text(f"Directory not found: `{expanded}`", parse_mode="Markdown")
    else:
        await update.message.reply_text(f"Current: `{WORK_DIR}`", parse_mode="Markdown")


@owner_only
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Forward any text message to claude -p."""
    prompt = update.message.text
    if not prompt:
        return

    # Send "thinking" indicator
    thinking = await update.message.reply_text("Running...")

    try:
        result = await run_claude(prompt, WORK_DIR)
        await thinking.edit_text(truncate(result))
    except asyncio.TimeoutError:
        await thinking.edit_text("Timeout (10 min). Use shorter tasks or split them up.")
    except Exception as e:
        await thinking.edit_text(f"Error: {e}")


def main():
    if not BOT_TOKEN or BOT_TOKEN == "REPLACE_ME":
        logger.error("Set TELEGRAM_BOT_TOKEN in ~/.agent-env")
        sys.exit(1)
    if OWNER_ID == 0:
        logger.error("Set TELEGRAM_OWNER_ID in ~/.agent-env")
        sys.exit(1)

    os.makedirs(WORK_DIR, exist_ok=True)

    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("project", cmd_project))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info(f"Bot starting. Owner ID: {OWNER_ID}, Work dir: {WORK_DIR}")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
BOTPY

# Create venv and install deps
python3 -m venv "$BOT_DIR/venv"
"$BOT_DIR/venv/bin/pip" install -q -r "$BOT_DIR/requirements.txt"

log "Telegram bot created in $BOT_DIR"

# ---------------------------------------------------------------------------
# 8. Systemd services
# ---------------------------------------------------------------------------
log "Creating systemd services..."

# --- Telegram bot service ---
sudo tee /etc/systemd/system/claude-telegram.service > /dev/null << EOF
[Unit]
Description=Claude Code Telegram Bot
After=network.target

[Service]
Type=simple
User=ubuntu
EnvironmentFile=$HOME/.agent-env
WorkingDirectory=$BOT_DIR
ExecStart=$BOT_DIR/venv/bin/python $BOT_DIR/bot.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# --- Paperclip service ---
sudo tee /etc/systemd/system/paperclip.service > /dev/null << EOF
[Unit]
Description=Paperclip AI Orchestrator
After=network.target

[Service]
Type=simple
User=ubuntu
EnvironmentFile=$HOME/.agent-env
WorkingDirectory=$PAPERCLIP_DIR
ExecStart=$(which pnpm) dev:once
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload

log "Systemd services created (not started yet - fill in API keys first)."

# ---------------------------------------------------------------------------
# 9. Convenience: projects directory
# ---------------------------------------------------------------------------
mkdir -p ~/projects

# ---------------------------------------------------------------------------
# 10. Summary
# ---------------------------------------------------------------------------
cat << 'SUMMARY'

=============================================================================
  Setup complete! Next steps:
=============================================================================

  1. Edit API keys:
     nano ~/.agent-env

     Fill in:
     - ANTHROPIC_API_KEY  (from console.anthropic.com)
     - TELEGRAM_BOT_TOKEN (from @BotFather in Telegram)
     - TELEGRAM_OWNER_ID  (send /start to @userinfobot)

  2. Source the env and authenticate Claude Code:
     source ~/.agent-env
     claude  # interactive login, then exit with /exit

  3. Start services:
     sudo systemctl enable --now claude-telegram
     sudo systemctl enable --now paperclip

  4. Check status:
     sudo systemctl status claude-telegram
     sudo systemctl status paperclip
     journalctl -u claude-telegram -f

  5. Use Claude Code remotely:
     - Telegram: send any message to your bot
     - Browser: tmux new -s claude && claude remote-control
       (open the URL on claude.ai/code or mobile app)
     - Headless: claude -p "your task" --output-format text

  6. Paperclip UI:
     http://agent.eaprelsky.ru:3100
     (open port 3100 in VK Cloud firewall)

  7. Clone Nocturna for staging:
     cd ~/projects
     git clone <your-nocturna-repo>

=============================================================================
SUMMARY

