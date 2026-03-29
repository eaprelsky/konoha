#!/usr/bin/env python3
"""
Claude Code update checker with release notes analysis.
Checks for new version, updates if needed, sends Telegram summary.
"""
import subprocess
import json
import os
import sys
import urllib.request
import urllib.error

STATE_FILE = "/tmp/claude-last-known-version"
OWNER_ID = os.environ.get("OWNER_TG_ID", "")  # set in .owner-config

def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, shell=True, **kwargs)

def send_tg(text):
    run(f'python3 /home/ubuntu/tg-send.py {OWNER_ID} {json.dumps(text)}')

def get_installed_version():
    r = run("claude --version 2>/dev/null || ~/.npm-global/bin/claude --version 2>/dev/null")
    for line in r.stdout.splitlines():
        parts = line.split()
        if parts:
            return parts[0]
    return None

def get_latest_version():
    r = run("npm show @anthropic-ai/claude-code version 2>/dev/null")
    return r.stdout.strip()

def get_last_known_version():
    try:
        with open(STATE_FILE) as f:
            return f.read().strip()
    except FileNotFoundError:
        return None

def save_last_known_version(v):
    with open(STATE_FILE, "w") as f:
        f.write(v)

def fetch_releases():
    url = "https://api.github.com/repos/anthropics/claude-code/releases?per_page=20"
    req = urllib.request.Request(url, headers={"User-Agent": "claude-agent"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

def parse_version(v):
    return tuple(int(x) for x in v.lstrip("v").split(".") if x.isdigit())

def analyze_notes(releases, from_ver, to_ver):
    """Extract release notes between from_ver and to_ver (inclusive of to_ver, exclusive of from_ver)."""
    from_t = parse_version(from_ver)
    to_t = parse_version(to_ver)

    relevant = []
    for r in releases:
        v = parse_version(r["tag_name"])
        if from_t < v <= to_t:
            relevant.append((r["tag_name"], r.get("body", "")))

    if not relevant:
        return None

    # Extract bullet points relevant to our infrastructure
    keywords = [
        "hook", "mcp", "agent", "compact", "compaction", "memory", "background",
        "task", "stream", "timeout", "bare", "channel", "loop", "cron",
        "fix", "Fixed", "leak", "crash", "hang", "stuck", "duplicate",
        "headless", "subprocess", "redis", "worktree"
    ]

    important = []
    fixes = []
    new_features = []

    for tag, body in relevant:
        for line in body.splitlines():
            line = line.strip().lstrip("- ").strip()
            if not line:
                continue
            line_lower = line.lower()
            if any(kw.lower() in line_lower for kw in keywords):
                if line_lower.startswith("fixed") or "fix" in line_lower[:10]:
                    fixes.append(f"[{tag}] {line}")
                else:
                    new_features.append(f"[{tag}] {line}")

    return new_features, fixes

def do_update():
    r = run("npm i -g @anthropic-ai/claude-code 2>&1")
    if r.returncode != 0:
        r = run("sudo npm i -g @anthropic-ai/claude-code 2>&1")
    return r.returncode == 0

def main():
    latest = get_latest_version()
    if not latest:
        print("Could not fetch latest version")
        sys.exit(1)

    installed = get_installed_version()
    last_known = get_last_known_version()

    print(f"installed={installed} latest={latest} last_known={last_known}")

    if installed == latest:
        # Already up to date
        if last_known != latest:
            save_last_known_version(latest)
        print("Already up to date")
        sys.exit(0)

    # New version available — update
    from_ver = installed or last_known or "2.0.0"
    print(f"Updating {from_ver} -> {latest}")

    ok = do_update()
    new_installed = get_installed_version()

    if not ok or new_installed != latest:
        send_tg(f"Claude Code: не удалось обновить {from_ver} → {latest}. Нужно вмешательство.")
        sys.exit(1)

    # Fetch and analyze release notes
    try:
        releases = fetch_releases()
        result = analyze_notes(releases, from_ver, latest)
    except Exception as e:
        send_tg(f"Claude Code обновлён: {from_ver} → {latest}\n(release notes: ошибка получения: {e})")
        save_last_known_version(latest)
        sys.exit(0)

    new_features, fixes = result if result else ([], [])

    lines = [f"Claude Code обновлён: {from_ver} → {latest}"]

    if new_features:
        lines.append("\nЧто нового (для нас):")
        for f in new_features[:6]:
            lines.append(f"+ {f}")

    if fixes:
        lines.append("\nФиксы (для нас):")
        for f in fixes[:6]:
            lines.append(f"• {f}")

    if not new_features and not fixes:
        lines.append("Изменений, актуальных для нашей инфры, не найдено.")

    send_tg("\n".join(lines))
    save_last_known_version(latest)

if __name__ == "__main__":
    main()
