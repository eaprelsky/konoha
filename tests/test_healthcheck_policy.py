import importlib.util
import json
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "healthcheck-system.py"
spec = importlib.util.spec_from_file_location("healthcheck_system", MODULE_PATH)
healthcheck = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = healthcheck
spec.loader.exec_module(healthcheck)


def test_default_policy_keeps_telegram_enabled():
    policy = healthcheck.load_healthcheck_policy(environ={}, policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"))

    assert "telegram" in policy.enabled_connectors
    assert "akamaru" in policy.enabled_optional_monitors


def test_env_can_disable_connector_checks_for_fresh_install():
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_HEALTH_ENABLED_CONNECTORS": "none"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    assert "telegram" not in policy.enabled_connectors
    check = healthcheck.systemd_service_check("telegram-bot", "unknown", "connector_owned", policy)
    assert check.level == "OK"
    assert "policy=disabled" in check.detail


def test_disabled_but_configured_connector_warns():
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_HEALTH_ENABLED_CONNECTORS": "none"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    check = healthcheck.systemd_service_check("telegram-bot", "inactive", "connector_owned", policy)
    assert check.level == "WARN"
    assert "policy=disabled" in check.detail


def test_policy_file_can_disable_telegram(tmp_path):
    policy_file = tmp_path / "health-policy.json"
    policy_file.write_text(json.dumps({
        "enabled_connectors": [],
        "enabled_optional_monitors": ["akamaru"],
    }), encoding="utf-8")

    policy = healthcheck.load_healthcheck_policy(environ={}, policy_file=policy_file)

    assert policy.enabled_connectors == frozenset()
    assert policy.enabled_optional_monitors == frozenset({"akamaru"})


def test_optional_monitor_policy_enables_matching_agent_control_plane():
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_HEALTH_ENABLED_OPTIONAL_MONITORS": "kiba"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    assert healthcheck.agent_policy_enabled("kiba", "optional_worker", policy) is True
    assert healthcheck.agent_policy_enabled("kakashi", "optional_worker", policy) is False
