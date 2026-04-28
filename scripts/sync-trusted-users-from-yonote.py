#!/usr/bin/env python3
"""Sync /opt/shared/.trusted-users.json from the Yonote staff directory.

Yonote stores staff usernames, while Telegram routing needs numeric user IDs.
This script fetches the staff document, resolves @usernames through the shared
Telethon session, backs up the current trusted-users file, and writes an atomic
replacement while preserving existing non-staff trusted users.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import tempfile
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from telethon import TelegramClient

DEFAULT_TRUSTED_USERS_PATH = Path("/opt/shared/.trusted-users.json")
DEFAULT_BACKUP_DIR = Path("/opt/shared/trusted-users-backups")
DEFAULT_CREDENTIALS_PATH = Path("/opt/shared/.shared-credentials")
DEFAULT_TELEGRAM_SESSION = "/opt/shared/telegram_session"
DEFAULT_YONOTE_DOC_ID = "6fq2qxMCNK"
DEFAULT_OWNER = {
    "name": "Егор Апрельский",
    "telegram_id": 93791246,
    "username": "yegor_aprelsky",
    "level": 1,
}
# Yonote currently has an outdated username for Alexander; keep the known alias.
USERNAME_ALIASES = {
    "Александр Макаров": ["Ctrain2042"],
}
SECTION_HEADERS = {
    "Управление организацией",
    "Финансовый отдел",
    "Проектный отдел",
    "Технический отдел",
}
SKIP_LINES = {"Список сотрудников coMind", "ФИО", "Позиция", "Телеграм", "Телефон", "Email"}


@dataclass
class StaffPerson:
    name: str
    position: str
    username: str | None
    phone: str | None
    email: str | None
    section: str


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(errors="replace").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def env_value(creds: dict[str, str], *names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name) or creds.get(name)
        if value:
            return value
    return default


@contextmanager
def telethon_session_path(session: str, *, copy_session: bool):
    """Yield a Telethon session path; optionally use a temp copy to avoid live SQLite locks."""
    if not copy_session:
        yield session
        return

    source = Path(session)
    source_db = source if source.suffix == ".session" else Path(f"{session}.session")
    if not source_db.exists():
        yield session
        return

    fd, tmp_name = tempfile.mkstemp(prefix="telegram_session.", suffix=".session")
    os.close(fd)
    tmp_db = Path(tmp_name)
    shutil.copy2(source_db, tmp_db)
    os.chmod(tmp_db, 0o600)
    try:
        yield str(tmp_db.with_suffix(""))
    finally:
        for candidate in [tmp_db, Path(f"{tmp_db}-journal"), Path(f"{tmp_db}-wal"), Path(f"{tmp_db}-shm")]:
            try:
                candidate.unlink()
            except FileNotFoundError:
                pass


def yonote_request(creds: dict[str, str], method: str, body: dict[str, Any]) -> dict[str, Any]:
    base = env_value(creds, "YONOTE_BASE_URL", default="https://comindspace.yonote.ru").rstrip("/")
    token = env_value(creds, "YONOTE_API_KEY")
    if not token:
        raise RuntimeError("YONOTE_API_KEY is not set")
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/api/{method}",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_staff(text: str) -> list[StaffPerson]:
    lines = [line.strip() for line in text.splitlines()]
    staff: list[StaffPerson] = []
    section = ""
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line:
            i += 1
            continue
        if line in SECTION_HEADERS:
            section = line
            i += 1
            continue
        if line in SKIP_LINES or line.startswith("Всего сотрудников"):
            i += 1
            continue
        if i + 2 >= len(lines):
            i += 1
            continue

        name = line
        position = lines[i + 1]
        username_line = lines[i + 2]
        if not (username_line.startswith("@") or username_line in {"—", "-", ""}):
            i += 1
            continue

        username = username_line[1:] if username_line.startswith("@") else None
        phone = None
        email = None
        j = i + 3
        if j < len(lines) and "@" not in lines[j] and lines[j] not in SECTION_HEADERS and lines[j] not in SKIP_LINES:
            phone = None if lines[j] in {"—", "-", ""} else lines[j]
            j += 1
        if j < len(lines) and "@" in lines[j]:
            email = lines[j]
            j += 1

        staff.append(StaffPerson(name, position, username, phone, email, section))
        i = j
    return staff


async def resolve_staff(
    staff: list[StaffPerson],
    creds: dict[str, str],
    session: str,
    *,
    copy_session: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    api_id_raw = env_value(creds, "TG_API_ID", "TELEGRAM_API_ID")
    api_hash = env_value(creds, "TG_API_HASH", "TELEGRAM_API_HASH")
    if not api_id_raw or not api_hash:
        raise RuntimeError("TG_API_ID/TG_API_HASH or TELEGRAM_API_ID/TELEGRAM_API_HASH are not set")

    resolved: list[dict[str, Any]] = []
    unresolved: list[dict[str, str]] = []
    with telethon_session_path(session, copy_session=copy_session) as usable_session:
        client = TelegramClient(usable_session, int(api_id_raw), api_hash)
        await client.connect()
        try:
            for person in staff:
                if not person.username:
                    unresolved.append({"name": person.name, "reason": "missing_username"})
                    continue
                candidates = [person.username, *USERNAME_ALIASES.get(person.name, [])]
                entity = None
                used_username = person.username
                last_error = "not_found"
                for candidate in candidates:
                    try:
                        entity = await client.get_entity(candidate)
                        used_username = candidate
                        break
                    except Exception as exc:  # noqa: BLE001 - report and keep resolving others.
                        last_error = f"{type(exc).__name__}: {str(exc)[:120]}"
                if entity is None:
                    unresolved.append({"name": person.name, "username": person.username, "reason": last_error})
                    continue
                resolved.append({
                    "name": person.name,
                    "telegram_id": int(entity.id),
                    "username": used_username,
                    "phone": person.phone,
                    "email": person.email,
                    "position": person.position,
                    "relation": person.section,
                    "level": 2,
                })
        finally:
            await client.disconnect()
    return resolved, unresolved


def load_trusted(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def merge_trusted(current: dict[str, Any], resolved: list[dict[str, Any]], *, preserve_existing: bool) -> dict[str, Any]:
    owner = current.get("owner") or DEFAULT_OWNER
    owner_id = int(owner.get("telegram_id") or 0)
    by_id: dict[int, dict[str, Any]] = {}
    if preserve_existing:
        for person in current.get("trusted", []):
            telegram_id = person.get("telegram_id")
            if telegram_id:
                by_id[int(telegram_id)] = {**person, "telegram_id": int(telegram_id), "level": int(person.get("level") or 2)}
    for person in resolved:
        telegram_id = int(person["telegram_id"])
        if telegram_id == owner_id:
            continue
        by_id[telegram_id] = {**person, "telegram_id": telegram_id, "level": int(person.get("level") or 2)}
    return {
        **current,
        "owner": owner,
        "trusted": sorted(by_id.values(), key=lambda item: (item.get("name") or "").lower()),
        "whitelisted_groups": current.get("whitelisted_groups", []),
    }


def write_trusted(path: Path, backup_dir: Path, data: dict[str, Any]) -> None:
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        shutil.copy2(path, backup_dir / f"trusted-users.before-yonote-sync.{stamp}.json")
    fd, tmp = tempfile.mkstemp(prefix=".trusted-users.", suffix=".tmp", dir=str(path.parent))
    with os.fdopen(fd, "w") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--doc-id", default=DEFAULT_YONOTE_DOC_ID)
    parser.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS_PATH)
    parser.add_argument("--trusted-users", type=Path, default=DEFAULT_TRUSTED_USERS_PATH)
    parser.add_argument("--backup-dir", type=Path, default=DEFAULT_BACKUP_DIR)
    parser.add_argument("--session", default=DEFAULT_TELEGRAM_SESSION)
    parser.add_argument("--live-session", action="store_true", help="Use the live Telethon SQLite session directly")
    parser.add_argument("--no-preserve-existing", action="store_true", help="Drop trusted users absent from Yonote")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    creds = load_env_file(args.credentials)
    doc = yonote_request(creds, "documents.info", {"id": args.doc_id})
    text = doc["data"]["text"]
    staff = parse_staff(text)
    resolved, unresolved = await resolve_staff(staff, creds, args.session, copy_session=not args.live_session)
    current = load_trusted(args.trusted_users)
    updated = merge_trusted(current, resolved, preserve_existing=not args.no_preserve_existing)

    if not args.dry_run:
        write_trusted(args.trusted_users, args.backup_dir, updated)

    print(json.dumps({
        "dry_run": args.dry_run,
        "yonote_staff_count": len(staff),
        "resolved_count": len(resolved),
        "trusted_count": len(updated.get("trusted", [])),
        "resolved": [{"name": p["name"], "telegram_id": p["telegram_id"], "username": p.get("username")} for p in resolved],
        "unresolved": unresolved,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
