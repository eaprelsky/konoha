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
timeout 90 /home/ubuntu/.npm-global/bin/codex exec --model gpt-5.4 \
  -c model_reasoning_effort="medium" \
  --dangerously-bypass-approvals-and-sandbox \
  -C /tmp --skip-git-repo-check --ephemeral "Reply exactly: codex-vpn-ok"
```

The Codex fallback may be enabled only after the smoke returns the exact expected text.
`gpt-5.5` currently requires a newer Codex CLI than `/home/ubuntu/.npm-global/bin/codex` v0.122.0, so use `gpt-5.4` for proxy smoke until the CLI is upgraded.

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

## Last Investigation (2026-04-29)

All three upstreams confirmed dead after exhaustive testing:

| Upstream | Type | Server | Error |
|----------|------|--------|-------|
| `breakfast` | VLESS+Reality | img.steadytor.cc:443 | Reality verification failed — server key rotated or server offline |
| `aeza` | VLESS+Reality | yandex...green-habits.business:8443 | Empty TCP/TLS responses |
| `vanya-ss` | Shadowsocks | 192.36.39.103:443 | Connection timeout (TCP reachable but SS handshake fails) |

**What was attempted:**
- Tested each upstream individually with isolated sing-box instances
- Tried Reality without `flow` field (correct config) — still fails
- Searched system-wide for backup configs, subscription URLs, stored credentials — none found
- Tested free public proxy lists (ebrasha/free-v2ray-public-list, pourih/pfs-servers-list) — all servers dead or configs garbled
- Attempted Cloudflare WARP registration — blocked (HTTP 403, error 1010) from this region
- OpenRouter accessible directly but Codex CLI hardcodes chatgpt.com/OpenAI endpoints

**Actionable providers reachable from this server (no proxy needed):**
- `api.deepseek.com` — used by primary Claude runtime
- `api.z.ai` (GLM) — configured as additional fallback
- `openrouter.ai` — accessible, supports OpenAI models but Codex can't use it directly
- `api.mistral.ai`, `api.together.xyz`

## Restored State (2026-04-29)

A corporate VLESS+Reality upstream was installed as `corporate-vless` in `/etc/sing-box/config.json`; the old broken upstreams were removed from the active `urltest` set. The previous config is backed up at `/etc/sing-box/config.json.bak-1777456087`.

Verification results:
- `sudo sing-box check -D /var/lib/sing-box -C /etc/sing-box` passed.
- `sing-box` and `privoxy` restarted and are active.
- `curl` through `privoxy` and SOCKS reaches `https://chatgpt.com/` and receives HTTP 403 from the remote endpoint instead of timeout/TLS/proxy errors.
- `scripts/healthcheck-system.py` reports `codex_proxy.chatgpt: OK`.
- Codex CLI smoke with `gpt-5.4` returned `codex-vpn-ok`.

Remaining caveat: `gpt-5.5` smoke fails with a Codex CLI version error, not a VPN/proxy error. Upgrade Codex CLI before enabling a `gpt-5.5` Codex runtime profile.
