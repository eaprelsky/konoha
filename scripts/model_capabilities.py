#!/usr/bin/env python3
"""Model/agent capability routing helpers for Konoha Python services."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

CAP_TEXT = "text"
CAP_VISION = "vision"
CAP_TOOL_USE = "tool_use"
CAP_CODE = "code"
CAP_LONG_CONTEXT = "long_context"
CAP_REASONING = "reasoning"
CAP_CHEAP_CLASSIFIER = "cheap_classifier"

IMAGE_ATTACHMENT_KINDS = {"photo", "image", "picture", "screenshot"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".svg"}

DEFAULT_MODEL_CAPABILITIES: dict[str, set[str]] = {
    "deepseek-v4-pro": {CAP_TEXT, CAP_TOOL_USE, CAP_CODE, CAP_LONG_CONTEXT, CAP_REASONING},
    "deepseek-v4-flash": {CAP_TEXT, CAP_CHEAP_CLASSIFIER},
    "glm-5.1": {CAP_TEXT, CAP_TOOL_USE, CAP_CODE, CAP_LONG_CONTEXT, CAP_REASONING},
    "glm-4.5-air": {CAP_TEXT, CAP_CHEAP_CLASSIFIER},
    "google/gemini-2.0-flash-lite-001": {CAP_TEXT, CAP_VISION, CAP_CHEAP_CLASSIFIER},
    "openai/gpt-4o-mini": {CAP_TEXT, CAP_VISION, CAP_CHEAP_CLASSIFIER},
}

DEFAULT_ROUTE_TARGETS = {
    "sasuke": "sasuke",
    "ops": "sasuke",
    "lead": "sasuke",
    "task": "sasuke",
    "none": "sasuke",
}

DEFAULT_AGENT_MODELS = {
    "sasuke": "deepseek-v4-pro",
}


def _split_csv(value: str) -> set[str]:
    return {item.strip().lower() for item in value.split(",") if item.strip()}


def _json_mapping_env(name: str) -> dict[str, Any]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _load_registry_file() -> dict[str, Any]:
    path = os.environ.get("KONOHA_MODEL_CAPABILITIES_FILE", "").strip()
    if not path:
        return {}
    try:
        parsed = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _registry() -> dict[str, Any]:
    data = _load_registry_file()
    env_caps = _json_mapping_env("KONOHA_MODEL_CAPABILITIES_JSON")
    if env_caps:
        merged = dict(data)
        merged.setdefault("models", {})
        merged["models"].update(env_caps)
        data = merged
    return data


def model_capabilities(model: str) -> set[str]:
    model_id = (model or "").strip()
    env_key = "KONOHA_MODEL_CAPABILITIES_" + "".join(
        ch.upper() if ch.isalnum() else "_" for ch in model_id
    ).strip("_")
    if os.environ.get(env_key):
        return _split_csv(os.environ[env_key])

    models = _registry().get("models", {})
    if isinstance(models, dict) and model_id in models:
        value = models[model_id]
        if isinstance(value, list):
            return {str(item).strip().lower() for item in value if str(item).strip()}
        if isinstance(value, str):
            return _split_csv(value)

    if model_id in DEFAULT_MODEL_CAPABILITIES:
        return set(DEFAULT_MODEL_CAPABILITIES[model_id])

    lower = model_id.lower()
    inferred = {CAP_TEXT}
    if any(marker in lower for marker in ("vision", "vl", "gpt-4o", "gemini")):
        inferred.add(CAP_VISION)
    if any(marker in lower for marker in ("gpt-", "claude", "sonnet", "opus", "glm", "deepseek")):
        inferred.update({CAP_TOOL_USE, CAP_REASONING})
    return inferred


def route_target(route: str) -> str:
    normalized = (route or "sasuke").strip().lower()
    env_name = "TELEGRAM_ROUTE_" + normalized.upper().replace("-", "_") + "_TARGET"
    if os.environ.get(env_name):
        return os.environ[env_name].strip().lower()

    routes = _registry().get("routes", {})
    if isinstance(routes, dict) and routes.get(normalized):
        return str(routes[normalized]).strip().lower()

    return DEFAULT_ROUTE_TARGETS.get(normalized, "sasuke")


def target_model(target: str) -> str:
    normalized = (target or "sasuke").strip().lower()
    env_name = "KONOHA_AGENT_" + normalized.upper().replace("-", "_") + "_MODEL"
    if os.environ.get(env_name):
        return os.environ[env_name].strip()

    agents = _registry().get("agents", {})
    if isinstance(agents, dict) and agents.get(normalized):
        value = agents[normalized]
        if isinstance(value, dict) and value.get("model"):
            return str(value["model"]).strip()
        if isinstance(value, str):
            return value.strip()

    return DEFAULT_AGENT_MODELS.get(normalized, "")


def required_capabilities_for_event(event: dict[str, Any]) -> set[str]:
    required = {CAP_TEXT}
    kind = str(event.get("attachment_kind", "")).strip().lower()
    path = str(event.get("attachment_path", "")).strip().lower()
    if kind in IMAGE_ATTACHMENT_KINDS or any(path.endswith(suffix) for suffix in IMAGE_SUFFIXES):
        required.add(CAP_VISION)
    return required


def capability_decision(event: dict[str, Any], route: str) -> dict[str, str]:
    target = route_target(route)
    model = target_model(target)
    required = required_capabilities_for_event(event)
    available = model_capabilities(model)
    missing = sorted(required - available)

    default_stream = os.environ.get("TELEGRAM_INCOMING_STREAM", "telegram:incoming")
    vision_stream = os.environ.get("TELEGRAM_VISION_STREAM", "telegram:vision_requests")
    target_stream = vision_stream if CAP_VISION in missing else default_stream
    reason = "ok" if not missing else "missing_capabilities:" + ",".join(missing)

    return {
        "required_capabilities": ",".join(sorted(required)),
        "target_agent": target,
        "target_model": model,
        "target_capabilities": ",".join(sorted(available)),
        "missing_capabilities": ",".join(missing),
        "target_stream": target_stream,
        "capability_reason": reason,
    }


def apply_capability_fields(event: dict[str, Any], route: str) -> dict[str, str]:
    decision = capability_decision(event, route)
    event.update(decision)
    return decision
