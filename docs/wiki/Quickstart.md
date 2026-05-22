# Quickstart

This page gets a local Konoha development instance running with safe placeholder
credentials.

## Requirements

- Bun
- Redis on `localhost:6379`
- PostgreSQL when shadow persistence is enabled
- A local API token value for development
- An LLM API key when testing live assistant paths

## Install

```bash
bun install
cd frontend
bun install
```

## Run The Backend

```bash
KONOHA_TOKEN=<dev-token> ANTHROPIC_API_KEY=<placeholder-or-real-dev-key> KONOHA_PORT=3200 bun run start
```

The backend exposes the API, Action Spine routes, Workflow Engine routes, MCP
surface, and built UI.

## Build The UI

```bash
cd frontend
bun run build
```

The backend serves the built operator workspace from `/ui`.

## Development UI

```bash
cd frontend
bun run dev
```

Use the development server when working on frontend components. Backend API
requests should target the local Konoha service.

## First Local Checks

```bash
scripts/preflight-portable.sh
PATH=/home/ubuntu/.bun/bin:$PATH bun run scripts/action-surface-report.ts --check
python3 scripts/check-route-auth-policy.py
```

For a production release, use the release gates in
[Operator Handbook](Operator-Handbook) and the repository runbooks. Do not use
production tokens or production connector credentials for a local quickstart.
