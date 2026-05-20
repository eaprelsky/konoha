import importlib.util
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from argparse import Namespace
from datetime import timedelta
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "sdd-worker-pool.py"
spec = importlib.util.spec_from_file_location("sdd_worker_pool", MODULE_PATH)
sdd_worker_pool = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = sdd_worker_pool
spec.loader.exec_module(sdd_worker_pool)

CONFIG_PATH = Path(__file__).resolve().parents[1] / "docs" / "sdd-worker-pool.json"


class RecordingHandler(BaseHTTPRequestHandler):
    requests: list[str] = []

    def do_POST(self):
        self.__class__.requests.append(self.path)
        if self.path.startswith("/agents/"):
            threading.Event().wait(0.2)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, format, *args):
        return


def test_pool_contract_keeps_specialists_optional_and_bounded():
    config = sdd_worker_pool.load_config(CONFIG_PATH)

    assert config["max_active_workers"] == 2
    assert config["max_active_specialists"] == 1
    assert config["idle_timeout_sec"] == 1800
    assert config["workers"]["kakashi"]["default_path"] is True
    for agent in ["guy", "shino", "hinata", "ibiki"]:
        assert config["workers"][agent]["default_path"] is False
        assert config["workers"][agent]["mcp_allowlist"] == ["konoha"]
        assert config["workers"][agent]["memory_max"] == "900M"
        assert config["workers"][agent]["cpu_quota"] == "150%"
    assert config["workers"]["hinata"]["testbench"] is True
    assert config["testbench"]["mode"] == "on-demand"


def test_pool_rejects_second_active_specialist():
    config = sdd_worker_pool.load_config(CONFIG_PATH)
    now = sdd_worker_pool.utcnow()
    state = {
        "schema_version": 1,
        "active": [{
            "agent": "guy",
            "role": "mechanical_helper",
            "mission": "issue-1",
            "requester": "kakashi",
            "started_at": sdd_worker_pool.iso(now),
            "expires_at": sdd_worker_pool.iso(now + timedelta(seconds=600)),
            "status": "active",
        }],
    }

    try:
        sdd_worker_pool.assert_can_start(config, state, "shino", now)
    except ValueError as exc:
        assert "specialist lane is full" in str(exc)
    else:
        raise AssertionError("expected concurrency rejection")


def test_pool_allows_developer_plus_one_specialist():
    config = sdd_worker_pool.load_config(CONFIG_PATH)
    now = sdd_worker_pool.utcnow()
    state = {
        "schema_version": 1,
        "active": [{
            "agent": "kakashi",
            "role": "developer",
            "mission": "issue-1",
            "requester": "github",
            "started_at": sdd_worker_pool.iso(now),
            "expires_at": sdd_worker_pool.iso(now + timedelta(seconds=600)),
            "status": "active",
        }],
    }

    sdd_worker_pool.assert_can_start(config, state, "guy", now)


def test_start_dry_run_is_auditable_and_does_not_write_state(monkeypatch, tmp_path):
    state_path = tmp_path / "state.json"
    monkeypatch.setenv("KONOHA_SDD_WORKER_POOL_STATE", str(state_path))

    result = sdd_worker_pool.start_worker(Namespace(
        agent="guy",
        mission="issue-791-docs",
        requester="kakashi",
        role=None,
        reason="mechanical docs",
        ttl_sec=None,
        dry_run=True,
    ))

    assert result["ok"] is True
    assert state_path.exists() is False
    message_action = result["actions"][1]
    assert message_action["path"] == "/messages"
    assert message_action["body"]["type"] == "task"
    assert "SDD_POOL_START" in message_action["body"]["text"]
    assert "mission=issue-791-docs" in message_action["body"]["text"]


def test_concurrent_specialist_start_is_serialized_by_state_lock(tmp_path):
    state_path = tmp_path / "state.json"
    RecordingHandler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = os.environ.copy()
    env["KONOHA_SDD_WORKER_POOL_STATE"] = str(state_path)
    env["KONOHA_URL"] = f"http://127.0.0.1:{server.server_port}"
    env["KONOHA_TOKEN"] = ""
    common_args = ["--requester", "kakashi", "--reason", "concurrent regression"]
    commands = [
        [sys.executable, str(MODULE_PATH), "start", "guy", "--mission", "issue-791-guy", *common_args],
        [sys.executable, str(MODULE_PATH), "start", "shino", "--mission", "issue-791-shino", *common_args],
    ]

    try:
        procs = [
            subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for command in commands
        ]
        results = [proc.communicate(timeout=10) + (proc.returncode,) for proc in procs]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    return_codes = sorted(result[2] for result in results)
    combined_errors = "\n".join(result[1] for result in results)
    assert return_codes == [0, 2]
    assert "specialist lane is full" in combined_errors
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert len(state["active"]) == 1
    assert state["active"][0]["agent"] in {"guy", "shino"}
    assert sum(1 for path in RecordingHandler.requests if path.startswith("/agents/")) == 1


