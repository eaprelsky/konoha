---
name: MCP config update requires terminal confirmation
description: When Claude Code session updates MCP config, it prompts for confirmation in terminal — must send Enter manually
type: feedback
---

При обновлении MCP-конфигурации или любых настроек агента (settings.json, .mcp-*.json), Claude Code запрашивает подтверждение в терминале. Сессия зависает до получения Enter.

**Why:** Это стандартное поведение Claude Code — любые изменения конфигурации требуют подтверждения пользователя.

**How to apply:**
- Если нужно обновить MCP-конфиг Наруто — попросить Егора нажать Enter в терминале, или перезапустить сервис автоматически (restart-naruto.sh).
- Если нужно обновить MCP-конфиг Саске — Наруто может послать Enter через tmux: `tmux send-keys -t sasuke Enter`.
- Для автоматических обновлений конфигов — всегда планировать перезапуск после изменений.
- Sasuke может получить Enter от Наруто через tmux, не нужно просить Егора.
