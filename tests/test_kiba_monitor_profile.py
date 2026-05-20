import importlib.util
import asyncio
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "kiba_monitor_profile.py"
spec = importlib.util.spec_from_file_location("kiba_monitor_profile", MODULE_PATH)
kiba_profile = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = kiba_profile
spec.loader.exec_module(kiba_profile)

PROFILE_PATH = Path(__file__).resolve().parents[1] / "docs" / "kiba-monitor-profile.json"


class RecordingKonohaHandler(BaseHTTPRequestHandler):
    requests: list[str] = []

    def do_GET(self):
        self.__class__.requests.append(self.path)
        if self.path == "/health":
            payload = {"ok": True}
        elif self.path == "/agents":
            payload = {"agents": []}
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def log_message(self, format, *args):
        return


def start_server():
    handler = type("RecordingKonohaHandlerInstance", (RecordingKonohaHandler,), {"requests": []})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, handler


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


def load_akamaru_module(name: str = "akamaru_kiba_profile_test"):
    root = Path(__file__).resolve().parents[1]
    akamaru_path = root / "scripts" / "akamaru.py"
    spec = importlib.util.spec_from_file_location(name, akamaru_path)
    akamaru = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = akamaru
    spec.loader.exec_module(akamaru)
    return akamaru


def test_akamaru_routes_healthcheck_to_monitor_role_and_ops_channel(monkeypatch):
    monkeypatch.setenv("KIBA_MONITOR_ENVIRONMENT", "prod")
    monkeypatch.setenv("KONOHA_TOKEN", "")
    akamaru = load_akamaru_module("akamaru_healthcheck_routing_test")

    payload = akamaru.build_alert_payload("kiba:healthcheck")

    assert payload["to"] == "role:monitor"
    assert payload["type"] == "status"
    assert payload["channel"] == "ops"
    assert payload["text"] == "kiba:healthcheck env=prod severity=info"


def test_akamaru_keeps_known_baseline_in_ops_without_waking_monitor(monkeypatch):
    monkeypatch.setenv("KIBA_MONITOR_ENVIRONMENT", "prod")
    monkeypatch.setenv("KONOHA_TOKEN", "")
    akamaru = load_akamaru_module("akamaru_baseline_routing_test")

    payload = akamaru.build_alert_payload("kiba:alert agent=shino offline=42min")

    assert payload["to"] == "akamaru"
    assert payload["type"] == "status"
    assert payload["channel"] == "ops"
    assert "severity=baseline" in payload["text"]
    assert "baseline_key=agent:shino:offline" in payload["text"]


def test_akamaru_incident_alert_still_wakes_monitor(monkeypatch):
    monkeypatch.setenv("KIBA_MONITOR_ENVIRONMENT", "prod")
    monkeypatch.setenv("KONOHA_TOKEN", "")
    akamaru = load_akamaru_module("akamaru_incident_routing_test")

    payload = akamaru.build_alert_payload("kiba:alert redis=down")

    assert payload["to"] == "role:monitor"
    assert payload["type"] == "task"
    assert payload["channel"] == "ops"
    assert payload["text"] == "kiba:alert env=prod redis=down severity=incident"


def test_target_url_uses_selected_environment_url():
    env = {
        "KIBA_MONITOR_ENVIRONMENT": "staging",
        "KONOHA_URL": "http://prod.example:3200",
        "KONOHA_STAGING_URL": "http://staging.example:3200/",
    }

    assert kiba_profile.target_url_from_env(env) == "http://staging.example:3200"


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


def test_akamaru_staging_monitor_checks_staging_url_not_bus_url(monkeypatch):
    import importlib.util

    prod_server, prod_thread, prod_handler = start_server()
    staging_server, staging_thread, staging_handler = start_server()
    try:
        monkeypatch.setenv("KIBA_MONITOR_ENVIRONMENT", "staging")
        monkeypatch.setenv("KONOHA_URL", f"http://127.0.0.1:{prod_server.server_port}")
        monkeypatch.setenv("KONOHA_STAGING_URL", f"http://127.0.0.1:{staging_server.server_port}")
        monkeypatch.setenv("KIBA_ACTION_TARGET_ENV", "staging")
        monkeypatch.setenv("KONOHA_TOKEN", "")

        root = Path(__file__).resolve().parents[1]
        akamaru_path = root / "scripts" / "akamaru.py"
        spec = importlib.util.spec_from_file_location("akamaru_kiba_staging_url_test", akamaru_path)
        akamaru = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        sys.modules[spec.name] = akamaru
        spec.loader.exec_module(akamaru)

        alerts = asyncio.run(akamaru.check_konoha())

        assert alerts == []
        assert akamaru.KONOHA_URL == f"http://127.0.0.1:{prod_server.server_port}"
        assert akamaru.MONITORED_KONOHA_URL == f"http://127.0.0.1:{staging_server.server_port}"
        assert prod_handler.requests == []
        assert staging_handler.requests == ["/health", "/agents"]
        monkeypatch.setattr(akamaru, "is_service_masked", lambda service: False)
        monkeypatch.setattr(akamaru, "restart_service", lambda service: (True, "ok"))
        remediation = akamaru.remediate_alert("kiba:alert env=staging service=telegram-bot.service status=failed")
        assert remediation is not None
        assert "auto_restart_service=telegram-bot.service ok=1" in remediation
    finally:
        prod_server.shutdown()
        staging_server.shutdown()
        prod_server.server_close()
        staging_server.server_close()
        prod_thread.join(timeout=5)
        staging_thread.join(timeout=5)
