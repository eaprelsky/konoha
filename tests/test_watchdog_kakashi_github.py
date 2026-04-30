import importlib.util
import sys
import unittest
from pathlib import Path


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
    return {"labels": [{"name": label} for label in labels]}


class KakashiGitHubScannerTest(unittest.TestCase):
    def test_requires_delegation_label(self):
        module = load_watchdog_kakashi()

        self.assertTrue(module.is_delegated_issue(issue_with_labels("delegate:teamlead")))
        self.assertFalse(module.is_delegated_issue(issue_with_labels("bug", "P1")))

    def test_respects_skip_labels(self):
        module = load_watchdog_kakashi()

        self.assertFalse(
            module.is_delegated_issue(issue_with_labels("delegate:teamlead", "blocked"))
        )
        self.assertFalse(
            module.is_delegated_issue(issue_with_labels("delegate:teamlead", "delegate:done"))
        )


if __name__ == "__main__":
    unittest.main()
