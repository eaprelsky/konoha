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

    assert raw["updated_for_issue"] == 773
    assert raw["default_budget_profile"] == "prod-core"
    assert set(raw["budget_profiles"]) == {"prod-core", "prod-full", "staging-core", "qa-on-demand", "ci-test"}
    assert raw["budget_profiles"]["prod-core"]["service_profile"] == "prod-core"
    assert raw["budget_profiles"]["staging-core"]["service_profile"] == "staging-core"
    assert raw["budget_profiles"]["ci-test"]["service_profile"] == "qa-on-demand"


def test_budget_contract_models_testbench_bounds_and_scale_out():
    raw = resource_budgets.load_resource_budgets(CATALOG_PATH)

    testbench = raw["systemd"]["units"]["konoha-testbench.service"]
    assert testbench["memory_max"] == "768M"
    assert testbench["cpu_quota"] == "100%"
    assert testbench["concurrency"] == {
        "mode": "on-demand",
        "pool_size": 1,
        "max_pool_size": 2,
        "max_concurrent_jobs": 2,
        "acquire_timeout_ms": 20000,
        "request_timeout_ms": 30000,
        "session_ttl_ms": 300000,
    }
    assert raw["budget_profiles"]["staging-core"]["testbench"]["default"] == "disabled"
    assert "konoha-testbench.service" in raw["scale_out_policy"]["first_services_to_move"]


def test_systemd_budget_helpers_include_infra_and_disk_budgets():
    units = resource_budgets.systemd_budget_units(CATALOG_PATH)
    memory = resource_budgets.expected_memory_max_kib(CATALOG_PATH)
    disk = resource_budgets.disk_budget_kib_by_name(CATALOG_PATH)

    assert "redis-server.service" in units
    assert "postgresql.service" in units
    assert memory["konoha-testbench.service"] == 768 * 1024
    assert memory["redis-server.service"] == 768 * 1024
    assert disk["playwright_cache"] == 2 * 1024 * 1024


def test_transient_scope_and_staging_dropin_policies_are_modeled():
    scopes = resource_budgets.transient_scope_policies(CATALOG_PATH)
    dropins = resource_budgets.profile_dropin_policies(CATALOG_PATH)

    assert scopes["mcp_heavy_pack_scope"]["memory_max"] == "384M"
    assert scopes["mcp_heavy_pack_scope"]["cpu_quota"] == "50%"
    assert scopes["mcp_low_pack_scope"]["memory_max"] == "256M"
    assert dropins["staging-core"]["konoha.service"]["path"] == "systemd/dropins/staging-core-konoha.conf"
    assert dropins["staging-core"]["konoha.service"]["memory_max"] == "900M"


def test_host_capacity_reserves_required_non_konoha_services():
    raw = resource_budgets.load_resource_budgets(CATALOG_PATH)
    model = resource_budgets.host_capacity_model(CATALOG_PATH)
    accounting = resource_budgets.host_profile_accounting(CATALOG_PATH)
    reservations = {item["id"]: item for item in model["reservations"]}

    assert model["updated_for_issue"] == 773
    assert model["non_konoha_reserved_memory_mib"] == sum(item["memory_reserve_mib"] for item in reservations.values())
    assert model["non_konoha_reserved_cpu_percent"] == sum(item["cpu_reserve_percent"] for item in reservations.values())
    assert reservations["shared_mail_stack"]["classification"] == "required"
    assert reservations["shared_mail_stack"]["memory_reserve_mib"] == 768
    assert reservations["shared_mail_stack"]["removal_policy"] == "do_not_remove_in_lean_konoha_cleanup"
    assert reservations["docker_runtime"]["classification"] == "required_for_mail_stack"
    assert {item["id"] for item in model["optional_cleanup_candidates"]} == {"unused_docker_images", "stale_host_logs"}
    assert {item["id"] for item in model["externalization_candidates"]} == {"shared_mail_stack", "docker_runtime"}
    assert model["live_baseline_sample"]["group"] == "docker_mail_stack"
    assert model["live_baseline_sample"]["rss_kib"] > 0

    for profile_id, profile in raw["budget_profiles"].items():
        row = accounting[profile_id]
        assert row["konoha_memory_max_mib"] == profile["memory_max_mib"]
        assert row["konoha_cpu_quota_percent"] == profile["cpu_quota_percent"]
        assert row["reserved_memory_mib"] == model["non_konoha_reserved_memory_mib"]
        assert row["reserved_cpu_percent"] == model["non_konoha_reserved_cpu_percent"]
        assert row["planned_total_memory_mib"] <= model["planning_host_memory_mib"]
        assert row["planned_total_cpu_percent"] <= model["planning_host_cpu_percent"]
