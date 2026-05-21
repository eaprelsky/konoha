import importlib.util
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "pre-release-gate.py"
spec = importlib.util.spec_from_file_location("pre_release_gate", MODULE_PATH)
pre_release_gate = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = pre_release_gate
spec.loader.exec_module(pre_release_gate)


def test_pre_release_gate_uses_canonical_policy_labels():
    assert pre_release_gate.RELEASE_POLICY.name == "release-policy.md"
    assert pre_release_gate.CANONICAL_BLOCKER_LABELS == ["priority:p0", "risk:critical", "risk:regression"]
    assert "P0: critical" in pre_release_gate.LEGACY_RELEASE_LABELS
    assert "needs-testing" in pre_release_gate.LEGACY_RELEASE_LABELS


def test_pre_release_gate_report_separates_blockers_and_warnings():
    report = pre_release_gate.format_report({
        "green": {"passed": True, "detail": "ok", "severity": "blocker"},
        "blocked": {"passed": False, "detail": "policy blocker", "severity": "blocker"},
        "warn": {"passed": False, "detail": "known warning", "severity": "warning"},
    })

    assert "Policy: docs/release-policy.md" in report
    assert "BLOCKED — 1 policy blocker" in report
    assert "[blocked] policy blocker" in report
    assert "WARNINGS — 1 item" in report
    assert "[warn] known warning" in report
    assert "result: BLOCKED" in report


def test_pre_release_gate_legacy_label_check_blocks_found_labels(monkeypatch):
    def fake_issue_list(label):
        if label == "needs-testing":
            return True, [{"number": 123, "title": "legacy route"}], ""
        return True, [], ""

    monkeypatch.setattr(pre_release_gate, "gh_issue_list_by_label", fake_issue_list)

    passed, detail = pre_release_gate.check_legacy_release_labels()

    assert passed is False
    assert "legacy_release_labels needs-testing #123" in detail
