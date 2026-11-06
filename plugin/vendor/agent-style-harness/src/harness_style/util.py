from __future__ import annotations

import platform
import re
import subprocess
from pathlib import Path


class ToolError(Exception):
    """工具自身故障 —— 必须映射到 exit 2，绝不能当成"有违规"。"""


def run(cmd, cwd=None, timeout=600, input_text=None, env=None):
    """执行外部命令，返回 (returncode, stdout, stderr)。

    找不到可执行文件或超时统一抛 ToolError，避免上层把 OSError
    误判成"检查不通过"。
    """
    try:
        proc = subprocess.run(
            [str(c) for c in cmd],
            cwd=str(cwd) if cwd else None,
            input=input_text,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=timeout,
            env=env,
        )
    except FileNotFoundError as exc:
        raise ToolError("找不到可执行文件：{}".format(cmd[0])) from exc
    except subprocess.TimeoutExpired as exc:
        raise ToolError("命令超时（{}s）：{}".format(timeout,
                                              " ".join(map(str,
                                                           cmd)))) from exc
    except OSError as exc:
        raise ToolError("无法执行 {}：{}".format(cmd[0], exc)) from exc
    return proc.returncode, proc.stdout, proc.stderr


def platform_tag() -> str:
    """vendor/bin 下的平台目录名。"""
    system = platform.system().lower()
    machine = platform.machine().lower()
    if machine in ("x86_64", "amd64"):
        arch = "x64"
    elif machine in ("aarch64", "arm64"):
        arch = "arm64"
    else:
        arch = machine or "unknown"
    os_name = {
        "linux": "linux",
        "darwin": "darwin",
        "windows": "windows"
    }.get(system, system)
    return "{}-{}".format(os_name, arch)


def relpath(path: Path, root: Path) -> str:
    try:
        return Path(path).resolve().relative_to(
            Path(root).resolve()).as_posix()
    except ValueError:
        return Path(path).as_posix()


_GLOB_CACHE = {}


def glob_to_regex(pattern: str):
    if pattern in _GLOB_CACHE:
        return _GLOB_CACHE[pattern]
    out = []
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "*":
            if pattern[i:i + 3] == "**/":
                out.append("(?:.*/)?")
                i += 3
                continue
            if pattern[i:i + 2] == "**":
                out.append(".*")
                i += 2
                continue
            out.append("[^/]*")
            i += 1
            continue
        if ch == "?":
            out.append("[^/]")
            i += 1
            continue
        out.append(re.escape(ch))
        i += 1
    compiled = re.compile("^" + "".join(out) + "$")
    _GLOB_CACHE[pattern] = compiled
    return compiled


def matches_any(rel_posix: str, patterns) -> bool:
    """exclude 匹配。

    不含 '/' 的模式同时匹配 basename（`*.min.js` 能命中 `a/b.min.js`），
    与 .gitignore 的直觉一致。
    """
    name = rel_posix.rsplit("/", 1)[-1]
    for pat in patterns:
        pat = pat.strip()
        if not pat or pat.startswith("#"):
            continue
        regex = glob_to_regex(pat)
        target = rel_posix if "/" in pat else name
        if regex.match(target):
            return True
    return False


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise ToolError("无法读取 {}：{}".format(path, exc)) from exc


def first_diff_line(old: str, new: str) -> int:
    old_lines = old.splitlines()
    new_lines = new.splitlines()
    for idx, (a, b) in enumerate(zip(old_lines, new_lines), start=1):
        if a != b:
            return idx
    return min(len(old_lines), len(new_lines)) + 1


def diff_hunks(old: str, new: str, limit: int = 20):
    """把格式化差异拆成多处违规（新文件行号，去重、上限 limit）。

    为什么要拆：baseline 按"文件+规则"计数，如果每个文件只报一条，
    同一文件新增的第二处格式问题就无法被识别为"新增违规"。
    """
    import difflib

    if old == new:
        return []
    old_lines = old.splitlines()
    new_lines = new.splitlines()
    matcher = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
    lines = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        line = (j1 + 1) if j2 > j1 else (i1 + 1)
        line = max(1, line)
        if line not in lines:
            lines.append(line)
    if not lines:
        lines = [first_diff_line(old, new)]
    return sorted(lines)[:limit]
