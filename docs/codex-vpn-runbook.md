# Codex VPN/Proxy Runbook

Codex CLI uses the ChatGPT/Codex backend and is blocked from the current direct server egress. Do not route the whole host through a VPN: the server exposes SSH, Konoha API, Telegram services, and mail-related containers.

## Current Safe Design

- Keep the default host route unchanged.
- Use local outbound proxy only for Codex/OpenAI traffic.
- `sing-box` listens on `127.0.0.1:1080`.
- `privoxy` exposes HTTP(S) proxy on `127.0.0.1:8118`.
- `/home/ubuntu/.agent-env` defines `http_proxy` and `https_proxy` for opt-in command environments.

## Verification

```bash
set -a
source /home/ubuntu/.agent-env
set +a

python3 /home/ubuntu/konoha/scripts/healthcheck-system.py
curl -sS --max-time 15 https://ifconfig.co/json
curl -sS -I --max-time 15 https://chatgpt.com/
timeout 60 /home/ubuntu/.npm-global/bin/codex exec --model gpt-5.5 \
  -c model_reasoning_effort="high" \
  --dangerously-bypass-approvals-and-sandbox \
  -C /tmp --skip-git-repo-check --ephemeral "Reply exactly: codex-vpn-ok"
```

The Codex fallback may be enabled only after the smoke returns the exact expected text.

## Known Bad State

On 2026-04-28 all configured sing-box upstreams failed:

- `breakfast`: Reality verification failed.
- `vanya-ss`: connection timeout.
- `aeza`: SOCKS request granted, then empty TCP/TLS response.

Refresh the upstream credentials or add a known-good provider, then restart only the proxy layer:

```bash
sudo sing-box check -D /var/lib/sing-box -C /etc/sing-box
sudo systemctl restart sing-box privoxy
```

Do not restart network interfaces or change the default route during a remote SSH session.
