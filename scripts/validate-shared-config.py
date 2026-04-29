#!/usr/bin/env python3
"""Validate shared non-repo config without printing secrets."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


KEY_RE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
SHELL_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ALLOWED_IDENTICAL_DUPLICATES = {"SERVICE_ACCOUNT_PATH", "DRIVE_FOLDER_ID"}
REQUIRED_CREDENTIAL_KEYS = {
    "OPENROUTER_API_KEY",
    "YONOTE_API_KEY",
    "YONOTE_BASE_URL",
    "BITRIX24_WEBHOOK_URL",
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
    "TELEGRAM_BOT_TOKEN",
}
SENSITIVE_HINTS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "WEBHOOK", "HASH", "CVV", "CARD")


def redact_key(key: str) -> str:
    if any(hint in key.upper() for hint in SENSITIVE_HINTS):
        return f"{key}=<redacted>"
    return f"{key}=<set>"


def strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def risky_unquoted(value: str) -> bool:
    value = value.strip()
    if not value:
        return False
    if value[0] in {"'", '"'}:
        return False
    return any(ch.isspace() for ch in value) or "#" in value or ";" in value


def validate_env_file(path: Path, required: bool) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if not path.exists():
        message = f"{path}: file not found"
        (errors if required else warnings).append(message)
        return errors, warnings

    bash = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True, timeout=10)
    if bash.returncode != 0:
        errors.append(f"{path}: shell syntax error: {bash.stderr.strip().splitlines()[0][:160]}")

    entries: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            errors.append(f"{path}:{lineno}: malformed line without '='")
            continue
        match = KEY_RE.match(stripped)
        if not match:
            key = stripped.split("=", 1)[0].removeprefix("export ").strip()
            if not SHELL_KEY_RE.match(key):
                errors.append(f"{path}:{lineno}: invalid key name {key!r}")
            else:
                errors.append(f"{path}:{lineno}: malformed assignment for {key}")
            continue
        key, raw_value = match.group(1), match.group(2)
        entries[key].append((lineno, raw_value))
        if not strip_quotes(raw_value):
            message = f"{path}:{lineno}: empty value for {key}"
            (errors if key in REQUIRED_CREDENTIAL_KEYS else warnings).append(message)
        if risky_unquoted(raw_value):
            warnings.append(f"{path}:{lineno}: risky unquoted value for {redact_key(key)}")

    for key, values in sorted(entries.items()):
        if len(values) == 1:
            continue
        unique_values = {raw for _, raw in values}
        lines = ",".join(str(lineno) for lineno, _ in values)
        if key in ALLOWED_IDENTICAL_DUPLICATES and len(unique_values) == 1:
            warnings.append(f"{path}: duplicate {key} on lines {lines} allowed because values are identical")
        elif len(unique_values) == 1:
            errors.append(f"{path}: duplicate {key} on lines {lines}; remove duplicate even though values match")
        else:
            errors.append(f"{path}: conflicting duplicate {redact_key(key)} on lines {lines}")

    missing = sorted(key for key in REQUIRED_CREDENTIAL_KEYS if key not in entries)
    for key in missing:
        errors.append(f"{path}: missing required key {key}")

    return errors, warnings


def validate_trusted_users(path: Path, required: bool) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if not path.exists():
        message = f"{path}: file not found"
        (errors if required else warnings).append(message)
        return errors, warnings

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [f"{path}: invalid JSON: {exc}"], warnings

    owner = data.get("owner")
    trusted = data.get("trusted")
    if not isinstance(owner, dict):
        errors.append(f"{path}: owner must be an object")
    elif not owner.get("telegram_id"):
        errors.append(f"{path}: owner.telegram_id is required")

    if not isinstance(trusted, list):
        errors.append(f"{path}: trusted must be a list")
        trusted = []
    elif len(trusted) == 0:
        errors.append(f"{path}: trusted list is empty")

    seen: dict[str, str] = {}
    owner_id = str(owner.get("telegram_id")) if isinstance(owner, dict) and owner.get("telegram_id") else ""
    if owner_id:
        seen[owner_id] = "owner"
    for idx, user in enumerate(trusted):
        if not isinstance(user, dict):
            errors.append(f"{path}: trusted[{idx}] must be an object")
            continue
        user_id = user.get("telegram_id") or user.get("user_id")
        if not user_id:
            errors.append(f"{path}: trusted[{idx}] is missing telegram_id/user_id")
            continue
        key = str(user_id)
        if key in seen:
            errors.append(f"{path}: duplicate trusted telegram id <redacted> at trusted[{idx}] and {seen[key]}")
        seen[key] = f"trusted[{idx}]"

    if not errors:
        warnings.append(f"{path}: trusted users loaded ({len(trusted)} trusted + owner)")
    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate shared credential/trust config without printing secret values")
    parser.add_argument("--credentials", type=Path, default=Path("/opt/shared/.shared-credentials"))
    parser.add_argument("--trusted-users", type=Path, default=Path("/opt/shared/.trusted-users.json"))
    parser.add_argument("--require-credentials", action="store_true")
    parser.add_argument("--require-trusted-users", action="store_true")
    args = parser.parse_args()

    errors: list[str] = []
    warnings: list[str] = []
    env_errors, env_warnings = validate_env_file(args.credentials, args.require_credentials)
    trust_errors, trust_warnings = validate_trusted_users(args.trusted_users, args.require_trusted_users)
    errors.extend(env_errors)
    errors.extend(trust_errors)
    warnings.extend(env_warnings)
    warnings.extend(trust_warnings)

    for warning in warnings:
        print(f"WARN: {warning}")
    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)

    if errors:
        print(f"shared-config validation FAILED: {len(errors)} error(s), {len(warnings)} warning(s)", file=sys.stderr)
        return 1
    print(f"shared-config validation OK: {len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
