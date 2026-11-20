#!/usr/bin/env python3

from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "bin" / "agy-plugin.ts"

CSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
OSC_RE = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)")


class VirtualScreen:
    def __init__(self, cols: int, rows: int) -> None:
        self.cols = cols
        self.rows = rows
        self.row = 0
        self.col = 0
        self.grid: list[list[str]] = [[" "] * cols for _ in range(rows)]
        self.alt_entered = False
        self.alt_exited = False
        self.sync_frames = 0
        self._buf = ""

    def resize(self, cols: int, rows: int) -> None:
        self.cols = cols
        self.rows = rows
        self.grid = [[" "] * cols for _ in range(rows)]
        self.row = 0
        self.col = 0

    def feed(self, text: str) -> None:
        self._buf += text
        i = 0
        s = self._buf
        n = len(s)
        while i < n:
            ch = s[i]
            if ch == "\x1b":
                if i + 1 >= n:
                    break
                nxt = s[i + 1]
                if nxt == "[":
                    j = i + 2
                    while j < n and not ("@" <= s[j] <= "~"):
                        j += 1
                    if j >= n:
                        break
                    params = s[i + 2 : j]
                    cmd = s[j]
                    self._handle_csi(params, cmd)
                    i = j + 1
                    continue
                i += 2
                continue
            if ch == "\r":
                self.col = 0
            elif ch == "\n":
                self.row = min(self.rows - 1, self.row + 1)
            elif ch >= " ":
                if 0 <= self.row < self.rows and 0 <= self.col < self.cols:
                    self.grid[self.row][self.col] = ch
                    self.col += 1
            i += 1
        self._buf = s[i:]

    def _handle_csi(self, params: str, cmd: str) -> None:
        if params == "?1049" and cmd == "h":
            self.alt_entered = True
            self.clear()
        elif params == "?1049" and cmd == "l":
            self.alt_exited = True
        elif params == "?2026" and cmd == "h":
            self.sync_frames += 1
        elif cmd in ("H", "f"):
            parts = params.split(";") if params else []
            r = int(parts[0]) if len(parts) > 0 and parts[0].isdigit() else 1
            c = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 1
            self.row = max(0, min(self.rows - 1, r - 1))
            self.col = max(0, min(self.cols - 1, c - 1))
        elif cmd == "J":
            if params in ("", "2", "3"):
                self.clear()
        elif cmd == "K":
            if 0 <= self.row < self.rows:
                for c in range(self.col, self.cols):
                    self.grid[self.row][c] = " "

    def clear(self) -> None:
        self.grid = [[" "] * self.cols for _ in range(self.rows)]
        self.row = 0
        self.col = 0

    def render_text(self) -> str:
        return "\n".join("".join(line).rstrip() for line in self.grid)


