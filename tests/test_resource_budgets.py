import importlib.util
import sys
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
MODULE_PATH = SCRIPTS_DIR / "resource_budgets.py"
spec = importlib.util.spec_from_file_location("resource_budgets", MODULE_PATH)
resource_budgets = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = resource_budgets
spec.loader.exec_module(resource_budgets)

CATALOG_PATH = Path(__file__).resolve().parents[1] / "docs" / "resource-budgets.json"


def test_required_budget_profiles_exist_and_map_to_service_profiles():
    raw = resource_budgets.load_resource_budgets(CATALOG_PATH)

    assert raw["default_budget_profile"] == "prod-core"
    assert set(raw["budget_profiles"]) == {"prod-core", "prod-full", "staging-core", "qa-on-demand", "ci-test"}
    assert raw["budget_profiles"]["prod-core"]["service_profile"] == "prod-core"
    assert raw["budget_profiles"]["staging-core"]["service_profile"] == "staging-core"
    assert raw["budget_profiles"]["ci-test"]["service_profile"] == "qa-on-demand"


def test_budget_contract_models_testbench_bounds_and_scale_out():
    raw = resource_budgets.load_resource_budgets(CATALOG_PATH)

    testbench = raw["systemd"]["units"]["konoha-testbench.service"]
    assert testbench["memory_max"] == "1200M"
    assert testbench["cpu_quota"] == "150%"
    assert testbench["concurrency"] == {"pool_size": 3, "max_pool_size": 3, "acquire_timeout_ms": 30000}
    assert raw["budget_profiles"]["staging-core"]["testbench"]["max_pool_size"] == 1
    assert "konoha-testbench.service" in raw["scale_out_policy"]["first_services_to_move"]


def test_systemd_budget_helpers_include_infra_and_disk_budgets():
    units = resource_budgets.systemd_budget_units(CATALOG_PATH)
    memory = resource_budgets.expected_memory_max_kib(CATALOG_PATH)
    disk = resource_budgets.disk_budget_kib_by_name(CATALOG_PATH)

    assert "redis-server.service" in units
    assert "postgresql.service" in units
    assert memory["konoha-testbench.service"] == 1200 * 1024
    assert memory["redis-server.service"] == 768 * 1024
    assert disk["playwright_cache"] == 2 * 1024 * 1024
