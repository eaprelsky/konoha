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
        environ={"KONOHA_SERVICE_PROFILE": "qa-on-demand", "KONOHA_FEATURE_FLAGS_FILE": "/tmp/nonexistent-konoha-feature-flags.json"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    assert policy.service_profile == "qa-on-demand"
    assert policy.enabled_connectors == frozenset()
    assert policy.enabled_optional_monitors == frozenset({"akamaru"})
    assert policy.enabled_features == frozenset({"testbench"})


def test_core_profiles_keep_experimental_features_disabled():
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_SERVICE_PROFILE": "prod-core", "KONOHA_FEATURE_FLAGS_FILE": "/tmp/nonexistent-konoha-feature-flags.json"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    assert policy.enabled_features == frozenset()


def test_healthcheck_summary_includes_monitor_environment(capsys, monkeypatch):
    monkeypatch.setenv("KIBA_MONITOR_ENVIRONMENT", "staging")

    rc = healthcheck.print_report([healthcheck.Check("OK", "sample", "detail")])

    out = capsys.readouterr().out
    assert rc == 0
    assert "summary env=staging: 1 OK, 0 WARN, 0 FAIL" in out


def test_operational_alerts_ok_when_empty(monkeypatch):
    monkeypatch.setattr(healthcheck, "api_get", lambda path: {
        "summary": {"total": 0, "critical": 0, "warning": 0, "stuck_case": 0, "runtime_effect_failed": 0},
        "alerts": [],
    })

    checks = healthcheck.check_operational_alerts()

    assert checks == [healthcheck.Check("OK", "runtime.operational_alerts", "alerts=0 critical=0 warning=0 stuck_case=0 runtime_effect_failed=0")]


def test_operational_alerts_warn_with_actionable_correlation(monkeypatch):
    monkeypatch.setattr(healthcheck, "api_get", lambda path: {
        "summary": {"total": 2, "critical": 1, "warning": 1, "stuck_case": 1, "runtime_effect_failed": 1},
        "alerts": [{
            "alert_id": "opalert_dead",
            "kind": "runtime_effect_failed",
            "severity": "critical",
            "correlation": {"case_id": "case-1", "effect_id": "rte-1"},
        }],
    })

    checks = healthcheck.check_operational_alerts()

    assert checks[0].level == "WARN"
    assert checks[0].name == "runtime.operational_alerts"
    assert "alerts=2 critical=1 warning=1" in checks[0].detail
    assert "first=opalert_dead kind=runtime_effect_failed severity=critical case_id=case-1 effect_id=rte-1" in checks[0].detail
    assert "/operational-alerts" in checks[0].hint


def test_pg_read_readiness_ok_when_all_entities_ready(monkeypatch):
    monkeypatch.setattr(healthcheck, "api_get", lambda path: {
        "overall_status": "ready",
        "rollout_status": "safe",
        "legacy_pg_read_enabled": False,
        "summary": {"ready": 6, "blocked": 0, "pg_primary": 1, "enabled": 0, "enabled_blocked": 0},
        "entities": [],
    })

    checks = healthcheck.check_pg_read_readiness()

    assert checks == [healthcheck.Check("OK", "storage.pg_read_readiness", "overall=ready rollout=safe legacy_pg_read_enabled=False ready=6 blocked=0 pg_primary=1 enabled=0 enabled_blocked=0")]


def test_pg_read_readiness_warns_with_first_blocker(monkeypatch):
    monkeypatch.setattr(healthcheck, "api_get", lambda path: {
        "overall_status": "blocked",
        "rollout_status": "unsafe",
        "legacy_pg_read_enabled": False,
        "summary": {"ready": 1, "blocked": 5, "pg_primary": 1, "enabled": 2, "enabled_blocked": 1},
        "entities": [{
            "entity": "cases",
            "status": "blocked",
            "blockers": [{"code": "ONLY_IN_REDIS", "count": 6}],
        }],
    })

    checks = healthcheck.check_pg_read_readiness()

    assert checks[0].level == "WARN"
    assert checks[0].name == "storage.pg_read_readiness"
    assert "overall=blocked rollout=unsafe legacy_pg_read_enabled=False ready=1 blocked=5 pg_primary=1 enabled=2 enabled_blocked=1" in checks[0].detail
    assert "first_blocked_entity=cases blocker=ONLY_IN_REDIS blocker_count=6" in checks[0].detail
    assert "/pg-read-readiness" in checks[0].hint


def test_prod_core_treats_sdd_worker_absence_as_optional_disabled():
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_FEATURE_FLAGS_FILE": "/tmp/nonexistent-konoha-feature-flags.json"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

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


def test_healthcheck_reports_disabled_feature_flags_as_intentional(monkeypatch):
    monkeypatch.setenv("KONOHA_SERVICE_PROFILE", "prod-core")
    monkeypatch.setenv("KONOHA_FEATURE_FLAGS_FILE", "/tmp/nonexistent-konoha-feature-flags.json")

    checks = healthcheck.check_experimental_feature_flags()
    corporate_memory = next(check for check in checks if check.name == "feature_flags.corporate-memory")

    assert corporate_memory.level == "OK"
    assert "disabled intentionally" in corporate_memory.detail


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


def test_telegram_packer_pressure_reports_lag_and_cpu():
    policy = healthcheck.load_healthcheck_policy(environ={}, policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"))
    stream_state = {
        "telegram:needs_context": {
            "len": 120,
            "groups": {"context-packer": {"pending": 2, "lag": 101, "consumers": 1}},
        },
        "telegram:vision_requests": {
            "len": 5,
            "groups": {"vision-packer": {"pending": 0, "lag": 0, "consumers": 1}},
        },
    }

    checks = healthcheck.telegram_packer_pressure_checks(
        stream_state,
        {"telegram-context-packer.py": 31.5, "telegram-vision-packer.py": 0.2},
        policy,
    )

    context = next(check for check in checks if check.name == "telegram.packer.context")
    vision = next(check for check in checks if check.name == "telegram.packer.vision")
    assert context.level == "WARN"
    assert "lag=101" in context.detail
    assert "cpu=31.5%" in context.detail
    assert "batch=" in context.detail
    assert vision.level == "OK"


def test_telegram_packer_pressure_skips_when_connector_disabled():
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_HEALTH_ENABLED_CONNECTORS": "none"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    checks = healthcheck.telegram_packer_pressure_checks({}, {}, policy)

    assert checks == [
        healthcheck.Check("OK", "telegram.packer.pressure", "disabled by policy; packer pressure checks skipped")
    ]


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


def test_testbench_inactive_is_ok_when_feature_disabled(monkeypatch):
    def fake_run(cmd, timeout=10):
        assert cmd == ["systemctl", "is-active", "konoha-testbench.service"]
        return 3, "inactive\n", ""

    monkeypatch.setattr(healthcheck, "run", fake_run)
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_SERVICE_PROFILE": "prod-core", "KONOHA_FEATURE_FLAGS_FILE": "/tmp/nonexistent-konoha-feature-flags.json"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    checks = healthcheck.check_testbench_pool(policy)

    assert checks[0].level == "OK"
    assert "feature=disabled" in checks[0].detail
    assert "mode=on-demand inactive" in checks[0].detail


def test_testbench_status_reports_bounded_pool(monkeypatch):
    calls = []

    def fake_run(cmd, timeout=10):
        calls.append(cmd)
        if cmd == ["systemctl", "is-active", "konoha-testbench.service"]:
            return 0, "active\n", ""
        assert "resource-inventory.py" in cmd[1]
        return 0, '{"groups":{"testbench_browser":{"rss_kib":100,"budget_pressure":"ok"}},"service_budgets":[],"disk":[]}', ""

    def fake_testbench_api_get(path):
        assert path == "/testbench/status"
        return {
            "ok": True,
            "mode": "on-demand",
            "total": 1,
            "free": 1,
            "busy": 0,
            "waiting": 0,
            "limits": {"max_pool_size": 2, "max_concurrent_jobs": 2, "session_ttl_ms": 300000},
        }

    monkeypatch.setattr(healthcheck, "run", fake_run)
    monkeypatch.setattr(healthcheck, "testbench_api_get", fake_testbench_api_get)
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_SERVICE_PROFILE": "qa-on-demand", "KONOHA_FEATURE_FLAGS_FILE": "/tmp/nonexistent-konoha-feature-flags.json"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    checks = healthcheck.check_testbench_pool(policy)

    assert checks[0].level == "OK"
    assert "mode=on-demand" in checks[0].detail
    assert "total=1" in checks[0].detail
    assert "'session_ttl_ms': 300000" in checks[0].detail
    assert calls[0] == ["systemctl", "is-active", "konoha-testbench.service"]


def test_testbench_idle_pool_under_memory_pressure_warns(monkeypatch):
    def fake_run(cmd, timeout=10):
        if cmd == ["systemctl", "is-active", "konoha-testbench.service"]:
            return 0, "active\n", ""
        assert "resource-inventory.py" in cmd[1]
        return 0, '{"groups":{"testbench_browser":{"rss_kib":900,"budget_pressure":"critical"}},"service_budgets":[{"unit":"konoha-testbench.service","budget_pressure":"critical"}],"disk":[]}', ""

    monkeypatch.setattr(healthcheck, "run", fake_run)
    monkeypatch.setattr(healthcheck, "testbench_api_get", lambda path: {
        "mode": "on-demand",
        "total": 1,
        "free": 1,
        "busy": 0,
        "waiting": 0,
        "limits": {"max_pool_size": 2},
    })
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_SERVICE_PROFILE": "qa-on-demand", "KONOHA_FEATURE_FLAGS_FILE": "/tmp/nonexistent-konoha-feature-flags.json"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    checks = healthcheck.check_testbench_pool(policy)

    assert checks[0].level == "WARN"
    assert "idle_pool=true" in checks[0].detail
    assert "pressure=critical" in checks[0].detail


def test_testbench_stale_oversized_pool_warns(monkeypatch):
    def fake_run(cmd, timeout=10):
        assert cmd == ["systemctl", "is-active", "konoha-testbench.service"]
        return 0, "active\n", ""

    monkeypatch.setattr(healthcheck, "run", fake_run)
    monkeypatch.setattr(healthcheck, "testbench_api_get", lambda path: {
        "mode": "unknown",
        "total": 3,
        "free": 3,
        "busy": 0,
        "waiting": 0,
        "limits": {"max_pool_size": 3, "acquire_timeout_ms": 30000},
    })
    policy = healthcheck.load_healthcheck_policy(
        environ={"KONOHA_SERVICE_PROFILE": "qa-on-demand", "KONOHA_FEATURE_FLAGS_FILE": "/tmp/nonexistent-konoha-feature-flags.json"},
        policy_file=Path("/tmp/nonexistent-konoha-health-policy.json"),
    )

    checks = healthcheck.check_testbench_pool(policy)

    assert checks[0].level == "WARN"
    assert "exceeds_budget=true" in checks[0].detail


def test_resource_inventory_budget_pressure_is_reported(monkeypatch):
    def fake_run(cmd, timeout=10):
        assert "resource-inventory.py" in cmd[1]
        assert "--no-disk" not in cmd
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
    assert "'groups': {}" in checks[0].detail
    assert "'services': {}" in checks[0].detail
    assert "'limit_hits': {}" in checks[0].detail
    assert "'oom_restarts': {}" in checks[0].detail


def test_resource_inventory_service_budget_pressure_is_reported(monkeypatch):
    def fake_run(cmd, timeout=10):
        return 0, '{"groups":{"core_konoha_api":{"rss_kib":100,"budget_pressure":"ok"}},"service_budgets":[{"unit":"konoha-testbench.service","budget_pressure":"critical"}],"disk":[]}', ""

    monkeypatch.setattr(healthcheck, "run", fake_run)

    checks = healthcheck.check_resource_inventory_budget()

    assert checks[0].level == "WARN"
    assert "'konoha-testbench.service': 'critical'" in checks[0].detail


def test_resource_inventory_disk_budget_pressure_is_reported(monkeypatch):
    def fake_run(cmd, timeout=10):
        assert "--no-disk" not in cmd
        return 0, '{"groups":{"core_konoha_api":{"rss_kib":100,"budget_pressure":"ok"}},"service_budgets":[],"disk":[{"name":"npm_cache","budget_pressure":"critical"}]}', ""

    monkeypatch.setattr(healthcheck, "run", fake_run)

    checks = healthcheck.check_resource_inventory_budget()

    assert checks[0].level == "WARN"
    assert checks[0].name == "resource_inventory.budget_pressure"
    assert "'npm_cache': 'critical'" in checks[0].detail


def test_resource_inventory_memory_limit_hit_is_reported(monkeypatch):
    def fake_run(cmd, timeout=10):
        return 0, '{"groups":{"core_konoha_api":{"rss_kib":100,"budget_pressure":"ok"}},"service_budgets":[{"unit":"konoha-testbench.service","budget_pressure":"ok","memory_limit_hit":true,"memory_peak_kib":786432}],"disk":[]}', ""

    monkeypatch.setattr(healthcheck, "run", fake_run)

    checks = healthcheck.check_resource_inventory_budget()

    assert checks[0].level == "WARN"
    assert checks[0].name == "resource_inventory.limit_hits"
    assert "'konoha-testbench.service': 786432" in checks[0].detail


def test_resource_inventory_oom_restart_is_reported(monkeypatch):
    def fake_run(cmd, timeout=10):
        return 0, '{"groups":{"core_konoha_api":{"rss_kib":100,"budget_pressure":"ok"}},"service_budgets":[{"unit":"agent-managed@shino.service","budget_pressure":"ok","result":"oom-kill","n_restarts":1,"oom_killed":true}],"disk":[]}', ""

    monkeypatch.setattr(healthcheck, "run", fake_run)

    checks = healthcheck.check_resource_inventory_budget()

    assert checks[0].level == "WARN"
    assert checks[0].name == "resource_inventory.oom_restarts"
    assert "agent-managed@shino.service" in checks[0].detail
