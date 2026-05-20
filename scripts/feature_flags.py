"""Shared Konoha feature flag contract for healthcheck and profile tooling."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from service_profiles import resolve_service_profile_from_env


FEATURE_FLAGS_PATH = Path(__file__).resolve().parents[1] / "docs" / "feature-flags.json"
FEATURE_FLAGS_OVERRIDE_PATH = Path("/opt/shared/konoha-feature-flags.json")


@dataclass(frozen=True)
class FeatureFlagState:
    id: str
    enabled: bool
    description: str
    enabled_by: str = ""
    reason: str = ""


def load_feature_flags(path: Path = FEATURE_FLAGS_PATH) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        raw = json.load(f)
    if raw.get("schema_version") != 1:
        raise ValueError(f"Unsupported feature flag schema_version={raw.get('schema_version')}")
    flags = raw.get("flags")
    if not isinstance(flags, dict) or not flags:
        raise ValueError("feature flag catalog must define flags")
    return raw


def _csv(value: str | None) -> set[str]:
    if not value:
        return set()
    return {item.strip() for item in value.split(",") if item.strip()}


def _apply_override_file(states: dict[str, FeatureFlagState], path: Path) -> None:
    if not path.exists():
        return
    raw = json.loads(path.read_text(encoding="utf-8"))
    for flag_id in raw.get("enabled_features") or []:
        state = states.get(str(flag_id))
        if not state:
            continue
        states[state.id] = FeatureFlagState(
            id=state.id,
            enabled=True,
            description=state.description,
            enabled_by=f"file:{path}",
            reason="enabled_features override",
        )
    for flag_id, override in (raw.get("features") or {}).items():
        state = states.get(str(flag_id))
        if not state:
            continue
        states[state.id] = FeatureFlagState(
            id=state.id,
            enabled=override.get("enabled") is True,
            description=state.description,
            enabled_by=str(override.get("enabled_by") or f"file:{path}"),
            reason=str(override.get("reason") or "feature override file"),
        )


def resolve_feature_flags(environ: dict[str, str] | None = None, path: Path = FEATURE_FLAGS_PATH) -> tuple[str, list[FeatureFlagState]]:
    env = environ or os.environ
    catalog = load_feature_flags(path)
    profile_env = dict(env)
    if profile_env.get("KONOHA_FEATURE_PROFILE"):
        profile_env["KONOHA_SERVICE_PROFILE"] = str(profile_env["KONOHA_FEATURE_PROFILE"])
    profile = resolve_service_profile_from_env(profile_env)
    profile_features = set(profile.enabled_features)

    states: dict[str, FeatureFlagState] = {}
    for flag_id, definition in catalog["flags"].items():
        enabled = bool(definition.get("default_enabled")) or flag_id in profile_features
        states[flag_id] = FeatureFlagState(
            id=flag_id,
            enabled=enabled,
            description=str(definition.get("description") or ""),
            enabled_by=f"service-profile:{profile.id}" if enabled and flag_id in profile_features else ("catalog-default" if enabled else ""),
            reason="enabled by selected service profile" if enabled and flag_id in profile_features else ("enabled by catalog default" if enabled else ""),
        )

    override_path = Path(env.get("KONOHA_FEATURE_FLAGS_FILE") or FEATURE_FLAGS_OVERRIDE_PATH)
    _apply_override_file(states, override_path)

    for flag_id in _csv(env.get("KONOHA_ENABLED_FEATURES")):
        state = states.get(flag_id)
        if not state:
            continue
        states[flag_id] = FeatureFlagState(
            id=state.id,
            enabled=True,
            description=state.description,
            enabled_by=f"env:{env.get('USER')}" if env.get("USER") else "env:KONOHA_ENABLED_FEATURES",
            reason=env.get("KONOHA_FEATURE_ENABLE_REASON") or "enabled via KONOHA_ENABLED_FEATURES",
        )

    for flag_id in _csv(env.get("KONOHA_DISABLED_FEATURES")):
        state = states.get(flag_id)
        if not state:
            continue
        states[flag_id] = FeatureFlagState(id=state.id, enabled=False, description=state.description)

    return profile.id, sorted(states.values(), key=lambda item: item.id)
