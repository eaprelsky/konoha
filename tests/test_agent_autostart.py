import importlib.util
import sys
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
MODULE_PATH = SCRIPTS_DIR / "agent-autostart.py"
spec = importlib.util.spec_from_file_location("agent_autostart", MODULE_PATH)
agent_autostart = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = agent_autostart
spec.loader.exec_module(agent_autostart)


def test_prod_core_autostart_selection_is_profile_bound():
    agents = [
        {"id": "naruto"},
        {"id": "sasuke"},
        {"id": "kiba"},
        {"id": "kakashi", "tags": ["autostart"]},
        {"id": "jiraiya", "tags": ["autostart"]},
    ]

    selected = agent_autostart.select_autostart_agents(agents, ("naruto", "sasuke", "kiba"))

    assert [agent["id"] for agent in selected] == ["naruto", "sasuke", "kiba"]


def test_jiraiya_is_not_in_legacy_boot_order():
    assert "jiraiya" not in agent_autostart.BOOT_ORDER


def test_profile_can_explicitly_enable_kakashi_autostart_without_legacy_tag_scan():
    agents = [
        {"id": "naruto"},
        {"id": "kakashi"},
        {"id": "shino", "tags": ["autostart"]},
    ]

    selected = agent_autostart.select_autostart_agents(agents, ("kakashi",))

    assert [agent["id"] for agent in selected] == ["kakashi"]
