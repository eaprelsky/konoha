import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def load_module(agent_id: str, labels: str, redispatch_labels: str, required_states: str = ""):
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
        "AGENT_GITHUB_REQUIRED_STATES": required_states,
    }, clear=False):
        spec.loader.exec_module(module)
    return module


def load_shikadai_wrapper():
    sys.path.insert(0, str(SCRIPTS))
    for module_name in ("watchdog_shikadai_wrapper", "github_delegation_watchdog"):
        sys.modules.pop(module_name, None)
    spec = importlib.util.spec_from_file_location(
        "watchdog_shikadai_wrapper", SCRIPTS / "watchdog-shikadai.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    env_keys = [
        "AGENT_ID",
        "AGENT_DISPLAY_NAME",
        "AGENT_TMUX_SESSION",
        "AGENT_WAKE_TIMEOUT_SEC",
        "AGENT_GITHUB_DELEGATION_LABELS",
        "AGENT_GITHUB_REQUIRED_STATES",
        "AGENT_GITHUB_REDISPATCH_LABELS",
        "AGENT_GITHUB_TASK_VERB",
        "AGENT_GITHUB_TASK_TEMPLATE",
        "AGENT_BATCH_HEADER",
        "AGENT_BATCH_FOOTER",
    ]
    saved = {key: os.environ.pop(key, None) for key in env_keys}
    try:
        spec.loader.exec_module(module)
    finally:
        for key, value in saved.items():
            if value is not None:
                os.environ[key] = value
            else:
                os.environ.pop(key, None)
    return module


def load_kakashi_wrapper():
    sys.path.insert(0, str(SCRIPTS))
    for module_name in ("watchdog_kakashi_wrapper", "github_delegation_watchdog"):
        sys.modules.pop(module_name, None)
    spec = importlib.util.spec_from_file_location(
        "watchdog_kakashi_wrapper", SCRIPTS / "watchdog-kakashi.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    env_keys = [
        "AGENT_ID",
        "AGENT_DISPLAY_NAME",
        "AGENT_TMUX_SESSION",
        "AGENT_WAKE_TIMEOUT_SEC",
        "AGENT_GITHUB_DELEGATION_LABELS",
        "AGENT_GITHUB_REQUIRED_STATES",
        "AGENT_GITHUB_REDISPATCH_LABELS",
        "AGENT_GITHUB_TASK_VERB",
        "AGENT_BATCH_HEADER",
        "AGENT_BATCH_FOOTER",
    ]
    saved = {key: os.environ.pop(key, None) for key in env_keys}
    try:
        spec.loader.exec_module(module)
    finally:
        for key, value in saved.items():
            if value is not None:
                os.environ[key] = value
            else:
                os.environ.pop(key, None)
    return module


def issue_with_labels(*labels: str) -> dict:
    return {"number": 654, "title": "Architecture intake", "labels": [{"name": label} for label in labels]}


class GitHubDelegationWatchdogTest(unittest.TestCase):
    def test_shikadai_wrapper_defaults_to_review_route(self):
        module = load_shikadai_wrapper()

        self.assertEqual(module.DELEGATION_LABELS, {"agent:shikadai"})
        self.assertEqual(module.REQUIRED_STATES, {"state:ready-for-review"})
        self.assertEqual(module.TASK_TEMPLATE, "shikadai:review issue={number} title={title}")
        self.assertTrue(module.is_delegated_issue(issue_with_labels("agent:shikadai", "state:ready-for-review")))
        self.assertFalse(module.is_delegated_issue(issue_with_labels("agent:shikadai")))
        self.assertFalse(module.is_delegated_issue(issue_with_labels("agent:shikadai", "route:architecture-decomposition", "type:architecture")))

    def test_kakashi_wrapper_wakes_on_delegated_github_work(self):
        module = load_kakashi_wrapper()

        self.assertEqual(module.DELEGATION_LABELS, {"agent:kakashi"})
        self.assertEqual(module.REQUIRED_STATES, {"state:ready-for-dev", "state:in-progress"})
        self.assertEqual(module._b.WAKE_TIMEOUT_SEC, 120)
        self.assertTrue(module.is_delegated_issue(issue_with_labels("agent:kakashi", "state:ready-for-dev")))

    def test_review_route_requires_shikadai_and_ready_for_review(self):
        module = load_module(
            "shikadai",
            "agent:shikadai",
            "",
            required_states="state:ready-for-review",
        )

        self.assertTrue(module.is_delegated_issue(issue_with_labels("agent:shikadai", "state:ready-for-review")))
        self.assertFalse(module.is_delegated_issue(issue_with_labels("agent:shikadai")))
        self.assertFalse(module.is_delegated_issue(issue_with_labels("state:ready-for-review")))
        self.assertFalse(module.is_delegated_issue(issue_with_labels("agent:shikadai", "type:architecture")))
        self.assertFalse(module.is_delegated_issue(issue_with_labels("agent:kakashi")))
        self.assertEqual(
            module.task_text(issue_with_labels("agent:shikadai", "state:ready-for-review")),
            "shikadai:fix issue=654 title=Architecture intake",
        )

    def test_skip_labels_prevent_dispatch(self):
        module = load_module(
            "shikadai",
            "agent:shikadai",
            "",
            required_states="state:ready-for-review",
        )

        self.assertFalse(
            module.is_delegated_issue(issue_with_labels("agent:shikadai", "state:ready-for-review", "state:blocked"))
        )
        self.assertFalse(
            module.is_delegated_issue(issue_with_labels("agent:shikadai", "state:ready-for-review", "state:done"))
        )

    def test_redispatch_requires_batch_label_and_cooldown(self):
        module = load_module("shikadai", "agent:shikadai", "manual-redispatch")
        issue = issue_with_labels("agent:shikadai", "manual-redispatch")

        self.assertFalse(module.should_dispatch_issue(issue, {654}, {654: 1000}, now=1000 + module.REDISPATCH_INTERVAL_SEC - 1))
        self.assertTrue(module.should_dispatch_issue(issue, {654}, {654: 1000}, now=1000 + module.REDISPATCH_INTERVAL_SEC))

    def test_auto_push_does_not_restart_core_by_default(self):
        module = load_module("kakashi", "agent:kakashi", "")

        self.assertEqual(module.AUTO_PUSH_RESTART_UNIT, "")


if __name__ == "__main__":
    unittest.main()
