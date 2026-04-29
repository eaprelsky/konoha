#!/usr/bin/env python3
"""Guard product-facing docs against agent-name/alias semantic regressions."""

from __future__ import annotations

import re
import sys
from pathlib import Path


FORBIDDEN_NAMES = (
    "Naruto",
    "Sasuke",
    "Kakashi",
    "Tsunade",
    "Наруто",
    "Саске",
    "Какаши",
    "Цунаде",
)

PRODUCT_DOCS = (
    "docs/api.md",
    "docs/mcp.md",
    "docs/guides/agents.md",
    "docs/guides/website-copy-workflow.md",
)

ALIAS_CONTEXT = re.compile(r"\b(alias|display_alias|callsign|persona)\b|алиас|позывн", re.IGNORECASE)


def is_allowed_alias_context(line: str) -> bool:
    return bool(ALIAS_CONTEXT.search(line))


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    violations: list[str] = []

    for rel in PRODUCT_DOCS:
        path = repo / rel
        if not path.exists():
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
            if not any(name in line for name in FORBIDDEN_NAMES):
                continue
            if is_allowed_alias_context(line):
                continue
            violations.append(f"{rel}:{lineno}: {line.strip()}")

    if violations:
        print("Agent naming policy violations:")
        for item in violations[:20]:
            print(f"- {item}")
        if len(violations) > 20:
            print(f"- ... {len(violations) - 20} more")
        print("Use canonical corporate name as primary text; mention Naruto-style names only as alias/display_alias.")
        return 1

    print("Agent naming policy OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
