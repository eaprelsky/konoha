import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def load_module(agent_id: str, labels: str, redispatch_labels: str):
    sys.path.insert(0, str(SCRIPTS))
    module_name = f"github_delegation_watchdog_{agent_id}"
    spec = importlib.util.spec_from_file_location(
        module_name, SCRIPTS / "github_delegation_watchdog.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    with patch.dict(os.environ, {
        "AGENT_ID": agent_id,
        "AGENT_GITHUB_DELEGATION_LABELS": labels,
        "AGENT_GITHUB_REDISPATCH_LABELS": redispatch_labels,
    }, clear=False):
        spec.loader.exec_module(module)
    return module


def issue_with_labels(*labels: str) -> dict:
    return {"number": 654, "title": "Architecture intake", "labels": [{"name": label} for label in labels]}


class GitHubDelegationWatchdogTest(unittest.TestCase):
    def test_architect_label_routes_to_shikadai(self):
        module = load_module("shikadai", "delegate:architect", "shikadai-batch")

        self.assertTrue(module.is_delegated_issue(issue_with_labels("delegate:architect")))
        self.assertFalse(module.is_delegated_issue(issue_with_labels("delegate:teamlead")))
        self.assertEqual(
            module.task_text(issue_with_labels("delegate:architect")),
            "shikadai:fix issue=654 title=Architecture intake",
        )

    def test_skip_labels_prevent_dispatch(self):
        module = load_module("shikadai", "delegate:architect", "shikadai-batch")

        self.assertFalse(
            module.is_delegated_issue(issue_with_labels("delegate:architect", "blocked"))
        )
        self.assertFalse(
            module.is_delegated_issue(issue_with_labels("delegate:architect", "delegate:done"))
        )

    def test_redispatch_requires_batch_label_and_cooldown(self):
        module = load_module("shikadai", "delegate:architect", "shikadai-batch")
        issue = issue_with_labels("delegate:architect", "shikadai-batch")

        self.assertFalse(module.should_dispatch_issue(issue, {654}, {654: 1000}, now=1000 + module.REDISPATCH_INTERVAL_SEC - 1))
        self.assertTrue(module.should_dispatch_issue(issue, {654}, {654: 1000}, now=1000 + module.REDISPATCH_INTERVAL_SEC))


if __name__ == "__main__":
    unittest.main()
