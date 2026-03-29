# Konoha — Install Guide

## Prerequisites

| Tool | Install |
|---|---|
| [bun](https://bun.sh) | `curl -fsSL https://bun.sh/install \| bash` |
| Redis | `sudo apt install redis-server && sudo systemctl enable --now redis` |
| tmux | `sudo apt install tmux` |
| [Claude Code CLI](https://claude.ai/code) | `npm install -g @anthropic-ai/claude-code` |
| Python 3.10+ | `sudo apt install python3 python3-pip` |
| Python deps | `pip install redis requests telethon` |
| GitHub CLI | [cli.github.com](https://cli.github.com) |

## Environment Variables

All agent systemd services load `/home/ubuntu/.agent-env` on startup.

Create the file (chmod 600):

```bash
cat > /home/ubuntu/.agent-env << 'EOF'
KONOHA_TOKEN=<konoha bus token>
KONOHA_URL=http://127.0.0.1:3200
GH_TOKEN=<github personal access token>
OWNER_TG_ID=<owner telegram user id>
SASHA_TG_ID=<sasha telegram user id>
COMIND_LEADS_CHAT_ID=<comind leads group chat id>
BITRIX_WEBHOOK_URL=https://your-bitrix.bitrix24.ru/rest/1/<token>
EOF
chmod 600 /home/ubuntu/.agent-env
```

Private config (phone numbers, server IPs, VNC password) lives in `/opt/shared/.owner-config` (chmod 600). Copy from backup or fill manually.

## Scripts

```bash
# Copy all scripts from repo to server
cp /home/ubuntu/konoha/scripts/*.sh /home/ubuntu/scripts/
cp /home/ubuntu/konoha/scripts/*.py /home/ubuntu/scripts/
chmod +x /home/ubuntu/scripts/*.sh

# Copy Claude Code hooks
mkdir -p /home/ubuntu/scripts/hooks
cp /home/ubuntu/konoha/scripts/hooks/* /home/ubuntu/scripts/hooks/
```

## Systemd Units

```bash
# Copy all units
sudo cp /home/ubuntu/konoha/systemd/*.service /etc/systemd/system/
sudo cp /home/ubuntu/konoha/systemd/*.timer /etc/systemd/system/

# Reload and enable core services
sudo systemctl daemon-reload
sudo systemctl enable --now akamaru.service
sudo systemctl enable --now telegram-bot.service
sudo systemctl enable --now naruto-session-cleanup.timer

# Enable agent services as needed
sudo systemctl enable --now claude-naruto.service
sudo systemctl enable --now claude-sasuke.service
# ... add other agents as required
```

## Konoha Bus

```bash
cd /home/ubuntu/konoha
bun install
bun run start
```

The bus runs on `http://127.0.0.1:3200`. KONOHA_TOKEN is generated on first start and printed to stdout — copy it into `.agent-env`.

## Agent Sessions

Each agent runs in a dedicated tmux session:

```bash
tmux new-session -d -s naruto
tmux send-keys -t naruto "cd /home/ubuntu && claude" Enter
```

Watchdog services (`claude-watchdog-*.service`) auto-deliver Telegram and Konoha messages to idle agent sessions. Start them after the agent session is up:

```bash
sudo systemctl enable --now claude-watchdog-naruto.service
sudo systemctl enable --now claude-watchdog-sasuke.service
```

## Verify

```bash
# Bus health
curl http://127.0.0.1:3200/agents

# Akamaru watchdog status
sudo systemctl status akamaru.service

# Agent watchdog logs
tail -f /tmp/watchdog-naruto.log
```
