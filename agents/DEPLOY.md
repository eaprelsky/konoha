# Konoha Agent Infrastructure — Deployment Guide

Deploy a full two-agent Claude Code setup (Naruto + Sasuke) that communicates via Telegram on a fresh Ubuntu server.

## What This Deploys

```
                    ┌──────────────────────────────────┐
                    │          Your Server              │
                    │                                   │
  Telegram Bot ────►│  telegram-bot-service (Grammy)   │
  (bot channel)     │          ↓ Redis                  │
                    │  Naruto (Claude Agent #1)         │◄── You (via bot)
                    │                                   │
  Telegram User ───►│  bus.py (Telethon)               │
  (user account)    │          ↓ Redis                  │
                    │  Sasuke (Claude Agent #2)         │
                    │                                   │
                    │  Konoha Bus (HTTP :3200)          │◄── inter-agent
                    └──────────────────────────────────┘
```

**Naruto** handles bot messages (personal DMs, bot mentions).
**Sasuke** handles user account messages (groups, channels where bot isn't a member).

---

## Prerequisites

- Ubuntu 22.04+ server (any cloud provider)
- At least 2GB RAM, 20GB disk
- A Telegram account (for Telethon user session — needs phone OTP once)
- A Telegram bot (create via @BotFather)
- Anthropic API key

---

## Step 1: Initial Server Setup

Run the automated setup script:

```bash
git clone https://github.com/eaprelsky/konoha.git
cd konoha
bash agents/setup/setup-agent.sh
```

This installs: Node.js 22, Bun, Python 3, Redis, Claude Code, and all dependencies.

---

## Step 2: Configure Environment

```bash
cp agents/.agent-env.template ~/.agent-env
nano ~/.agent-env
```

Fill in all required values (see [Environment Variables](#environment-variables) below).

```bash
source ~/.agent-env
```

---

## Step 3: Telegram Bot Token

The bot reads from the bot channel and gives Naruto a reliable, always-on inbox.

1. Create a bot via @BotFather → `/newbot`
2. Copy the token → set `TELEGRAM_BOT_TOKEN` in `~/.agent-env`
3. Also add token to `~/.claude/channels/telegram/.env`:
   ```
   TELEGRAM_BOT_TOKEN=your_token_here
   ```

---

## Step 4: Telethon User Session (one-time)

Sasuke reads via a real Telegram user account. First run requires phone OTP.

```bash
cd agents/telethon-mcp
pip3 install telethon redis aiofiles
python3 bus.py
# Enter your phone number when prompted
# Enter the OTP code sent to your Telegram
```

Session is saved to `/opt/shared/telegram_session.session`. Future restarts are automatic.

**Required**: create `/opt/shared/` directory:
```bash
sudo mkdir -p /opt/shared/attachments
sudo chown -R $USER:$USER /opt/shared
```

---

## Step 5: Trust Configuration

Create `/opt/shared/.trusted-users.json`:

```json
{
  "owner": {
    "name": "Your Name",
    "telegram_id": YOUR_TELEGRAM_USER_ID,
    "username": "your_username",
    "level": 1
  },
  "trusted": [],
  "whitelisted_groups": []
}
```

Get your Telegram ID from @userinfobot.

---

## Step 6: Install and Start Services

```bash
# Copy systemd services
sudo cp agents/systemd/claude-naruto.service /etc/systemd/system/
sudo cp agents/systemd/claude-sasuke.service /etc/systemd/system/
sudo cp agents/systemd/claude-telegram.service /etc/systemd/system/

# Copy scripts to ~/scripts
mkdir -p ~/scripts
cp agents/scripts/* ~/scripts/
cp -r agents/scripts/hooks ~/scripts/
chmod +x ~/scripts/*.sh

# Copy agent utilities
cp agents/tg-send.py ~/
cp agents/tg-send-user.py ~/
cp agents/CLAUDE.md ~/

# Install Konoha bus
bun install
sudo systemctl daemon-reload
sudo systemctl enable --now redis-server konoha claude-telegram claude-naruto claude-sasuke
```

---

## Step 7: Configure MCP for Claude Code

The Konoha MCP and Telethon channel MCP must be registered in Claude Code settings.

Edit `~/.claude/settings.json` — add to `mcpServers`:

```json
{
  "mcpServers": {
    "konoha": {
      "command": "bun",
      "args": ["run", "--cwd", "/home/ubuntu/konoha", "src/mcp.ts"],
      "env": {
        "KONOHA_TOKEN": "${KONOHA_TOKEN}",
        "KONOHA_URL": "http://127.0.0.1:3200"
      }
    }
  }
}
```

For Sasuke, also add `telethon-channel` MCP (see `telethon-mcp/` README).

---

## Environment Variables

### Required

| Variable | Description | Where to set |
|----------|-------------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude Code | `~/.agent-env` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | `~/.agent-env` + `~/.claude/channels/telegram/.env` |
| `TELEGRAM_OWNER_ID` | Your Telegram user ID (integer) | `~/.agent-env` |
| `KONOHA_TOKEN` | Secret auth token for Konoha bus | `~/.agent-env` |
| `KONOHA_AGENT_ID` | This agent's ID: `naruto` or `sasuke` | `~/.agent-env` or systemd |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `KONOHA_PORT` | `3200` | Konoha HTTP API port |
| `KONOHA_URL` | `http://127.0.0.1:3200` | Konoha base URL |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Claude model to use |
| `https_proxy` / `http_proxy` | unset | HTTP proxy (e.g. Privoxy) |
| `no_proxy` | unset | Comma-separated no-proxy hosts |
| `OWNER_CHAT_ID` | `TELEGRAM_OWNER_ID` | Telegram chat ID for watchdog notifications |

---

## Directory Layout

```
/home/ubuntu/
├── CLAUDE.md                    # Agent instructions (shared)
├── tg-send.py                   # Send via bot (Naruto)
├── tg-send-user.py              # Send via user account (Sasuke)
├── setup-agent.sh               # One-time server setup
├── scripts/
│   ├── restart-naruto.sh        # Restart Naruto agent
│   ├── restart-sasuke.sh        # Restart Sasuke agent
│   ├── restart-safe.sh          # Safe restart with Konoha broadcast
│   ├── watchdog-check.sh        # Heartbeat watchdog (called by cron)
│   ├── check-messages.sh        # Poll Telegram bot message queue
│   ├── check-watchdogs.py       # Check agent statuses
│   ├── claude-naruto-service.sh # Naruto tmux loop
│   ├── claude-sasuke-service.sh # Sasuke tmux loop
│   └── hooks/                   # Claude Code hooks
├── konoha/                      # Konoha bus source
└── telethon-mcp/                # Telethon bridge
    ├── bus.py                   # Telethon ↔ Redis bridge
    ├── channel-server.ts        # Channel MCP server
    └── mcp_server.py            # MCP server entry point

/opt/shared/
├── attachments/                 # Shared file storage (Telegram downloads)
├── .trusted-users.json          # Telegram trust list (not in repo)
└── telegram_session.session     # Telethon session (not in repo)

~/.agent-env                     # Secrets (not in repo, use .agent-env.template)
~/.claude/channels/telegram/.env # Bot token for telegram-bot-service
```

---

## Redis Streams Reference

| Stream | Direction | Used by |
|--------|-----------|---------|
| `telegram:bot:incoming` | Telegram bot → Naruto | telegram-bot-service writes, Naruto reads |
| `telegram:bot:outgoing` | Naruto → Telegram bot | Naruto writes (tg-send.py), bot.ts sends |
| `telegram:incoming` | Telethon → Sasuke | bus.py writes, Sasuke reads |
| `telegram:outgoing` | Sasuke → Telethon | Sasuke writes (tg-send-user.py), bus.py sends |
| `konoha:agent:{id}` | Inter-agent | Konoha bus manages |

---

## Troubleshooting

**Telethon "database is locked":**
```bash
rm /opt/shared/telegram_session.session-journal
```

**Konoha not accessible:**
```bash
curl -H "Authorization: Bearer $KONOHA_TOKEN" http://127.0.0.1:3200/agents
```

**Bot not responding:**
```bash
tail -f /tmp/telegram-bot-service.log
```

**Photo uploads fail (Grammy proxy bug):**
Re-apply patch to `node_modules/grammy/out/shim.node.js` — replace `node-fetch` with `globalThis.fetch`.
See `agents/scripts/patch-telegram-plugin.sh`.

**Agent heartbeat stale:**
```bash
source ~/.agent-env
curl -s -X POST -H "Authorization: Bearer $KONOHA_TOKEN" $KONOHA_URL/agents/naruto/heartbeat
```

---

## Optional: External Endpoint (nginx + SSL)

Expose the Konoha bus externally so remote agents (on other servers) can connect.

**Prerequisites:** a domain pointing to your server, port 8080 open in firewall.

**Note:** Port 80 may be occupied (e.g. by Mailcow/Docker). Use a non-standard port like 8080 for HTTPS.

### 1. Install nginx and certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

### 2. Get SSL certificate

```bash
sudo certbot certonly --standalone -d YOUR_DOMAIN --email YOUR_EMAIL --agree-tos
# certbot will bind to port 80 — stop nginx first if needed
```

### 3. Create nginx config

```bash
sudo nano /etc/nginx/sites-available/konoha
```

```nginx
server {
    listen 8080 ssl;
    server_name YOUR_DOMAIN;

    ssl_certificate /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem;

    location /konoha/ {
        proxy_pass http://127.0.0.1:3200/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/konoha /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 4. Update KONOHA_URL in .agent-env

```bash
# Remote agents connect to:
KONOHA_URL=https://YOUR_DOMAIN:8080/konoha
```

### 5. Certbot auto-renewal

```bash
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer
# Verify:
sudo certbot renew --dry-run
```

---

## Security Notes

- Never commit `~/.agent-env`, `.trusted-users.json`, or `.shared-credentials` to git
- `KONOHA_TOKEN` must be the same across all agents on the same bus
- Only users in `.trusted-users.json` at level 1 (owner) can execute commands
- Telethon session grants full account access — store securely