def test_status_prunes_expired_state(monkeypatch, tmp_path):
    config = sdd_worker_pool.load_config(CONFIG_PATH)
    state_path = tmp_path / "state.json"
    monkeypatch.setenv("KONOHA_SDD_WORKER_POOL_STATE", str(state_path))
    now = sdd_worker_pool.utcnow()
    state_path.write_text(json.dumps({
        "schema_version": 1,
        "active": [{
            "agent": "guy",
            "role": "mechanical_helper",
            "mission": "issue-old",
            "requester": "kakashi",
            "started_at": sdd_worker_pool.iso(now - timedelta(seconds=3600)),
            "expires_at": sdd_worker_pool.iso(now - timedelta(seconds=1)),
            "status": "active",
            "service": config["workers"]["guy"]["service"],
            "mcp_allowlist": ["konoha"],
            "testbench": False,
        }],
        "history": [],
    }), encoding="utf-8")

    result = sdd_worker_pool.status(Namespace(dry_run=False))

    assert result["active"] == []
    assert result["expired"][0]["status"] == "expired"
    saved = json.loads(state_path.read_text(encoding="utf-8"))
    assert saved["active"] == []
    assert saved["history"][0]["mission"] == "issue-old"


def test_reap_dry_run_sends_auditable_stop_before_lifecycle_stop(monkeypatch, tmp_path):
    config = sdd_worker_pool.load_config(CONFIG_PATH)
    state_path = tmp_path / "state.json"
    monkeypatch.setenv("KONOHA_SDD_WORKER_POOL_STATE", str(state_path))
    now = sdd_worker_pool.utcnow()
    state_path.write_text(json.dumps({
        "schema_version": 1,
        "active": [{
            "agent": "shino",
            "role": "qa_lead",
            "mission": "issue-old",
            "requester": "shikadai",
            "started_at": sdd_worker_pool.iso(now - timedelta(seconds=3600)),
            "expires_at": sdd_worker_pool.iso(now - timedelta(seconds=1)),
            "status": "active",
            "service": config["workers"]["shino"]["service"],
            "mcp_allowlist": ["konoha"],
            "testbench": False,
        }],
        "history": [],
    }), encoding="utf-8")

    result = sdd_worker_pool.reap(Namespace(dry_run=True))

    assert result["actions"][0]["path"] == "/messages"
    assert result["actions"][0]["body"]["type"] == "status"
    assert "SDD_POOL_STOP" in result["actions"][0]["body"]["text"]
    assert result["actions"][1]["path"] == "/agents/shino/stop"


def test_rollback_dry_run_is_auditable(monkeypatch, tmp_path):
    config = sdd_worker_pool.load_config(CONFIG_PATH)
    state_path = tmp_path / "state.json"
    monkeypatch.setenv("KONOHA_SDD_WORKER_POOL_STATE", str(state_path))
    now = sdd_worker_pool.utcnow()
    state_path.write_text(json.dumps({
        "schema_version": 1,
        "active": [{
            "agent": "guy",
            "role": "mechanical_helper",
            "mission": "issue-active",
            "requester": "kakashi",
            "started_at": sdd_worker_pool.iso(now),
            "expires_at": sdd_worker_pool.iso(now + timedelta(seconds=600)),
            "status": "active",
            "service": config["workers"]["guy"]["service"],
            "mcp_allowlist": ["konoha"],
            "testbench": False,
        }],
        "history": [],
    }), encoding="utf-8")

    result = sdd_worker_pool.rollback(Namespace(reason="operator rollback", dry_run=True))

    assert result["actions"][0]["path"] == "/messages"
    assert "SDD_POOL_STOP" in result["actions"][0]["body"]["text"]
    assert "reason=operator rollback" in result["actions"][0]["body"]["text"]
    assert result["actions"][1]["path"] == "/agents/guy/stop"
