import json
import os
import subprocess
import sys
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parents[1]
CLI = TOOL_ROOT / "bin" / "harness-style"


def make_repo(tmpdir: Path, config: dict = None, git: bool = True) -> Path:
    repo = Path(tmpdir)
    repo.mkdir(parents=True, exist_ok=True)
    if git:
        run(["git", "init", "-q"], repo)
        run(["git", "config", "user.email", "t@example.com"], repo)
        run(["git", "config", "user.name", "T"], repo)
    payload = {
        "version": 1,
        "profile": "google",
        "languages": {},
        "exclude": ["**/vendor/**", "**/node_modules/**"],
    }
    payload.update(config or {})
    (repo / "harness-style.json").write_text(json.dumps(payload),
                                             encoding="utf-8")
    return repo


def run(cmd, cwd):
    proc = subprocess.run(
        [str(c) for c in cmd],
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )
    return proc


def cli(*args, cwd):
    return run([CLI] + list(args), cwd)


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path
