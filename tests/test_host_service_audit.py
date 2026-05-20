import importlib.util
import sys
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
MODULE_PATH = SCRIPTS_DIR / "host-service-audit.py"
spec = importlib.util.spec_from_file_location("host_service_audit", MODULE_PATH)
host_service_audit = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = host_service_audit
spec.loader.exec_module(host_service_audit)


def test_plan_reports_rollback_and_safe_candidates(monkeypatch):
    def fake_run(cmd, timeout=10):
        unit = cmd[-1]
        if cmd[1] == "is-active":
            return 0, "active", ""
        if cmd[1] == "is-enabled":
            return 0, "enabled", ""
        raise AssertionError(cmd)

    monkeypatch.setattr(host_service_audit, "run", fake_run)

    plans = host_service_audit.build_plan(["modem_manager"])

    assert len(plans) == 1
    assert plans[0].id == "modem_manager"
    assert plans[0].status == "actionable"
    assert plans[0].units == ["ModemManager.service"]
    assert plans[0].disable_commands == ["systemctl disable --now ModemManager.service"]
    assert plans[0].rollback_commands == ["systemctl enable --now ModemManager.service"]


def test_disable_candidates_cannot_overlap_protected_units():
    candidates = {
        "bad": {
            "id": "bad",
            "units": ["nginx.service"],
        }
    }

    try:
        host_service_audit.validate_candidates(candidates, {"nginx.service"})
    except ValueError as exc:
        assert "protected unit" in str(exc)
    else:
        raise AssertionError("protected disable candidate was accepted")


def test_apply_uses_sudo_for_systemctl(monkeypatch):
    calls = []

    def fake_run(cmd, timeout=10):
        calls.append(cmd)
        return 0, "", ""

    monkeypatch.setattr(host_service_audit, "run", fake_run)

    result = host_service_audit.execute_commands(["systemctl stop fwupd.service"], use_sudo=True)

    assert result[0]["returncode"] == 0
    assert calls == [["sudo", "-n", "systemctl", "stop", "fwupd.service"]]
