import importlib.util
import json
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "service_profiles.py"
spec = importlib.util.spec_from_file_location("service_profiles", MODULE_PATH)
service_profiles = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = service_profiles
spec.loader.exec_module(service_profiles)

CATALOG_PATH = Path(__file__).resolve().parents[1] / "docs" / "service-profiles.json"


def test_required_service_profiles_exist():
    catalog = service_profiles.load_service_profiles(CATALOG_PATH)

    assert catalog["default_profile"] == "prod-core"
    assert set(catalog["profiles"]) == {"prod-core", "prod-full", "staging-core", "qa-on-demand"}


def test_prod_core_is_lean_always_on_profile():
    profile = service_profiles.resolve_service_profile("prod-core", CATALOG_PATH)

    assert profile.enabled_connectors == frozenset({"telegram"})
    assert profile.enabled_optional_monitors == frozenset({"akamaru", "kiba"})
    assert profile.enabled_features == frozenset()
    assert profile.autostart_agents == ("naruto", "sasuke", "kiba")
    assert profile.infra_dependencies == ("postgresql.service",)
    assert "agent-kakashi.service" in profile.optional_services
    assert "konoha-testbench.service" in profile.optional_services


def test_prod_full_enables_sdd_lane_without_specialist_autostart():
    profile = service_profiles.resolve_service_profile("prod-full", CATALOG_PATH)

    assert {"kakashi", "shikadai"}.issubset(profile.enabled_optional_monitors)
    assert "kakashi" in profile.autostart_agents
    assert "shino" not in profile.autostart_agents
    assert "agent-managed@shino.service" in profile.optional_services


def test_staging_and_qa_profiles_keep_external_connectors_disabled():
    staging = service_profiles.resolve_service_profile("staging-core", CATALOG_PATH)
    qa = service_profiles.resolve_service_profile("qa-on-demand", CATALOG_PATH)

    assert staging.enabled_connectors == frozenset()
    assert qa.enabled_connectors == frozenset()
    assert staging.enabled_features == frozenset()
    assert qa.enabled_features == frozenset({"testbench"})
    assert staging.autostart_agents == ()
    assert qa.autostart_agents == ()
    assert qa.lifecycle_watchdog_agents == ("shino", "hinata", "guy", "ibiki")


def test_profile_catalog_json_has_no_duplicate_services():
    raw = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))

    for profile_id, profile in raw["profiles"].items():
        infra = profile["infra_dependencies"]
        required = profile["required_services"]
        optional = profile["optional_services"]
        features = profile["enabled_features"]
        assert "postgresql.service" in infra, profile_id
        assert len(infra) == len(set(infra)), profile_id
        assert len(required) == len(set(required)), profile_id
        assert len(optional) == len(set(optional)), profile_id
        assert len(features) == len(set(features)), profile_id
        assert not (set(infra) & set(required)), profile_id
        assert not (set(infra) & set(optional)), profile_id
        assert not (set(required) & set(optional)), profile_id
