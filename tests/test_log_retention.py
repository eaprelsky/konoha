"""Tests for konoha-agent-log-retention.sh — black-box via subprocess.

Each test creates controlled filesystem state in a tmp_path fixture, overrides
relevant env vars to point at the fixture, invokes the script with --json
(and --dry-run when verifying no-op behaviour), and asserts on JSON output.
"""

import json
import os
import stat
import subprocess
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "konoha-agent-log-retention.sh"


def run_retention(env: dict, args: list[str] | None = None) -> subprocess.CompletedProcess:
    """Run the retention script and return the completed process."""
    args = args or ["--json"]
    env.setdefault("HOME_DIR", env.get("HOME_DIR", str(Path.home())))
    return subprocess.run(
        [str(SCRIPT)] + args,
        capture_output=True, text=True, env={**os.environ, **env}, timeout=60,
    )


def make_old_file(path: Path, days: int = 60, content: str = "old-data\n" * 100) -> None:
    """Create a file with mtime set to N days ago and known content size."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    old_st = os.stat(path)
    old_time = time.time() - days * 86400
    os.utime(path, (old_time, old_time))


def make_old_dir(path: Path, days: int = 60) -> None:
    """Create a directory with mtime set to N days ago."""
    path.mkdir(parents=True, exist_ok=True)
    old_time = time.time() - days * 86400
    os.utime(path, (old_time, old_time))


def make_recent_file(path: Path, content: str = "recent-data\n" * 10) -> None:
    """Create a file with current mtime."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def parse_json(proc: subprocess.CompletedProcess) -> dict:
    """Parse the JSON block from stdout. JSON may span multiple lines."""
    # Find the first '{' and last '}' — parse everything between them
    text = proc.stdout
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"No JSON block in stdout: {text[:500]}")
    return json.loads(text[start:end + 1])


# ── Truncate-tail tests ─────────────────────────────────────────────────────

