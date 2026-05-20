"""Shared Konoha service profile contract for healthcheck and autostart."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SERVICE_PROFILES_PATH = Path(__file__).resolve().parents[1] / "docs" / "service-profiles.json"


@dataclass(frozen=True)
class ServiceProfile:
    id: str
    description: str
    enabled_connectors: frozenset[str]
    enabled_optional_monitors: frozenset[str]
    enabled_features: frozenset[str]
    autostart_agents: tuple[str, ...]
    lifecycle_watchdog_agents: tuple[str, ...]
    disabled_lifecycle_agents: frozenset[str]
    infra_dependencies: tuple[str, ...]
    required_services: tuple[str, ...]
    optional_services: tuple[str, ...]


def load_service_profiles(path: Path = SERVICE_PROFILES_PATH) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        raw = json.load(f)
    if raw.get("schema_version") != 1:
        raise ValueError(f"Unsupported service profile schema_version={raw.get('schema_version')}")
    profiles = raw.get("profiles")
    if not isinstance(profiles, dict) or not profiles:
        raise ValueError("service profile catalog must define profiles")
    default_profile = raw.get("default_profile")
    if default_profile not in profiles:
        raise ValueError("service profile catalog default_profile must exist in profiles")
    return raw


def profile_id_from_env(environ: dict[str, str] | None = None, catalog: dict[str, Any] | None = None) -> str:
    env = environ or os.environ
    raw = (env.get("KONOHA_SERVICE_PROFILE") or "").strip()
    if raw:
        return raw
    catalog = catalog or load_service_profiles()
    return str(catalog["default_profile"])


def resolve_service_profile(profile_id: str | None = None, path: Path = SERVICE_PROFILES_PATH) -> ServiceProfile:
    catalog = load_service_profiles(path)
    selected = profile_id or str(catalog["default_profile"])
    raw = catalog["profiles"].get(selected)
    if raw is None:
        raise ValueError(f"Unknown Konoha service profile: {selected}")
    return ServiceProfile(
        id=selected,
        description=str(raw.get("description") or ""),
        enabled_connectors=frozenset(str(item) for item in raw.get("enabled_connectors") or []),
        enabled_optional_monitors=frozenset(str(item) for item in raw.get("enabled_optional_monitors") or []),
        enabled_features=frozenset(str(item) for item in raw.get("enabled_features") or []),
        autostart_agents=tuple(str(item) for item in raw.get("autostart_agents") or []),
        lifecycle_watchdog_agents=tuple(str(item) for item in raw.get("lifecycle_watchdog_agents") or []),
        disabled_lifecycle_agents=frozenset(str(item) for item in raw.get("disabled_lifecycle_agents") or []),
        infra_dependencies=tuple(str(item) for item in raw.get("infra_dependencies") or []),
        required_services=tuple(str(item) for item in raw.get("required_services") or []),
        optional_services=tuple(str(item) for item in raw.get("optional_services") or []),
    )


def resolve_service_profile_from_env(environ: dict[str, str] | None = None, path: Path = SERVICE_PROFILES_PATH) -> ServiceProfile:
    catalog = load_service_profiles(path)
    return resolve_service_profile(profile_id_from_env(environ, catalog), path)
