"""Shared Kiba monitor target labels and action guard for issue #772."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
PROFILE_PATH = REPO_ROOT / "docs" / "kiba-monitor-profile.json"


def load_kiba_monitor_profile(path: Path = PROFILE_PATH) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("schema_version") != 1:
        raise ValueError(f"Unsupported Kiba monitor profile schema_version={raw.get('schema_version')}")
    targets = raw.get("targets")
    if not isinstance(targets, list) or not targets:
        raise ValueError("Kiba monitor profile must define targets")
    environments = [str(target.get("environment") or "") for target in targets]
    if len(environments) != len(set(environments)) or any(not item for item in environments):
        raise ValueError("Kiba monitor profile target environments must be unique and non-empty")
    return raw


def known_environments(profile: dict[str, Any] | None = None) -> set[str]:
    raw = profile or load_kiba_monitor_profile()
    return {str(target["environment"]) for target in raw["targets"]}


def target_for_environment(environment: str, profile: dict[str, Any] | None = None) -> dict[str, Any]:
    raw = profile or load_kiba_monitor_profile()
    for target in raw["targets"]:
        if target["environment"] == environment:
            return target
    raise ValueError(f"Unknown Kiba monitor environment: {environment}")


def target_environment_from_env(environ: dict[str, str] | None = None, profile: dict[str, Any] | None = None) -> str:
    env = environ or os.environ
    raw = profile or load_kiba_monitor_profile()
    selected = (env.get("KIBA_MONITOR_ENVIRONMENT") or raw["default_environment"]).strip()
    if selected not in known_environments(raw):
        raise ValueError(f"Unknown Kiba monitor environment: {selected}")
    return selected


def target_url_from_env(environ: dict[str, str] | None = None, profile: dict[str, Any] | None = None) -> str:
    env = environ or os.environ
    raw = profile or load_kiba_monitor_profile()
    environment = target_environment_from_env(env, raw)
    target = target_for_environment(environment, raw)
    url_env = str(target["konoha_url_env"])
    url = (env.get(url_env) or "").strip()
    if not url and url_env == "KONOHA_URL":
        url = "http://127.0.0.1:3200"
    if not url:
        raise ValueError(f"Kiba monitor environment {environment} requires {url_env}")
    return url.rstrip("/")


def parse_kiba_fields(text: str) -> dict[str, str]:
    return {
        key: value.rstrip(",.;")
        for key, value in re.findall(r"([A-Za-z_][A-Za-z0-9_]*)=([^ \n]+)", text)
    }


def alert_environment(text: str) -> str | None:
    return parse_kiba_fields(text).get("env")


def label_kiba_message(text: str, environment: str) -> str:
    if not text.startswith("kiba:alert") and not text.startswith("kiba:healthcheck"):
        return text
    if alert_environment(text):
        return text
    if text == "kiba:healthcheck":
        return f"kiba:healthcheck env={environment}"
    prefix = "kiba:alert "
    if text.startswith(prefix):
        return f"{prefix}env={environment} {text[len(prefix):]}"
    return f"{text} env={environment}"


def action_guard_reason(text: str, environ: dict[str, str] | None = None) -> str | None:
    env = os.environ if environ is None else environ
    alert_env = alert_environment(text)
    if not alert_env:
        return "missing env label; deterministic admin action blocked"
    if alert_env not in known_environments():
        return f"unknown env={alert_env}; deterministic admin action blocked"
    target_env = (env.get("KIBA_ACTION_TARGET_ENV") or "").strip()
    if not target_env:
        return "KIBA_ACTION_TARGET_ENV is unset; deterministic admin action blocked"
    if target_env != alert_env:
        return f"alert env={alert_env} does not match KIBA_ACTION_TARGET_ENV={target_env}; deterministic admin action blocked"
    return None
