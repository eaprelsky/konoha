#!/usr/bin/env python3
"""Static guardrails for high-risk Konoha API route authorization.

This is intentionally simple: it protects the routes that previously drifted
from admin-only to generic authenticated access. Runtime tests cover behavior;
this check catches accidental source-level regressions in preflight/healthcheck.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Rule:
    name: str
    file: str
    snippets: tuple[str, ...]


RULES = [
    Rule(
        "route.auth.autonomy_write_admin",
        "src/routes/audit.ts",
        ('router.put("/config/autonomy", requireAdmin',),
    ),
    Rule(
        "route.auth.branding_write_admin",
        "src/routes/audit.ts",
        ('router.put("/branding", requireAdmin',),
    ),
    Rule(
        "route.auth.completed_setup_admin",
        "src/routes/audit.ts",
        ("resolveAuth", "if (existing.complete)", "Forbidden: setup is already complete"),
    ),
    Rule(
        "route.auth.deploy_settings_write_admin",
        "src/routes/deploy.ts",
        ('app.put("/config/settings", requireAdmin',),
    ),
    Rule(
        "route.auth.deploy_trigger_admin",
        "src/routes/deploy.ts",
        ('app.post("/deploy", requireAdmin',),
    ),
    Rule(
        "route.auth.whitelist_mutations_admin",
        "src/routes/whitelist.ts",
        (
            'router.post("/approve", requireAdmin',
            'router.post("/reject", requireAdmin',
            'router.delete("/user/:telegram_id", requireAdmin',
            'router.delete("/group/:chat_id", requireAdmin',
        ),
    ),
    Rule(
        "route.auth.system_agent_seed_admin",
        "src/routes/admin.ts",
        ('router.post("/admin/seed-system-agents", requireAdmin',),
    ),
    Rule(
        "route.auth.people_mutations_admin",
        "src/routes/people.ts",
        ('router.post("/", requireAdmin', 'router.delete("/:id", requireAdmin'),
    ),
]


def main() -> int:
    failures: list[str] = []
    for rule in RULES:
        path = REPO / rule.file
        if not path.exists():
            failures.append(f"{rule.name}: missing {rule.file}")
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        missing = [snippet for snippet in rule.snippets if snippet not in text]
        if missing:
            failures.append(f"{rule.name}: missing {', '.join(missing)}")

    if failures:
        print("route auth policy failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print(f"route auth policy OK ({len(RULES)} rules)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
