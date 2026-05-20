import importlib.util
import subprocess
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "resource-inventory.py"
spec = importlib.util.spec_from_file_location("resource_inventory", MODULE_PATH)
resource_inventory = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = resource_inventory
spec.loader.exec_module(resource_inventory)


def test_redacts_tokens_and_secret_args():
    raw = (
        "curl -H 'Authorization: Bearer abcdef123456' "
        "KONOHA_TOKEN=0123456789abcdef0123456789abcdef0123456789abcdef "
        "https://example.test/hook?webhook=supersecret"
    )

    redacted = resource_inventory.redact(raw)

    assert "abcdef123456" not in redacted
    assert "supersecret" not in redacted
    assert "0123456789abcdef0123456789abcdef0123456789abcdef" not in redacted
    assert "[REDACTED" in redacted


def test_classifies_agent_mcp_process_tree(monkeypatch):
    monkeypatch.setattr(resource_inventory, "read_proc_cgroup", lambda pid: ("agent-kiba.service", "konoha-agents.slice"))
    rows = resource_inventory.parse_ps(
        "\n".join([
            "100 1 50000 1.0 claude claude --mcp-config /opt/shared/agent-workdirs/kiba/.mcp.json",
            "101 100 60000 0.2 node node /home/ubuntu/.npm/_npx/x/node_modules/.bin/mcp-server-memory",
            "102 100 70000 0.3 bun /home/ubuntu/.bun/bin/bun run /home/ubuntu/konoha/src/mcp.ts",
        ])
    )

    resource_inventory.classify_processes(rows)

    by_pid = {row.pid: row for row in rows}
    assert by_pid[100].group == "managed_agent"
    assert by_pid[100].agent_id == "kiba"
    assert by_pid[101].group == "mcp_server"
    assert by_pid[101].agent_id == "kiba"
    assert by_pid[101].mcp_server == "memory"
    assert by_pid[102].mcp_server == "konoha"


def test_codex_mcp_config_args_do_not_make_process_an_mcp_server(monkeypatch):
    monkeypatch.setattr(resource_inventory, "read_proc_cgroup", lambda pid: ("agent-kakashi.service", "konoha-qa.slice"))
    rows = resource_inventory.parse_ps(
        "200 1 100000 3.0 codex /home/ubuntu/.npm-global/bin/codex -C /opt/shared/agent-workdirs/kakashi -c mcp_servers.konoha.command=/home/ubuntu/.bun/bin/bun"
    )

    resource_inventory.classify_processes(rows)

    assert rows[0].agent_id == "kakashi"
    assert rows[0].mcp_server is None
    assert rows[0].group == "managed_agent"


def test_budget_pressure_uses_systemd_memory_peak():
    row = resource_inventory.ProcessRow(
        pid=1,
        ppid=0,
        rss_kib=100 * 1024,
        cpu_percent=2.5,
        command="bun",
        args="bun run /home/ubuntu/konoha/src/server.ts",
        redacted_args="bun run /home/ubuntu/konoha/src/server.ts",
        group="core_konoha_api",
        systemd_unit="konoha.service",
    )
    budget = {
        "konoha.service": {
            "MemoryMax": str(1000 * 1024 * 1024),
            "MemoryPeak": str(850 * 1024 * 1024),
        }
    }

    summaries = resource_inventory.summarize([row], budget)

    assert summaries["core_konoha_api"].peak_rss_kib == 850 * 1024
    assert summaries["core_konoha_api"].budget_pressure == "warning"


def test_service_budget_rows_include_expected_fallback_budget():
    rows = resource_inventory.summarize_service_budgets({
        "konoha.service": {
            "ActiveState": "active",
            "MemoryCurrent": str(500 * 1024 * 1024),
            "MemoryPeak": str(1300 * 1024 * 1024),
            "MemoryMax": "infinity",
            "CPUUsageNSec": "42",
            "CPUQuotaPerSecUSec": "infinity",
        }
    })

    assert rows[0]["unit"] == "konoha.service"
    assert rows[0]["memory_max_kib"] == 1200 * 1024
    assert rows[0]["memory_actual_max_kib"] is None
    assert rows[0]["budget_pressure"] == "critical"
    assert rows[0]["memory_limit_hit"] is False
    assert rows[0]["n_restarts"] == 0
    assert rows[0]["oom_killed"] is False


