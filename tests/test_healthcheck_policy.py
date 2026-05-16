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

def test_default_policy_uses_prod_core_service_profile():
    policy = healthcheck.load_healthcheck_policy(environ={}, policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"))

    assert policy.service_profile == "prod-core"
    assert "telegram" in policy.enabled_connectors
    assert "akamaru" in policy.enabled_optional_monitors
    assert "kiba" in policy.enabled_optional_monitors
    assert "kakashi" not in policy.enabled_optional_monitors


def test_service_profile_can_select_qa_on_demand_policy():
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_SERVICE_PROFILE": "qa-on-demand"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    assert policy.service_profile == "qa-on-demand"
    assert policy.enabled_connectors == frozenset()
    assert policy.enabled_optional_monitors == frozenset({"akamaru"})


def test_prod_core_treats_sdd_worker_absence_as_optional_disabled():
    policy = healthcheck.load_healthcheck_policy(environ={}, policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"))

    assert healthcheck.agent_policy_enabled("kakashi", "optional_worker", policy) is False
    check = healthcheck.systemd_service_slice_check(
        "agent-watchdog-kakashi.service",
        None,
        "konoha-qa.slice",
        policy,
    )

    assert check.level == "OK"
    assert "optional_monitor=kakashi policy=disabled" in check.detail


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


def test_parse_redis_commandstats_extracts_stream_counters():
    stats = healthcheck.parse_redis_commandstats(
        "# Commandstats\n"
        "cmdstat_xreadgroup:calls=120,usec=360,usec_per_call=3.00,rejected_calls=0,failed_calls=0\n"
        "cmdstat_xgroup:calls=14,usec=70,usec_per_call=5.00,rejected_calls=0,failed_calls=9\n"
        "cmdstat_xgroup|create:calls=4,usec=20,usec_per_call=5.00,rejected_calls=0,failed_calls=3\n"
    )

    assert stats["xreadgroup"]["calls"] == 120
    assert stats["xgroup"]["failed_calls"] == 9
    assert stats["xgroup|create"]["failed_calls"] == 3


def test_aggregate_commandstats_includes_xgroup_create_subcommand():
    stats = healthcheck.parse_redis_commandstats(
        "cmdstat_xgroup:calls=10,usec=50,usec_per_call=5.00,rejected_calls=0,failed_calls=1\n"
        "cmdstat_xgroup|create:calls=4,usec=20,usec_per_call=5.00,rejected_calls=0,failed_calls=3\n"
    )

    aggregated = healthcheck.aggregate_commandstats(stats, "xgroup")

    assert aggregated["calls"] == 14
    assert aggregated["failed_calls"] == 4


def test_redis_polling_storm_warns_on_failed_xgroup_growth():
    current = {
        "xreadgroup": {"calls": 200},
        "xgroup": {"calls": 25, "failed_calls": 11},
    }
    previous = {
        "ts": 100.0,
        "stats": {
            "xreadgroup": {"calls": 100},
            "xgroup": {"calls": 20, "failed_calls": 10},
        },
    }

    checks = healthcheck.redis_polling_storm_checks(current, previous, now=130.0)

    assert checks[0].level == "WARN"
    assert checks[0].name == "redis.commandstats.xgroup_failed"
    assert "xgroup_failed_delta=1" in checks[0].detail


def test_redis_polling_storm_warns_on_failed_xgroup_create_growth():
    current = {
        "xreadgroup": {"calls": 200},
        "xgroup|create": {"calls": 25, "failed_calls": 11},
    }
    previous = {
        "ts": 100.0,
        "stats": {
            "xreadgroup": {"calls": 100},
            "xgroup|create": {"calls": 20, "failed_calls": 10},
        },
    }

    checks = healthcheck.redis_polling_storm_checks(current, previous, now=130.0)

    assert checks[0].level == "WARN"
    assert checks[0].name == "redis.commandstats.xgroup_failed"
    assert "xgroup_failed_delta=1" in checks[0].detail


def test_redis_polling_storm_ok_when_rates_are_low():
    current = {
        "xreadgroup": {"calls": 130},
        "xgroup": {"calls": 11, "failed_calls": 0},
    }
    previous = {
        "ts": 100.0,
        "stats": {
            "xreadgroup": {"calls": 100},
            "xgroup": {"calls": 10, "failed_calls": 0},
        },
    }

    checks = healthcheck.redis_polling_storm_checks(current, previous, now=130.0)

    assert checks[0].level == "OK"
    assert "xreadgroup_rate=1.00/s" in checks[0].detail


def test_slice_policy_accepts_configured_core_budget():
    policy = healthcheck.load_healthcheck_policy(environ={}, policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"))
    props = {
        "ActiveState": "active",
        "MemoryHigh": str(900 * 1024 * 1024),
        "MemoryMax": str(1200 * 1024 * 1024),
        "CPUWeight": "300",
        "CPUQuotaPerSecUSec": "2s",
        "TasksMax": "4096",
    }

    check = healthcheck.systemd_slice_policy_check(
        "konoha-core.slice",
        props,
        healthcheck.SYSTEMD_SLICE_POLICIES["konoha-core.slice"],
        policy,
    )

    assert check.level == "OK"
    assert "classification=required_core" in check.detail


def test_slice_policy_warns_when_enabled_slice_has_no_budget():
    policy = healthcheck.load_healthcheck_policy(environ={}, policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"))
    props = {
        "ActiveState": "active",
        "MemoryHigh": "infinity",
        "MemoryMax": "infinity",
        "CPUWeight": "",
        "CPUQuotaPerSecUSec": "infinity",
        "TasksMax": "infinity",
    }

    check = healthcheck.systemd_slice_policy_check(
        "konoha-connectors.slice",
        props,
        healthcheck.SYSTEMD_SLICE_POLICIES["konoha-connectors.slice"],
        policy,
    )

    assert check.level == "WARN"
    assert "MemoryMax=infinity" in check.detail
    assert "CPUQuota=infinity" in check.detail


def test_slice_policy_warns_when_finite_cpu_quota_is_wrong():
    policy = healthcheck.load_healthcheck_policy(environ={}, policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"))
    props = {
        "ActiveState": "active",
        "MemoryHigh": str(900 * 1024 * 1024),
        "MemoryMax": str(1200 * 1024 * 1024),
        "CPUWeight": "300",
        "CPUQuotaPerSecUSec": "500ms",
        "TasksMax": "4096",
    }

    check = healthcheck.systemd_slice_policy_check(
        "konoha-core.slice",
        props,
        healthcheck.SYSTEMD_SLICE_POLICIES["konoha-core.slice"],
        policy,
    )

    assert check.level == "WARN"
    assert "CPUQuota=500ms expected=200%" in check.detail


def test_slice_policy_warns_when_tasks_max_is_wrong():
    policy = healthcheck.load_healthcheck_policy(environ={}, policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"))
    props = {
        "ActiveState": "active",
        "MemoryHigh": str(900 * 1024 * 1024),
        "MemoryMax": str(1200 * 1024 * 1024),
        "CPUWeight": "300",
        "CPUQuotaPerSecUSec": "2s",
        "TasksMax": "128",
    }

    check = healthcheck.systemd_slice_policy_check(
        "konoha-core.slice",
        props,
        healthcheck.SYSTEMD_SLICE_POLICIES["konoha-core.slice"],
        policy,
    )

    assert check.level == "WARN"
    assert "TasksMax=128 expected=4096" in check.detail


def test_disabled_optional_slice_absence_is_healthy():
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_HEALTH_ENABLED_OPTIONAL_MONITORS": "none"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    check = healthcheck.systemd_slice_policy_check(
        "konoha-qa.slice",
        None,
        healthcheck.SYSTEMD_SLICE_POLICIES["konoha-qa.slice"],
        policy,
    )

    assert check.level == "OK"
    assert "policy=disabled" in check.detail


def test_service_slice_check_detects_core_reparenting_risk():
    policy = healthcheck.load_healthcheck_policy(environ={}, policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"))

    check = healthcheck.systemd_service_slice_check(
        "agent-kiba.service",
        {"Slice": "konoha-core.slice"},
        "konoha-agents.slice",
        policy,
    )

    assert check.level == "WARN"
    assert "expected=konoha-agents.slice" in check.detail


def test_service_slice_expectations_do_not_include_template_literal():
    policy = healthcheck.load_healthcheck_policy(environ={}, policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"))

    services = healthcheck.expected_service_slices(policy)

    assert "agent-managed@.service" not in services


def test_enabled_lifecycle_managed_instance_is_validated():
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_HEALTH_ENABLED_OPTIONAL_MONITORS": "shino"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    services = healthcheck.expected_service_slices(policy)

    assert services["agent-managed@shino.service"] == "konoha-qa.slice"


def test_disabled_lifecycle_managed_instance_absence_is_healthy():
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_HEALTH_ENABLED_OPTIONAL_MONITORS": "none"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    check = healthcheck.systemd_service_slice_check(
        "agent-managed@shino.service",
        None,
        "konoha-qa.slice",
        policy,
    )

    assert check.level == "OK"
    assert "managed_agent=shino policy=disabled" in check.detail


def test_disabled_jiraiya_experiment_absence_is_healthy(monkeypatch):
    def fake_run(cmd, timeout=10):
        if cmd[:2] == ["systemctl", "is-active"]:
            assert cmd[2] == "agent-managed@jiraiya.service"
            return 3, "inactive\n", ""
        if cmd[:3] == ["tmux", "-L", "jiraiya"]:
            return 1, "", "no session"
        raise AssertionError(cmd)

    monkeypatch.setattr(healthcheck, "run", fake_run)

    checks = healthcheck.check_disabled_experiment_agents()

    assert checks[0].level == "OK"
    assert checks[0].name == "disabled_experiment.jiraiya"
    assert "tmux=absent" in checks[0].detail


def test_disabled_jiraiya_experiment_running_warns(monkeypatch):
    def fake_run(cmd, timeout=10):
        if cmd[:2] == ["systemctl", "is-active"]:
            return 0, "active\n", ""
        if cmd[:3] == ["tmux", "-L", "jiraiya"]:
            return 0, "", ""
        raise AssertionError(cmd)

    monkeypatch.setattr(healthcheck, "run", fake_run)

    checks = healthcheck.check_disabled_experiment_agents()

    assert checks[0].level == "WARN"
    assert "service=active" in checks[0].detail
    assert "tmux=active" in checks[0].detail


def test_resource_inventory_budget_pressure_is_reported(monkeypatch):
    def fake_run(cmd, timeout=10):
        assert "resource-inventory.py" in cmd[1]
        return 0, '{"groups":{"core_konoha_api":{"rss_kib":100,"budget_pressure":"ok"},"mcp_server":{"rss_kib":900,"budget_pressure":"warning"}}}', ""

    monkeypatch.setattr(healthcheck, "run", fake_run)

    checks = healthcheck.check_resource_inventory_budget()

    assert checks[0].level == "WARN"
    assert checks[0].name == "resource_inventory.budget_pressure"
    assert "'mcp_server': 'warning'" in checks[0].detail


def test_resource_inventory_budget_pressure_ok(monkeypatch):
    def fake_run(cmd, timeout=10):
        return 0, '{"groups":{"core_konoha_api":{"rss_kib":100,"budget_pressure":"ok"}}}', ""

    monkeypatch.setattr(healthcheck, "run", fake_run)

    checks = healthcheck.check_resource_inventory_budget()

    assert checks[0].level == "OK"
    assert "pressure={'groups': {}, 'services': {}, 'disk': {}}" in checks[0].detail


def test_resource_inventory_service_budget_pressure_is_reported(monkeypatch):
    def fake_run(cmd, timeout=10):
        return 0, '{"groups":{"core_konoha_api":{"rss_kib":100,"budget_pressure":"ok"}},"service_budgets":[{"unit":"konoha-testbench.service","budget_pressure":"critical"}],"disk":[]}', ""

    monkeypatch.setattr(healthcheck, "run", fake_run)

    checks = healthcheck.check_resource_inventory_budget()

    assert checks[0].level == "WARN"
    assert "'konoha-testbench.service': 'critical'" in checks[0].detail
