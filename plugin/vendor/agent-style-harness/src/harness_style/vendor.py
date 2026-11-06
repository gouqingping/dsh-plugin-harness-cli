from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import List, Optional

from .util import platform_tag

TOOL_ROOT = Path(__file__).resolve().parents[2]


def roots(config) -> List[Path]:
    """vendor 查找顺序：显式配置 → 目标仓库 → 工具仓库根。

    允许 vendor 放在目标仓库，是为了让"仓库自带离线依赖"成为可能；
    放在工具仓库则适合多个项目共用一份。
    """
    candidates = []
    env = os.environ.get("HARNESS_STYLE_VENDOR")
    if env:
        candidates.append(Path(env))
    if config is not None:
        if getattr(config, "vendor_dir", None):
            candidates.append(Path(config.vendor_dir))
        candidates.append(Path(config.root) / "vendor")
    candidates.append(TOOL_ROOT / "vendor")
    seen = set()
    result = []
    for c in candidates:
        c = c.resolve()
        if c in seen:
            continue
        seen.add(c)
        result.append(c)
    return result


def find_binary(name: str, config) -> Optional[Path]:
    """先查 vendor/bin/<platform>，再退到 PATH。"""
    tag = platform_tag()
    exe = name + (".exe" if os.name == "nt" else "")
    for root in roots(config):
        for candidate in (
                root / "bin" / tag / exe,
                root / "bin" / name / tag / exe,
                root / "bin" / exe,
        ):
            if candidate.is_file():
                return candidate
    found = shutil.which(name)
    return Path(found) if found else None


def node_modules(config) -> List[Path]:
    result = []
    if config is not None:
        result.append(Path(config.root) / "node_modules")
    for root in roots(config):
        result.append(root / "node" / "node_modules")
        result.append(root / "node_modules")
    return [p for p in result if p.is_dir()]


def find_module_js(config, relative: str) -> Optional[Path]:
    """在 node_modules 中定位一个 js 入口，例如 eslint/bin/eslint.js。"""
    for base in node_modules(config):
        candidate = base / relative
        if candidate.is_file():
            return candidate
    return None


def find_node() -> Optional[Path]:
    found = shutil.which("node")
    return Path(found) if found else None


def python_paths(config) -> List[Path]:
    result = []
    for root in roots(config):
        for sub in (root / "py", root / "python" / "site-packages"):
            if sub.is_dir():
                result.append(sub)
    return result


def activate_python(config) -> None:
    """把 vendor 里的纯 Python 依赖挂进 sys.path（离线、无需 pip 安装）。"""
    for path in python_paths(config):
        text = str(path)
        if text not in sys.path:
            sys.path.insert(0, text)
