import importlib.util
import json
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "kiba_monitor_profile.py"
spec = importlib.util.spec_from_file_location("kiba_monitor_profile", MODULE_PATH)
kiba_profile = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = kiba_profile
spec.loader.exec_module(kiba_profile)

PROFILE_PATH = Path(__file__).resolve().parents[1] / "docs" / "kiba-monitor-profile.json"


def test_profile_defines_single_shared_kiba_for_prod_and_staging():
    profile = kiba_profile.load_kiba_monitor_profile(PROFILE_PATH)

    assert profile["mode"] == "single-shared-monitor"
    assert profile["monitor_agent"] == "kiba"
    assert profile["mcp_profile"] == "kiba-monitor-core"
    assert profile["mcp_allowlist"] == ["konoha"]
    assert {target["environment"] for target in profile["targets"]} == {"prod", "staging"}
    assert {target["service_profile"] for target in profile["targets"]} == {"prod-core", "staging-core"}


def test_alert_and_healthcheck_messages_receive_environment_labels():
    assert kiba_profile.label_kiba_message("kiba:alert service=konoha.service status=failed", "prod") == (
        "kiba:alert env=prod service=konoha.service status=failed"
    )
    assert kiba_profile.label_kiba_message("kiba:healthcheck", "staging") == "kiba:healthcheck env=staging"
    assert kiba_profile.label_kiba_message("kiba:alert env=prod redis=down", "staging") == "kiba:alert env=prod redis=down"


def test_action_guard_requires_explicit_matching_target_environment():
    alert = "kiba:alert env=staging agent=naruto watchdog=dead session=alive"

    assert kiba_profile.action_guard_reason(alert, {"KIBA_ACTION_TARGET_ENV": "staging"}) is None
    assert "does not match" in kiba_profile.action_guard_reason(alert, {"KIBA_ACTION_TARGET_ENV": "prod"})
    assert "unset" in kiba_profile.action_guard_reason(alert, {})
    assert "missing env" in kiba_profile.action_guard_reason("kiba:alert agent=naruto watchdog=dead session=alive", {
        "KIBA_ACTION_TARGET_ENV": "prod",
    })


def test_systemd_units_pin_explicit_prod_action_environment():
    root = Path(__file__).resolve().parents[1]
    for unit in ["systemd/akamaru.service", "systemd/agent-kiba.service", "systemd/agent-watchdog-kiba.service"]:
        text = (root / unit).read_text(encoding="utf-8")
        assert "Environment=KIBA_MONITOR_ENVIRONMENT=prod" in text
        assert "Environment=KIBA_ACTION_TARGET_ENV=prod" in text


def test_service_profiles_do_not_autostart_duplicate_staging_kiba():
    root = Path(__file__).resolve().parents[1]
    profiles = json.loads((root / "docs" / "service-profiles.json").read_text(encoding="utf-8"))
    staging = profiles["profiles"]["staging-core"]

    assert "kiba" not in staging["autostart_agents"]
    assert "agent-kiba.service" in staging["optional_services"]


def test_akamaru_remediation_blocks_cross_environment_actions(monkeypatch):
    import importlib.util

    root = Path(__file__).resolve().parents[1]
    akamaru_path = root / "scripts" / "akamaru.py"
    spec = importlib.util.spec_from_file_location("akamaru_kiba_profile_test", akamaru_path)
    akamaru = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = akamaru
    spec.loader.exec_module(akamaru)

    monkeypatch.setattr(akamaru, "AUTO_REMEDIATE", True)
    monkeypatch.setenv("KIBA_ACTION_TARGET_ENV", "prod")
    result = akamaru.remediate_alert("kiba:alert env=staging service=telegram-bot.service status=failed")

    assert result is not None
    assert "auto_remediation_blocked" in result
    assert "env=staging" in result
