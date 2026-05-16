# MCP Resource Inventory

Snapshot for issue #785 on 2026-05-16, before deploying the optional-pack gate.

## Live Optional MCP Processes Before #785

Command:

```bash
ps -eo pid=,rss=,args= | awk 'BEGIN{IGNORECASE=1} /mcp-google-sheets|google-docs-mcp|office-word-mcp-server|word_mcp_server|excel-mcp-server|miro-api-mcp|mcp\\.miro\\.com|server-puppeteer|puppeteer/ && !/awk/ {print}'
```

| Pack | Process count | RSS KiB | Notes |
|------|---------------|---------|-------|
| `miro-api` | 2 | 65,392 | `uv --directory .../miro-api-mcp run main.py`, Python worker |
| `excel` | 2 | 76,700 | `uvx excel-mcp-server stdio`, Python worker |
| `word` | 2 | 87,256 | `uvx --from office-word-mcp-server word_mcp_server`, Python worker |
| `puppeteer` | 3 | 148,652 | Existing #778 browser MCP cleanup target still present in stale generated runtime config |
| `google-sheets` | 0 | 0 | Not running in the sampled process table |
| `google-docs` | 0 | 0 | Not running in the sampled process table |
| **Office/Miro/spreadsheet subtotal** | **6** | **229,348** | Target scope for #785 |
| **All optional gated packs subtotal** | **9** | **378,000** | Includes Puppeteer, already covered by #778 |

Live generated configs also showed stale broad shared MCP access in Kiba and
Mirai workdirs. Kiba's generated `.mcp.json` included `excel`, `word`,
`google-docs`, `google-sheets`, `miro`, `miro-api`, and `puppeteer`.

## Expected After #785

Source-level verification command after the #785 change:

```bash
bun -e 'import { buildMcpConfig } from "./src/agent/runtime"; const cfg = await buildMcpConfig([], {}, undefined); console.log(Object.keys(cfg.mcpServers).sort().join(","));'
```

The command logged `skipping optional shared MCP pack` for `puppeteer`,
`google-sheets`, `miro`, `miro-api`, `excel`, `word`, and `google-docs`.
The generated broad shared MCP key set was:

```text
bitrix24,caldav,email,filesystem,gitlab,konoha,memory,mempalace,openrouter-audio,sequential-thinking,telegram,telethon-channel,yandex-tracker,yonote
```

After affected agents restart and their `.mcp.json` files are regenerated:

| Pack set | Expected default process count | Expected default RSS KiB |
|----------|-------------------------------|--------------------------|
| Office/Miro/spreadsheet packs | 0 | 0 |
| Direct browser MCP | 0 | 0 |

The shared catalog can still contain these server definitions for explicit
on-demand sessions. Startup profiles skip them by default and log each skipped
optional pack.