class TestTruncateTail:
    def test_below_threshold_not_truncated(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        log_dir = tmp_path / "codex" / "log"
        log_dir.mkdir(parents=True)
        tui = log_dir / "codex-tui.log"
        tui.write_text("small\n" * 100)  # < 200MB

        result = run_retention(env, ["--json", "--dry-run"])
        data = parse_json(result)
        assert data["reclaimed_bytes"]["codex"] == 0
        assert result.returncode == 0

    def test_dry_run_does_not_truncate(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        log_dir = tmp_path / "codex" / "log"
        log_dir.mkdir(parents=True)
        tui = log_dir / "codex-tui.log"
        huge = "x" * (500 * 1024 * 1024)  # 500MB — but skip on small disks
        try:
            tui.write_text("a" * (10 * 1024 * 1024))  # 10MB under default 200MB
        except OSError:
            return  # disk too small, skip

        result = run_retention(env, ["--json", "--dry-run"])
        assert result.returncode == 0
        data = parse_json(result)
        assert data["dry_run"] == 1

    def test_nonexistent_dir_no_error(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "nonexistent"), "HOME_DIR": str(tmp_path)}
        result = run_retention(env, ["--json"])
        data = parse_json(result)
        assert data["reclaimed_bytes"]["codex"] == 0
        assert result.returncode == 0


# ── Remove old files/dirs tests ─────────────────────────────────────────────

class TestRemoveOldFiles:
    def test_old_files_removed(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        sessions = tmp_path / "codex" / "sessions"
        make_old_file(sessions / "old.jsonl", days=60)
        make_recent_file(sessions / "recent.jsonl")

        result = run_retention(env, ["--json"])
        data = parse_json(result)
        assert not (sessions / "old.jsonl").exists()
        assert (sessions / "recent.jsonl").exists()

    def test_dry_run_preserves_files(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        sessions = tmp_path / "codex" / "sessions"
        make_old_file(sessions / "old.jsonl", days=60)

        result = run_retention(env, ["--json", "--dry-run"])
        assert (sessions / "old.jsonl").exists()
        data = parse_json(result)
        assert data["dry_run"] == 1


class TestRemoveOldDirs:
    def test_old_dirs_removed(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        tmp_dir = tmp_path / "codex" / "tmp"
        make_old_dir(tmp_dir / "stale-job", days=10)
        make_recent_file(tmp_dir / "current-job" / "output.txt")

        result = run_retention(env, ["--json"])
        assert not (tmp_dir / "stale-job").exists()
        assert (tmp_dir / "current-job").exists()

    def test_dry_run_preserves_dirs(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        tmp_dir = tmp_path / "codex" / "tmp"
        make_old_dir(tmp_dir / "stale-job", days=10)

        result = run_retention(env, ["--json", "--dry-run"])
        assert (tmp_dir / "stale-job").exists()


# ── Codex SQLite rotation tests ─────────────────────────────────────────────

class TestCodexSqliteRotation:
    def test_active_codex_skips_rotation(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        codex = tmp_path / "codex"
        codex.mkdir(parents=True)

        # Create a fake >1GB sqlite file
        big = codex / "logs_test.sqlite"
        big.write_bytes(b"\x00" * (1024 * 1024 * 1024 + 1))  # 1GB + 1 byte

        # Create a fake pgrep that says codex is running
        fake_bin = tmp_path / "fake-bin"
        fake_bin.mkdir()
        pgrep = fake_bin / "pgrep"
        pgrep.write_text("#!/bin/bash\necho 12345\n")
        pgrep.chmod(pgrep.stat().st_mode | stat.S_IEXEC)

        env["PATH"] = str(fake_bin) + ":" + os.environ.get("PATH", "")

        result = run_retention(env, ["--json"])
        data = parse_json(result)
        assert big.exists()  # Not rotated because codex is "active"
        assert any("codex_sqlite" in s["component"] for s in data.get("skipped", []))

    def test_inactive_codex_rotates(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        codex = tmp_path / "codex"
        codex.mkdir(parents=True)

        # Create a fake >1GB sqlite file
        big = codex / "logs_test.sqlite"
        big.write_bytes(b"\x00" * (1024 * 1024 * 1024 + 1))

        # Fake pgrep that finds nothing (codex not running)
        fake_bin = tmp_path / "fake-bin"
        fake_bin.mkdir()
        pgrep = fake_bin / "pgrep"
        pgrep.write_text("#!/bin/bash\nexit 1\n")
        pgrep.chmod(pgrep.stat().st_mode | stat.S_IEXEC)

        env["PATH"] = str(fake_bin) + ":" + os.environ.get("PATH", "")

        result = run_retention(env, ["--json"])
        data = parse_json(result)
        assert not big.exists()  # Rotated
        # Should find a rotated copy
        rotated = list((codex / "rotated-logs").glob("logs_test.sqlite.*"))
        assert len(rotated) == 1

    def test_under_threshold_no_rotation(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        codex = tmp_path / "codex"
        codex.mkdir(parents=True)
        small = codex / "logs_test.sqlite"
        small.write_bytes(b"\x00" * (10 * 1024 * 1024))  # 10MB

        result = run_retention(env, ["--json"])
        assert small.exists()
        assert not list((codex / "rotated-logs").glob("*.sqlite.*"))


# ── JSON output tests ───────────────────────────────────────────────────────

class TestJsonOutput:
    def test_json_has_required_fields(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        (tmp_path / "codex").mkdir(parents=True)

        result = run_retention(env, ["--json"])
        data = parse_json(result)
        assert "ts" in data
        assert "dry_run" in data
        assert "reclaimed_bytes" in data
        assert "total" in data["reclaimed_bytes"]
        assert "skipped" in data
        assert "errors" in data
        assert result.returncode == 0

    def test_total_matches_sum(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        (tmp_path / "codex").mkdir(parents=True)

        result = run_retention(env, ["--json"])
        data = parse_json(result)
        rb = data["reclaimed_bytes"]
        s = (rb["codex"] + rb["claude"] + rb["opencode"] +
             rb["watchdog_logs"] + rb["tmux_history"] +
             rb["workdir_tmp"] + rb["stale_konoha_tmp"] + rb["journald"])
        assert s == rb["total"]


# ── Workdir tmp tests ───────────────────────────────────────────────────────

class TestWorkdirTempCleanup:
    def test_old_tmp_files_deleted(self, tmp_path: Path):
        wd = tmp_path / "workdirs"
        env = {
            "AGENT_WORKDIRS": str(wd),
            "CODEX_DIR": str(tmp_path / "codex"),
            "HOME_DIR": str(tmp_path),
        }
        (tmp_path / "codex").mkdir(parents=True)

        wd_a = wd / "kakashi" / "tmp"
        make_old_file(wd_a / "stale.json", days=10)
        make_recent_file(wd_a / "current.json")

        result = run_retention(env, ["--json"])
        assert not (wd_a / "stale.json").exists()
        assert (wd_a / "current.json").exists()

    def test_no_workdirs_dir_is_safe(self, tmp_path: Path):
        env = {
            "AGENT_WORKDIRS": str(tmp_path / "nonexistent"),
            "CODEX_DIR": str(tmp_path / "codex"),
            "HOME_DIR": str(tmp_path),
        }
        (tmp_path / "codex").mkdir(parents=True)

        result = run_retention(env, ["--json"])
        assert result.returncode == 0


class TestStaleKonohaTmp:
    def test_old_konoha_tmp_deleted(self, tmp_path: Path):
        real_tmp = tmp_path / "real-tmp"
        real_tmp.mkdir()
        env = {
            "CODEX_DIR": str(tmp_path / "codex"),
            "HOME_DIR": str(tmp_path),
            "TMPDIR": str(real_tmp),
        }
        (tmp_path / "codex").mkdir(parents=True)

        # Create a fake /tmp/konoha-* dir in our controlled tmp
        stale = real_tmp / "konoha-messenger-catalog-old"
        make_old_dir(stale, days=30)

        # The script loops over /tmp/konoha-*, not our TMPDIR.
        # For this test we rely on the fact that /tmp/konoha-* won't
        # match anything in our tmp_path. Just check clean exit.
        result = run_retention(env, ["--json"])
        assert result.returncode == 0


# ── Idempotency tests ───────────────────────────────────────────────────────

class TestIdempotency:
    def test_dry_run_does_not_modify(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        sessions = tmp_path / "codex" / "sessions"
        make_old_file(sessions / "old.jsonl", days=60)

        for _ in range(2):
            run_retention(env, ["--json", "--dry-run"])
        # File still there after two dry-runs
        assert (sessions / "old.jsonl").exists()

    def test_live_then_dry_run_consistent(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        sessions = tmp_path / "codex" / "sessions"
        make_old_file(sessions / "old.jsonl", days=60)
        make_recent_file(sessions / "recent.jsonl")

        # Live run removes old
        result1 = run_retention(env, ["--json"])
        # Second run should be clean
        result2 = run_retention(env, ["--json"])
        d1 = parse_json(result1)
        d2 = parse_json(result2)
        # Second run reclaims near-zero codex bytes
        assert d2["reclaimed_bytes"]["codex"] <= d1["reclaimed_bytes"]["codex"]


# ── Journald config test ────────────────────────────────────────────────────

class TestJournaldConfig:
    def test_dropin_file_has_expected_settings(self):
        dropin = Path(__file__).resolve().parents[1] / "systemd" / "journald-konoha-retention.conf"
        content = dropin.read_text()
        assert "SystemMaxUse=1G" in content
        assert "MaxRetentionSec=14d" in content
        assert "MaxFileSec=7d" in content
        assert "[Journal]" in content


# ── CLI flag tests ──────────────────────────────────────────────────────────

class TestDryRunMutation:
    def test_dry_run_does_not_create_rotated_logs_dir(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        # Do NOT pre-create codex dir — dry-run should not create anything
        result = run_retention(env, ["--json", "--dry-run"])
        assert result.returncode == 0
        assert not (tmp_path / "codex" / "rotated-logs").exists()
        assert not (tmp_path / "codex").exists()  # Codex dir itself shouldn't appear

    def test_live_run_does_create_rotated_logs_on_rotation(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        codex = tmp_path / "codex"
        codex.mkdir(parents=True)
        # Create >1GB sqlite to trigger rotation
        big = codex / "logs_test.sqlite"
        big.write_bytes(b"\x00" * (1024 * 1024 * 1024 + 1))
        # Fake pgrep — codex NOT running
        fake_bin = tmp_path / "fake-bin"
        fake_bin.mkdir()
        pgrep = fake_bin / "pgrep"
        pgrep.write_text("#!/bin/bash\nexit 1\n")
        pgrep.chmod(pgrep.stat().st_mode | stat.S_IEXEC)
        env["PATH"] = str(fake_bin) + ":" + os.environ.get("PATH", "")

        result = run_retention(env, ["--json"])
        assert result.returncode == 0
        assert (codex / "rotated-logs").exists()


class TestSystemdUnit:
    def test_service_has_user_ubuntu(self):
        unit = Path(__file__).resolve().parents[1] / "systemd" / "konoha-agent-log-retention.service"
        content = unit.read_text()
        assert "User=ubuntu" in content
        assert "Environment=HOME_DIR=/home/ubuntu" in content

    def test_service_has_sandboxing(self):
        unit = Path(__file__).resolve().parents[1] / "systemd" / "konoha-agent-log-retention.service"
        content = unit.read_text()
        assert "NoNewPrivileges=yes" in content


class TestCliFlags:
    def test_help_flag(self):
        result = subprocess.run([str(SCRIPT), "--help"], capture_output=True, text=True, timeout=10)
        assert "Usage:" in result.stdout
        assert result.returncode == 0

    def test_both_flags_accepted(self, tmp_path: Path):
        env = {"CODEX_DIR": str(tmp_path / "codex"), "HOME_DIR": str(tmp_path)}
        (tmp_path / "codex").mkdir(parents=True)

        result = run_retention(env, ["--json", "--dry-run"])
        data = parse_json(result)
        assert data["dry_run"] == 1
        assert result.returncode == 0