def test_service_budget_rows_report_actual_finite_memory_limit_hit():
    rows = resource_inventory.summarize_service_budgets({
        "konoha-testbench.service": {
            "ActiveState": "active",
            "MemoryCurrent": str(700 * 1024 * 1024),
            "MemoryPeak": str(768 * 1024 * 1024),
            "MemoryMax": str(768 * 1024 * 1024),
            "CPUUsageNSec": "42",
            "CPUQuotaPerSecUSec": "1000000",
        }
    })

    assert rows[0]["memory_max_kib"] == 768 * 1024
    assert rows[0]["memory_actual_max_kib"] == 768 * 1024
    assert rows[0]["memory_limit_hit"] is True


def test_service_budget_rows_report_oom_restart_state():
    rows = resource_inventory.summarize_service_budgets({
        "agent-managed@shino.service": {
            "ActiveState": "active",
            "MemoryCurrent": str(100 * 1024 * 1024),
            "MemoryPeak": str(120 * 1024 * 1024),
            "MemoryMax": str(900 * 1024 * 1024),
            "CPUUsageNSec": "42",
            "CPUQuotaPerSecUSec": "500000",
            "Result": "oom-kill",
            "NRestarts": "2",
            "OOMKilled": "yes",
        }
    })

    assert rows[0]["result"] == "oom-kill"
    assert rows[0]["n_restarts"] == 2
    assert rows[0]["oom_killed"] is True
    assert rows[0]["memory_limit_hit"] is False


def test_text_report_uses_redacted_args():
    report = {
        "groups": {
            "core_konoha_api": {
                "process_count": 1,
                "rss_kib": 100,
                "cpu_percent": 0.1,
                "peak_rss_kib": None,
                "budget_max_kib": None,
                "budget_pressure": "unknown",
                "members": ["konoha.service"],
            }
        },
        "top_processes": [
            {
                "pid": 1,
                "rss_kib": 100,
                "cpu_percent": 0.1,
                "group": "core_konoha_api",
                "agent_id": None,
                "mcp_server": None,
                "systemd_unit": "konoha.service",
                "redacted_args": "KONOHA_TOKEN=[REDACTED]",
            }
        ],
        "disk": [],
    }

    text = resource_inventory.format_text(report)

    assert "KONOHA_TOKEN=[REDACTED]" in text


def test_serialized_process_omits_raw_args():
    row = resource_inventory.ProcessRow(
        pid=1,
        ppid=0,
        rss_kib=1,
        cpu_percent=0.0,
        command="curl",
        args="curl KONOHA_TOKEN=secret",
        redacted_args="curl KONOHA_TOKEN=[REDACTED]",
    )

    data = resource_inventory.serialize_process(row)

    assert "args" not in data
    assert data["redacted_args"] == "curl KONOHA_TOKEN=[REDACTED]"


def test_disk_inventory_survives_du_timeout(monkeypatch, tmp_path):
    target = tmp_path / "cache"
    target.mkdir()
    monkeypatch.setattr(resource_inventory, "CACHE_TARGETS", [("slow_cache", target)])

    def fake_run(cmd, timeout=10):
        raise subprocess.TimeoutExpired(cmd, timeout)

    monkeypatch.setattr(resource_inventory, "run", fake_run)

    entries = resource_inventory.collect_disk_inventory()

    assert entries == [{
        "name": "slow_cache",
        "path": str(target),
        "size_kib": None,
        "budget_kib": None,
        "budget_pressure": "unknown",
        "status": "unavailable_or_timeout",
    }]
