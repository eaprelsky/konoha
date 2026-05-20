#!/usr/bin/env python3
"""Bounded SDD dev/test worker pool control.

This is a thin lifecycle/API wrapper: it does not make Guy, Shino, Hinata, or
Ibiki always-on. It records active missions, enforces pool concurrency, sends an
auditable Konoha bus handoff, and calls the existing agent lifecycle endpoints.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = REPO_ROOT / "docs" / "sdd-worker-pool.json"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("schema_version") != 1:
        raise ValueError(f"Unsupported sdd worker pool schema_version={raw.get('schema_version')}")
    workers = raw.get("workers")
    if not isinstance(workers, dict) or not workers:
        raise ValueError("sdd worker pool must define workers")
    return raw


def state_path(config: dict[str, Any]) -> Path:
    return Path(os.environ.get("KONOHA_SDD_WORKER_POOL_STATE") or config["state_file"])


def lock_path(config: dict[str, Any]) -> Path:
    return state_path(config).with_suffix(state_path(config).suffix + ".lock")


@contextmanager
def state_lock(config: dict[str, Any]):
    path = lock_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def load_state(config: dict[str, Any]) -> dict[str, Any]:
    path = state_path(config)
    if not path.exists():
        return {"schema_version": 1, "active": [], "history": []}
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(config: dict[str, Any], state: dict[str, Any]) -> None:
    path = state_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def active_entries(state: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    result = []
    for entry in state.get("active") or []:
        expires_at = parse_time(entry["expires_at"])
        if expires_at > now and entry.get("status") == "active":
            result.append(entry)
    return result


def prune_expired(state: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    expired = []
    kept = []
    for entry in state.get("active") or []:
        expires_at = parse_time(entry["expires_at"])
        if expires_at <= now or entry.get("status") != "active":
            expired.append({**entry, "status": "expired", "stopped_at": iso(now)})
        else:
            kept.append(entry)
    if expired:
        state["active"] = kept
        state.setdefault("history", []).extend(expired)
    return expired


def is_specialist(config: dict[str, Any], agent: str) -> bool:
    return agent != "kakashi" and config["workers"][agent]["default_path"] is False


def assert_can_start(config: dict[str, Any], state: dict[str, Any], agent: str, now: datetime) -> None:
    if agent not in config["workers"]:
        raise ValueError(f"Unknown SDD worker: {agent}")
    active = active_entries(state, now)
    if any(entry["agent"] == agent for entry in active):
        raise ValueError(f"SDD worker already active: {agent}")
    if len(active) >= int(config["max_active_workers"]):
        raise ValueError(f"SDD worker pool is full: active={len(active)} max={config['max_active_workers']}")
    specialist_count = sum(1 for entry in active if is_specialist(config, entry["agent"]))
    if is_specialist(config, agent) and specialist_count >= int(config["max_active_specialists"]):
        raise ValueError(
            f"SDD specialist lane is full: active_specialists={specialist_count} max={config['max_active_specialists']}"
        )


def request(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    base_url = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200").rstrip("/")
    token = os.environ.get("KONOHA_TOKEN", "")
    data = json.dumps(body or {}).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{base_url}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def audit_message(action: str, entry: dict[str, Any], reason: str = "") -> str:
    return (
        f"SDD_POOL_{action}: agent={entry['agent']} role={entry['role']} "
        f"mission={entry['mission']} requester={entry['requester']} "
        f"expires_at={entry['expires_at']} reason={reason or entry.get('reason', '')}"
    ).strip()


def start_worker(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config()
    with state_lock(config):
        state = load_state(config)
        now = utcnow()
        prune_expired(state, now)
        assert_can_start(config, state, args.agent, now)

        worker = config["workers"][args.agent]
        ttl = int(args.ttl_sec or config["idle_timeout_sec"])
        entry = {
            "agent": args.agent,
            "role": args.role or worker["role"],
            "mission": args.mission,
            "requester": args.requester,
            "reason": args.reason or "",
            "started_at": iso(now),
            "expires_at": iso(now + timedelta(seconds=ttl)),
            "status": "active",
            "service": worker["service"],
            "mcp_allowlist": worker["mcp_allowlist"],
            "testbench": bool(worker["testbench"]),
        }

        actions = [
            {"method": "POST", "path": f"/agents/{args.agent}/start", "body": {}},
            {
                "method": "POST",
                "path": "/messages",
                "body": {
                    "from": args.requester,
                    "to": args.agent,
                    "type": "task",
                    "text": audit_message("START", entry, args.reason or "bounded on-demand mission"),
                },
            },
        ]
        if not args.dry_run:
            for action in actions:
                request(action["method"], action["path"], action["body"])
            state.setdefault("active", []).append(entry)
            save_state(config, state)
        return {"ok": True, "dry_run": args.dry_run, "entry": entry, "actions": actions}


def stop_worker(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config()
    with state_lock(config):
        state = load_state(config)
        now = utcnow()
        prune_expired(state, now)
        active = state.get("active") or []
        stopped = []
        kept = []
        for entry in active:
            if entry["agent"] == args.agent and (not args.mission or entry["mission"] == args.mission):
                stopped.append({**entry, "status": "stopped", "stopped_at": iso(now), "stop_reason": args.reason or ""})
            else:
                kept.append(entry)
        if not stopped:
            raise ValueError(f"No active SDD worker entry for {args.agent}")

        actions = []
        for entry in stopped:
            actions.append({
                "method": "POST",
                "path": "/messages",
                "body": {
                    "from": args.requester,
                    "to": entry["agent"],
                    "type": "status",
                    "text": audit_message("STOP", entry, args.reason or "mission complete"),
                },
            })
            actions.append({"method": "POST", "path": f"/agents/{entry['agent']}/stop", "body": {}})
        if not args.dry_run:
            for action in actions:
                request(action["method"], action["path"], action["body"])
            state["active"] = kept
            state.setdefault("history", []).extend(stopped)
            save_state(config, state)
        return {"ok": True, "dry_run": args.dry_run, "stopped": stopped, "actions": actions}


def status(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config()
    with state_lock(config):
        state = load_state(config)
        now = utcnow()
        expired = prune_expired(state, now)
        if expired and not args.dry_run:
            save_state(config, state)
        active = active_entries(state, now)
        return {
            "ok": True,
            "max_active_workers": config["max_active_workers"],
            "max_active_specialists": config["max_active_specialists"],
            "idle_timeout_sec": config["idle_timeout_sec"],
            "active": active,
            "expired": expired,
        }


def reap(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config()
    with state_lock(config):
        state = load_state(config)
        now = utcnow()
        expired = prune_expired(state, now)
        actions = []
        for entry in expired:
            actions.append({
                "method": "POST",
                "path": "/messages",
                "body": {
                    "from": "sdd-worker-pool",
                    "to": entry["agent"],
                    "type": "status",
                    "text": audit_message("STOP", entry, "idle TTL expired"),
                },
            })
            actions.append({"method": "POST", "path": f"/agents/{entry['agent']}/stop", "body": {}})
        if not args.dry_run:
            for action in actions:
                request(action["method"], action["path"], action["body"])
            save_state(config, state)
        return {"ok": True, "dry_run": args.dry_run, "expired": expired, "actions": actions}


def rollback(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config()
    with state_lock(config):
        state = load_state(config)
        now = utcnow()
        active = active_entries(state, now)
        stopped = [{**entry, "status": "rollback_stopped", "stopped_at": iso(now), "stop_reason": args.reason} for entry in active]
        actions = []
        for entry in stopped:
            actions.append({
                "method": "POST",
                "path": "/messages",
                "body": {
                    "from": "sdd-worker-pool",
                    "to": entry["agent"],
                    "type": "status",
                    "text": audit_message("STOP", entry, args.reason),
                },
            })
            actions.append({"method": "POST", "path": f"/agents/{entry['agent']}/stop", "body": {}})
        if not args.dry_run:
            for action in actions:
                request(action["method"], action["path"], action["body"])
            state["active"] = []
            state.setdefault("history", []).extend(stopped)
            save_state(config, state)
        return {"ok": True, "dry_run": args.dry_run, "stopped": stopped, "actions": actions}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bounded SDD worker pool control")
    sub = parser.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start")
    start.add_argument("agent")
    start.add_argument("--mission", required=True)
    start.add_argument("--requester", required=True)
    start.add_argument("--role")
    start.add_argument("--reason", default="")
    start.add_argument("--ttl-sec", type=int)
    start.add_argument("--dry-run", action="store_true")
    start.set_defaults(func=start_worker)

    stop = sub.add_parser("stop")
    stop.add_argument("agent")
    stop.add_argument("--mission")
    stop.add_argument("--requester", required=True)
    stop.add_argument("--reason", default="mission complete")
    stop.add_argument("--dry-run", action="store_true")
    stop.set_defaults(func=stop_worker)

    stat = sub.add_parser("status")
    stat.add_argument("--dry-run", action="store_true")
    stat.set_defaults(func=status)

    reap_cmd = sub.add_parser("reap")
    reap_cmd.add_argument("--dry-run", action="store_true")
    reap_cmd.set_defaults(func=reap)

    rollback_cmd = sub.add_parser("rollback")
    rollback_cmd.add_argument("--reason", required=True)
    rollback_cmd.add_argument("--dry-run", action="store_true")
    rollback_cmd.set_defaults(func=rollback)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = args.func(args)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