def set_winsize(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def drain(fd: int, screen: VirtualScreen, wait_s: float = 0.25) -> None:
    deadline = time.monotonic() + wait_s
    while True:
        rem = deadline - time.monotonic()
        if rem <= 0:
            break
        r, _, _ = select.select([fd], [], [], min(0.05, rem))
        if not r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        screen.feed(chunk.decode("utf-8", errors="replace"))


def run_cli(args: list[str], config_dir: Path, workspace_dir: Path) -> dict[str, object]:
    cmd = [
        "node",
        str(BIN),
        "--config-dir",
        str(config_dir),
        "--workspace",
        str(workspace_dir),
        "--json",
        *args,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise AssertionError(
            f"CLI failed ({res.returncode}): {' '.join(args)}\nstdout={res.stdout}\nstderr={res.stderr}"
        )
    return json.loads(res.stdout)


def create_fallback_marketplace(dest: Path) -> None:
    plugin_dir = dest / "pstack"
    (plugin_dir / ".cursor-plugin").mkdir(parents=True)
    (plugin_dir / "skills" / "poteto-mode").mkdir(parents=True)
    (plugin_dir / "skills" / "architect").mkdir(parents=True)
    (plugin_dir / "agents").mkdir(parents=True)
    (dest / ".cursor-plugin").mkdir(parents=True)
    (dest / ".cursor-plugin" / "marketplace.json").write_text(
        json.dumps(
            {
                "name": "cursor-plugins",
                "owner": {"name": "Cursor"},
                "plugins": [
                    {
                        "name": "pstack",
                        "source": "pstack",
                        "description": "Rigorous agent workflows you can parallelize with confidence.",
                    }
                ],
            }
        )
    )
    (plugin_dir / ".cursor-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": "pstack",
                "version": "0.15.36",
                "description": "Rigorous agent workflows you can parallelize with confidence.",
                "author": {"name": "Lauren Tan"},
            }
        )
    )
    (plugin_dir / "skills" / "poteto-mode" / "SKILL.md").write_text(
        "---\nname: poteto-mode\ndescription: Rigorous engineering workflows.\n---\n# Poteto mode\n"
    )
    (plugin_dir / "skills" / "architect" / "SKILL.md").write_text(
        "---\nname: architect\ndescription: Parallel architecture design exploration.\n---\n# Architect\n"
    )
    (plugin_dir / "agents" / "poteto-agent.md").write_text(
        "---\nname: poteto-agent\ndescription: Delegate subagent.\n---\n"
    )
    (plugin_dir / "agents" / "comment-sicko.md").write_text(
        "---\nname: comment-sicko\ndescription: Comment auditor.\n---\n"
    )


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="agy-plugin-pty-"))
    try:
        config_dir = tmp / "config"
        workspace_dir = tmp / "workspace"
        config_dir.mkdir()
        workspace_dir.mkdir()
        config_json = config_dir / "config.json"
        config_json.write_text('{"userSettings":{"theme":"dark"}}\n')
        orig_config = config_json.read_text()

        cursor_mkt = Path.home() / ".claude" / "plugins" / "marketplaces" / "cursor-plugins"
        if not cursor_mkt.is_dir():
            cursor_mkt = tmp / "fallback-cursor-plugins"
            create_fallback_marketplace(cursor_mkt)

        res_add = run_cli(["marketplace", "add", str(cursor_mkt), "--id", "cursor-plugins"], config_dir, workspace_dir)
        assert res_add["ok"] is True, f"add cursor-plugins failed: {res_add}"

        claude_dir_cache = Path.home() / ".claude" / "plugins" / "plugin-directory-cache-v2.json"
        if claude_dir_cache.is_file():
            res_dir = run_cli(
                ["marketplace", "add", str(claude_dir_cache), "--id", "claude-dir"],
                config_dir,
                workspace_dir,
            )
            assert res_dir["ok"] is True, f"add claude-dir failed: {res_dir}"

        res_inst = run_cli(["install", "pstack@cursor-plugins", "--scope", "user"], config_dir, workspace_dir)
        assert res_inst["ok"] is True, f"install pstack failed: {res_inst}"

        collide_dir = workspace_dir / ".agents" / "plugins" / "pstack-override"
        collide_dir.mkdir(parents=True)
        (collide_dir / "plugin.json").write_text(
            json.dumps({"name": "pstack", "version": "0.1.0", "description": "Local collision fixture"})
        )

        master_fd, slave_fd = pty.openpty()
        set_winsize(slave_fd, 120, 36)
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["NO_COLOR"] = "1"
        proc = subprocess.Popen(
            [
                "node",
                str(BIN),
                "--config-dir",
                str(config_dir),
                "--workspace",
                str(workspace_dir),
            ],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            close_fds=True,
        )
        os.close(slave_fd)

        screen = VirtualScreen(120, 36)
        frames: dict[str, str] = {}

        try:
            drain(master_fd, screen, 0.5)
            frames["1_discover_initial"] = screen.render_text()
            assert screen.alt_entered, "TUI did not enter alt screen"
            assert screen.sync_frames > 0, "TUI did not emit synchronized output frame"
            assert "Antigravity Plugins" in frames["1_discover_initial"], "Missing title"
            assert "Discover" in frames["1_discover_initial"], "Missing Discover tab"
            assert "Installed" in frames["1_discover_initial"], "Missing Installed tab"
            assert "Marketplaces" in frames["1_discover_initial"], "Missing Marketplaces tab"
            assert "Errors" in frames["1_discover_initial"], "Missing Errors tab"
            assert "Stats" in frames["1_discover_initial"], "Missing Stats tab"
            assert "Esc" in frames["1_discover_initial"], "Missing Esc footer hint"

            os.write(master_fd, b"/pstack")
            drain(master_fd, screen, 0.25)
            frames["2_discover_search"] = screen.render_text()
            assert "pstack" in frames["2_discover_search"], "Search did not show pstack"

            os.write(master_fd, b"\r")
            drain(master_fd, screen, 0.2)
            os.write(master_fd, b"\r")
            drain(master_fd, screen, 0.25)
            frames["3_discover_detail_modal"] = screen.render_text()
            assert "Plugin Details" in frames["3_discover_detail_modal"], "Plugin Details modal did not open"
            assert "pstack" in frames["3_discover_detail_modal"], "Plugin Details missing pstack"

            os.write(master_fd, b"\x1b")
            drain(master_fd, screen, 0.2)
            os.write(master_fd, b"\x1b[C")
            drain(master_fd, screen, 0.25)
            frames["4_installed_tab"] = screen.render_text()
            assert "pstack" in frames["4_installed_tab"], "Installed tab missing pstack"

            os.write(master_fd, b"\x1b[C")
            drain(master_fd, screen, 0.25)
            frames["5_marketplaces_tab"] = screen.render_text()
            assert "cursor-plugins" in frames["5_marketplaces_tab"], "Marketplaces tab missing cursor-plugins"

            os.write(master_fd, b"a")
            drain(master_fd, screen, 0.2)
            os.write(master_fd, b"anthropics/claude-plugins-official")
            drain(master_fd, screen, 0.25)
            frames["6_add_marketplace_modal"] = screen.render_text()
            assert "Add Marketplace" in frames["6_add_marketplace_modal"], "Add Marketplace modal did not open"
            assert "github" in frames["6_add_marketplace_modal"].lower(), "Missing live github detection"

            os.write(master_fd, b"\x1b")
            drain(master_fd, screen, 0.2)
            os.write(master_fd, b"\x1b[C")
            drain(master_fd, screen, 0.25)
            frames["7_errors_tab"] = screen.render_text()
            assert "name-collision" in frames["7_errors_tab"], "Errors tab missing name-collision diagnostic"

            os.write(master_fd, b"\x1b[C")
            drain(master_fd, screen, 0.25)
            frames["8_stats_tab"] = screen.render_text()
            assert "Discoverable" in frames["8_stats_tab"], "Stats tab missing Discoverable KPI card"
            assert "Desc Tokens" in frames["8_stats_tab"], "Stats tab missing Desc Tokens KPI card"

            os.write(master_fd, b"m")
            drain(master_fd, screen, 0.25)
            frames["9_stats_by_marketplace"] = screen.render_text()
            assert "By Marketplace" in frames["9_stats_by_marketplace"], "Stats mode cycle failed"

            screen.resize(80, 24)
            set_winsize(master_fd, 80, 24)
            os.kill(proc.pid, signal.SIGWINCH)
            drain(master_fd, screen, 0.3)
            frames["10_resized_80x24"] = screen.render_text()
            for idx, line in enumerate(screen.grid):
                assert len("".join(line).rstrip()) <= 80, f"Row {idx} overflowed 80 cols"
            assert "Esc" in frames["10_resized_80x24"], "Footer lost Esc hint at 80x24"

            os.write(master_fd, b"\x1b")
            drain(master_fd, screen, 0.35)
            exit_code = proc.wait(timeout=3)
            assert exit_code == 0, f"Expected exit code 0, got {exit_code}"
            assert screen.alt_exited, "TUI did not exit alt screen cleanly"
        finally:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=2)
            os.close(master_fd)

        assert config_json.read_text() == orig_config, "config.json was modified!"

        if "--show-frames" in sys.argv:
            for name, frame in frames.items():
                print(f"\n===== {name} =====")
                print(frame)
        else:
            print(f"PTY VERIFIED: {len(frames)} interactive frames, sync_frames={screen.sync_frames}, alt_screen_restored=True, config_json_untouched=True")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
