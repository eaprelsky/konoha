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
    monkeypatch.setenv("KONOHA_SERVICE_PROFILE", "qa-on-demand")
    monkeypatch.setenv("WATCHDOG_AGENTS", "jiraiya,shino")
    monkeypatch.delenv("KONOHA_ENABLE_DISABLED_EXPERIMENT_AGENTS", raising=False)

    assert watchdog_lifecycle.get_agents() == ["shino"]


def test_argv_watch_list_filters_disabled_jiraiya(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["watchdog-lifecycle.py", "jiraiya", "shino"])
    monkeypatch.setenv("KONOHA_SERVICE_PROFILE", "qa-on-demand")
    monkeypatch.delenv("WATCHDOG_AGENTS", raising=False)
    monkeypatch.delenv("KONOHA_ENABLE_DISABLED_EXPERIMENT_AGENTS", raising=False)

    assert watchdog_lifecycle.get_agents() == ["shino"]


def test_disabled_jiraiya_override_still_requires_profile_watch_scope(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["watchdog-lifecycle.py"])
    monkeypatch.setenv("KONOHA_SERVICE_PROFILE", "qa-on-demand")
    monkeypatch.setenv("WATCHDOG_AGENTS", "jiraiya,shino")
    monkeypatch.setenv("KONOHA_ENABLE_DISABLED_EXPERIMENT_AGENTS", "jiraiya")

    assert watchdog_lifecycle.get_agents() == ["shino"]


def test_prod_core_filters_shino_lifecycle_watch(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["watchdog-lifecycle.py"])
    monkeypatch.setenv("KONOHA_SERVICE_PROFILE", "prod-core")
    monkeypatch.setenv("WATCHDOG_AGENTS", "shino,hinata,guy")
    monkeypatch.delenv("KONOHA_ENABLE_DISABLED_LIFECYCLE_AGENTS", raising=False)

    assert watchdog_lifecycle.get_agents() == []


def test_disabled_lifecycle_override_allows_bounded_manual_watch(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["watchdog-lifecycle.py"])
    monkeypatch.setenv("KONOHA_SERVICE_PROFILE", "prod-core")
    monkeypatch.setenv("WATCHDOG_AGENTS", "shino")
    monkeypatch.setenv("KONOHA_ENABLE_DISABLED_LIFECYCLE_AGENTS", "shino")

    assert watchdog_lifecycle.get_agents() == ["shino"]
