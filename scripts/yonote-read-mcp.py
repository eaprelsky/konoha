#!/usr/bin/env python3
"""Read-only Yonote MCP surface for bounded Sasuke context lookups."""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations


MAX_LIMIT = 10


def env_required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def base_url() -> str:
    return os.getenv("YONOTE_BASE_URL", "https://app.yonote.ru").rstrip("/")


def headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {env_required('YONOTE_API_KEY')}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def clamp_limit(limit: int | None, default: int = 3) -> int:
    if limit is None:
        return default
    return max(1, min(int(limit), MAX_LIMIT))


async def yonote_rpc(method: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{base_url()}/api/{method}"
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(url, headers=headers(), json=body or {})
    try:
        data = response.json()
    except Exception:
        data = {"raw": response.text}
    return {
        "ok": bool(data.get("ok", response.is_success)),
        "status": response.status_code,
        "data": data,
    }


def as_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


mcp = FastMCP("yonote-read")


@mcp.tool(annotations=ToolAnnotations(title="Yonote Auth Info", openWorldHint=True, readOnlyHint=True))
async def yonote_read_auth_info() -> str:
    """Read auth details for the configured Yonote API key."""
    return as_json(await yonote_rpc("auth.info"))


@mcp.tool(annotations=ToolAnnotations(title="Yonote Index Document", openWorldHint=True, readOnlyHint=True))
async def yonote_read_index_document() -> str:
    """Read the configured index document by YONOTE_INDEX_DOCUMENT_ID."""
    doc_id = os.getenv("YONOTE_INDEX_DOCUMENT_ID")
    if not doc_id:
        return as_json({"ok": False, "error": {"message": "YONOTE_INDEX_DOCUMENT_ID is not set"}})
    return as_json(await yonote_rpc("documents.info", {"id": doc_id}))


@mcp.tool(annotations=ToolAnnotations(title="Yonote Team Document", openWorldHint=True, readOnlyHint=True))
async def yonote_read_team_document() -> str:
    """Read the configured team document by YONOTE_TEAM_DOCUMENT_ID."""
    doc_id = os.getenv("YONOTE_TEAM_DOCUMENT_ID")
    if not doc_id:
        return as_json({"ok": False, "error": {"message": "YONOTE_TEAM_DOCUMENT_ID is not set"}})
    return as_json(await yonote_rpc("documents.info", {"id": doc_id}))


@mcp.tool(annotations=ToolAnnotations(title="Yonote Document Info", openWorldHint=True, readOnlyHint=True))
async def yonote_read_document(id: str = "", share_id: str = "") -> str:
    """Read a document by id or share id."""
    body: dict[str, Any] = {}
    if id:
        body["id"] = id
    if share_id:
        body["shareId"] = share_id
    return as_json(await yonote_rpc("documents.info", body))


@mcp.tool(annotations=ToolAnnotations(title="Yonote Document Search", openWorldHint=True, readOnlyHint=True))
async def yonote_read_search(query: str, limit: int | None = None, collection_id: str = "") -> str:
    """Search Yonote documents with a bounded result limit."""
    body: dict[str, Any] = {"query": query, "limit": clamp_limit(limit)}
    if collection_id:
        body["collectionId"] = collection_id
    return as_json(await yonote_rpc("documents.search", body))


@mcp.tool(annotations=ToolAnnotations(title="Yonote Title Search", openWorldHint=True, readOnlyHint=True))
async def yonote_read_search_titles(query: str, limit: int | None = None) -> str:
    """Search Yonote document titles with a bounded result limit."""
    return as_json(await yonote_rpc("documents.search_titles", {"query": query, "limit": clamp_limit(limit)}))


@mcp.tool(annotations=ToolAnnotations(title="Yonote Collections List", openWorldHint=True, readOnlyHint=True))
async def yonote_read_collections(limit: int | None = None) -> str:
    """List Yonote collections with a bounded result limit."""
    return as_json(await yonote_rpc("collections.list", {"limit": clamp_limit(limit)}))


def main() -> None:
    try:
        headers()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    mcp.run()


if __name__ == "__main__":
    main()
