# Itachi — Local WSL Agent (Claude Agent, external)

## Role
Itachi is an agent on the owner's local machine (WSL / Windows). Connects to the Konoha bus
via external URL. Used for local tasks: working with files on Windows,
accessing local services, integrating with the local development environment.

## Model
Depends on local Claude Code installation (typically claude-sonnet-4-6 or claude-opus-4-6)

## Entry points
- Konoha SSE `https://agent.eaprelsky.ru/messages/itachi/stream` — messages from other agents
- Delivered to tmux session `itachi` (if running) or printed to terminal

## Infrastructure
- Runs on local machine (WSL), not on the server
- **No systemd** — started manually or via `nohup`
- Watchdog: `/home/ubuntu/scripts/watchdog-itachi.py` (to run on WSL machine)
- Requires: `KONOHA_URL=https://agent.eaprelsky.ru`, `KONOHA_TOKEN=<token from .agent-env>`

## Starting on WSL
```bash
export KONOHA_URL=https://agent.eaprelsky.ru
export KONOHA_TOKEN=<token>
python3 watchdog-itachi.py &
claude --dangerously-skip-permissions
```

## Responsibilities
- Local tasks on the owner's machine
- Access to Windows filesystem via WSL
- Running local scripts and tools
- Interacting with the team via the Konoha bus

## Status
Optional agent — active only when the owner starts it locally.
