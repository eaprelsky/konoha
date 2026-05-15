import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def load_watchdog_kakashi():
    sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location(
        "watchdog_kakashi", SCRIPTS / "watchdog-kakashi.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def issue_with_labels(*labels: str) -> dict:
    return {"number": 649, "labels": [{"name": label} for label in labels]}


class KakashiGitHubScannerTest(unittest.TestCase):
    def test_requires_delegation_label(self):
        module = load_watchdog_kakashi()

        # agent:kakashi + state:ready-for-dev → dispatched
        self.assertTrue(module.is_delegated_issue(issue_with_labels("agent:kakashi", "state:ready-for-dev")))
        # agent:kakashi without required state → not dispatched
        self.assertFalse(module.is_delegated_issue(issue_with_labels("agent:kakashi")))
        self.assertFalse(module.is_delegated_issue(issue_with_labels("type:bug", "priority:p1")))

    def test_state_gate_rejects_non_dev_states(self):
        module = load_watchdog_kakashi()

        # agent:kakashi + state:triage → NOT dispatched (not ready for dev)
        self.assertFalse(module.is_delegated_issue(issue_with_labels("agent:kakashi", "state:triage")))
        # agent:kakashi + state:ready-for-review → NOT dispatched
        self.assertFalse(module.is_delegated_issue(issue_with_labels("agent:kakashi", "state:ready-for-review")))
        # agent:kakashi + state:ready-for-test → NOT dispatched
        self.assertFalse(module.is_delegated_issue(issue_with_labels("agent:kakashi", "state:ready-for-test")))
        # agent:kakashi + state:in-progress → dispatched
        self.assertTrue(module.is_delegated_issue(issue_with_labels("agent:kakashi", "state:in-progress")))

    def test_respects_skip_labels(self):
        module = load_watchdog_kakashi()

        self.assertFalse(
            module.is_delegated_issue(issue_with_labels("agent:kakashi", "state:ready-for-dev", "state:blocked"))
        )
        self.assertFalse(
            module.is_delegated_issue(issue_with_labels("agent:kakashi", "state:ready-for-dev", "state:done"))
        )

    def test_regular_delegated_issue_dispatches_only_once(self):
        module = load_watchdog_kakashi()
        issue = issue_with_labels("agent:kakashi", "state:ready-for-dev")

        self.assertTrue(module.should_dispatch_issue(issue, set(), {}, now=1000))
        self.assertFalse(module.should_dispatch_issue(issue, {649}, {649: 1000}, now=999999))

    def test_batch_issue_redispatches_after_cooldown(self):
        # #793: REDISPATCH_LABELS defaults to empty; override via env for this test
        os.environ["AGENT_GITHUB_REDISPATCH_LABELS"] = "canonical-batch"
        module = load_watchdog_kakashi()
        issue = issue_with_labels("agent:kakashi", "state:ready-for-dev", "canonical-batch")

        self.assertFalse(module.should_dispatch_issue(issue, {649}, {649: 1000}, now=1000 + module.REDISPATCH_INTERVAL_SEC - 1))
        self.assertTrue(module.should_dispatch_issue(issue, {649}, {649: 1000}, now=1000 + module.REDISPATCH_INTERVAL_SEC))


if __name__ == "__main__":
    unittest.main()
