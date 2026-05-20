"""Shared resource budget contract for Konoha runtime scripts."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


RESOURCE_BUDGETS_PATH = Path(__file__).resolve().parents[1] / "docs" / "resource-budgets.json"
KIB = 1024


def load_resource_budgets(path: Path = RESOURCE_BUDGETS_PATH) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        raw = json.load(f)
    if raw.get("schema_version") != 1:
        raise ValueError(f"Unsupported resource budget schema_version={raw.get('schema_version')}")
    if not raw.get("budget_profiles"):
        raise ValueError("resource budget contract must define budget_profiles")
    if not raw.get("systemd", {}).get("slices"):
        raise ValueError("resource budget contract must define systemd.slices")
    return raw


def systemd_size_to_kib(value: str | None) -> int | None:
    raw = str(value or "").strip()
    if not raw or raw == "infinity":
        return None
    if raw.isdigit():
        return int(raw) // KIB
    match = re.fullmatch(r"(\d+)([KMGTP])", raw, re.IGNORECASE)
    if not match:
        return None
    amount = int(match.group(1))
    power = "KMGTPE".index(match.group(2).upper()) + 1
    return amount * (1024 ** power) // KIB


def systemd_slice_policies(path: Path = RESOURCE_BUDGETS_PATH) -> dict[str, dict[str, Any]]:
    raw = load_resource_budgets(path)
    policies: dict[str, dict[str, Any]] = {}
    for name, policy in raw["systemd"]["slices"].items():
        normalized = dict(policy)
        if "optional_monitors" in normalized:
            normalized["optional_monitors"] = set(normalized["optional_monitors"])
        policies[name] = normalized
    return policies


def systemd_budget_units(path: Path = RESOURCE_BUDGETS_PATH) -> list[str]:
    raw = load_resource_budgets(path)
    return sorted({*raw["systemd"]["slices"].keys(), *raw["systemd"].get("units", {}).keys()})


def transient_scope_policies(path: Path = RESOURCE_BUDGETS_PATH) -> dict[str, dict[str, Any]]:
    raw = load_resource_budgets(path)
    return dict(raw["systemd"].get("transient_scopes", {}))


def profile_dropin_policies(path: Path = RESOURCE_BUDGETS_PATH) -> dict[str, dict[str, Any]]:
    raw = load_resource_budgets(path)
    return dict(raw["systemd"].get("profile_dropins", {}))


def host_capacity_model(path: Path = RESOURCE_BUDGETS_PATH) -> dict[str, Any]:
    raw = load_resource_budgets(path)
    model = raw.get("host_capacity")
    if not isinstance(model, dict):
        raise ValueError("resource budget contract must define host_capacity")
    return model


def host_profile_accounting(path: Path = RESOURCE_BUDGETS_PATH) -> dict[str, dict[str, Any]]:
    model = host_capacity_model(path)
    return dict(model.get("profile_accounting") or {})


def host_service_audit(path: Path = RESOURCE_BUDGETS_PATH) -> dict[str, Any]:
    model = host_capacity_model(path)
    audit = model.get("host_service_audit")
    if not isinstance(audit, dict):
        raise ValueError("resource budget contract must define host_capacity.host_service_audit")
    return audit


def protected_host_service_units(path: Path = RESOURCE_BUDGETS_PATH) -> set[str]:
    audit = host_service_audit(path)
    return {
        unit
        for group in audit.get("protected_services", [])
        for unit in group.get("units", [])
    }


def host_service_disable_candidates(path: Path = RESOURCE_BUDGETS_PATH) -> dict[str, dict[str, Any]]:
    audit = host_service_audit(path)
    return {item["id"]: dict(item) for item in audit.get("disable_candidates", [])}


def expected_memory_max_kib(path: Path = RESOURCE_BUDGETS_PATH) -> dict[str, int]:
    raw = load_resource_budgets(path)
    result: dict[str, int] = {}
    for section in ("slices", "units"):
        for name, policy in raw["systemd"].get(section, {}).items():
            value = systemd_size_to_kib(policy.get("memory_max"))
            if value is not None:
                result[name] = value
    return result


def disk_budget_kib_by_name(path: Path = RESOURCE_BUDGETS_PATH) -> dict[str, int]:
    raw = load_resource_budgets(path)
    result: dict[str, int] = {}
    for name, budget in raw.get("disk_budgets", {}).items():
        max_gib = budget.get("max_gib")
        if max_gib is not None:
            result[name] = int(float(max_gib) * 1024 * 1024)
    return result
