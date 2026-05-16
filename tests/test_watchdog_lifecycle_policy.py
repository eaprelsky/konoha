import importlib.util
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "watchdog-lifecycle.py"
spec = importlib.util.spec_from_file_location("watchdog_lifecycle", MODULE_PATH)
watchdog_lifecycle = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = watchdog_lifecycle
spec.loader.exec_module(watchdog_lifecycle)


def test_explicit_watchdog_agents_filters_disabled_jiraiya(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["watchdog-lifecycle.py"])
    monkeypatch.setenv("WATCHDOG_AGENTS", "mirai,jiraiya,shino")
    monkeypatch.delenv("KONOHA_ENABLE_DISABLED_EXPERIMENT_AGENTS", raising=False)

    assert watchdog_lifecycle.get_agents() == ["mirai", "shino"]


def test_argv_watch_list_filters_disabled_jiraiya(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["watchdog-lifecycle.py", "jiraiya", "shino"])
    monkeypatch.delenv("WATCHDOG_AGENTS", raising=False)
    monkeypatch.delenv("KONOHA_ENABLE_DISABLED_EXPERIMENT_AGENTS", raising=False)

    assert watchdog_lifecycle.get_agents() == ["shino"]


def test_disabled_jiraiya_requires_explicit_rollback_override(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["watchdog-lifecycle.py"])
    monkeypatch.setenv("WATCHDOG_AGENTS", "mirai,jiraiya,shino")
    monkeypatch.setenv("KONOHA_ENABLE_DISABLED_EXPERIMENT_AGENTS", "jiraiya")

    assert watchdog_lifecycle.get_agents() == ["mirai", "jiraiya", "shino"]
