---
name: Konoha agent bus
description: Multi-agent communication bus built on Redis streams with HTTP API and MCP server
type: project
---

Konoha is the internal agent communication bus at ~/konoha (github.com/eaprelsky/konoha, public, MIT).

**Why:** Yegor wants to build an AI-Native system ("Konoha" — a village of agents). Naruto and Sasuke need inter-agent communication, and Yegor's local Claude needs remote access too.

**How to apply:**
- Redis streams for message routing (per-agent queues, broadcast, role-based, topic channels)
- HTTP API on port 3200 (Bun + Hono, bearer auth with KONOHA_TOKEN)
- MCP server for Claude Code integration (tools: konoha_register, konoha_send, konoha_read, konoha_agents, konoha_channels, konoha_heartbeat, konoha_history)
- Agent registry with heartbeat-based presence
- IMPORTANT: must set no_proxy=127.0.0.1 when accessing locally, otherwise requests go through Privoxy

**Status (2026-03-26):** Security patch deployed — per-agent tokens, admin-only registration, one-time invite tokens, inbox isolation. Registered agents: naruto, sasuke, mirai. Mirai token: cfd606b5-bc5f-431b-8db5-542b63fdc146.

**Agent Mirai (sales-monitor):**
- Script: `/home/ubuntu/scripts/bitrix-poller.py` (digest / monitor / pings modes)
- Data: `/opt/shared/mirai/snapshots/` (JSON snapshots for diff computation)
- Cron: digest 9:00, pings 9:30, monitoring 9/11/13/15/17/19
- Bitrix24 per-stage UF fields for next-touch dates mapped in script
- Pending: Sasha (CEO) chat_id — waiting for Sasuke to provide
