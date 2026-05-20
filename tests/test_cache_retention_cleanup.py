import importlib.util
import os
import sys
import time
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
MODULE_PATH = SCRIPTS_DIR / "cache-retention-cleanup.py"
spec = importlib.util.spec_from_file_location("cache_retention_cleanup", MODULE_PATH)
cache_retention_cleanup = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = cache_retention_cleanup
spec.loader.exec_module(cache_retention_cleanup)


def budget_for(path: Path):
    return {
        "npm_npx_cache": {
            "path": str(path),
            "retention_days": 7,
            "cleanup": {
                "automated": True,
                "mode": "delete_stale_children",
                "never_delete_active_refs": True,
            },
        }
    }


def test_dry_run_skips_active_npx_child(monkeypatch, tmp_path):
    old = tmp_path / "old"
    active = tmp_path / "active"
    old.mkdir()
    active.mkdir()
    stale = time.time() - 10 * 86400
    os.utime(old, (stale, stale))
    os.utime(active, (stale, stale))

    monkeypatch.setattr(cache_retention_cleanup, "disk_budget_entries", lambda: budget_for(tmp_path))
    monkeypatch.setattr(cache_retention_cleanup, "active_process_args", lambda: f"node {active}/node_modules/.bin/tool")
    monkeypatch.setattr(cache_retention_cleanup, "du_kib", lambda path: 42)

    plan = cache_retention_cleanup.build_plan(["npm_npx_cache"])

    assert [candidate.path for candidate in plan.candidates] == [str(old)]
    assert {"target": "npm_npx_cache", "path": str(active), "reason": "active_process_reference"} in plan.skipped


def test_apply_deletes_only_planned_stale_children(monkeypatch, tmp_path):
    old = tmp_path / "old"
    recent = tmp_path / "recent"
    old.mkdir()
    recent.mkdir()
    stale = time.time() - 10 * 86400
    os.utime(old, (stale, stale))

    monkeypatch.setattr(cache_retention_cleanup, "disk_budget_entries", lambda: budget_for(tmp_path))
    monkeypatch.setattr(cache_retention_cleanup, "active_process_args", lambda: "")
    monkeypatch.setattr(cache_retention_cleanup, "du_kib", lambda path: 1)

    plan = cache_retention_cleanup.build_plan(["npm_npx_cache"])
    result = cache_retention_cleanup.apply_plan(plan)

    assert result.mode == "apply"
    assert not old.exists()
    assert recent.exists()
