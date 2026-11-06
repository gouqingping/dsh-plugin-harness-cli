from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import List, Optional

from .util import ToolError, matches_any, platform_tag, run

LANG_BY_EXT = {
    # Python
    ".py": "python",
    # TypeScript / JavaScript（同一个 gts 规则集）
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "typescript",
    ".jsx": "typescript",
    ".mjs": "typescript",
    ".cjs": "typescript",
    # Java
    ".java": "java",
    # C / C++
    ".c": "cpp",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".h": "cpp",
    ".hh": "cpp",
    ".hpp": "cpp",
    ".hxx": "cpp",
    # Shell
    ".sh": "shell",
    ".bash": "shell",
    # Go
    ".go": "go",
}


def language_for(path: Path) -> Optional[str]:
    return LANG_BY_EXT.get(path.suffix.lower())


def _git(args, cwd) -> List[str]:
    rc, out, err = run(["git"] + list(args), cwd=cwd)
    if rc != 0:
        raise ToolError("git {} 失败：{}".format(" ".join(args),
                                              (err or out).strip()))
    return [p for p in out.split("\0") if p]


def repo_root(cwd: Optional[Path] = None) -> Path:
    rc, out, _ = run(["git", "rev-parse", "--show-toplevel"],
                     cwd=cwd or Path.cwd())
    if rc != 0 or not out.strip():
        raise ToolError("当前目录不是 git 仓库，无法使用 --staged/--range 模式")
    return Path(out.strip()).resolve()


def _expand_paths(paths) -> List[str]:
    found: List[str] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            for child in p.rglob("*"):
                if child.is_file():
                    found.append(child.as_posix())
        elif p.is_file():
            found.append(p.as_posix())
    return found


def list_files(config, scope: str, patterns=None) -> List[str]:
    """返回相对仓库根的 POSIX 路径列表（未过滤 exclude/语言）。"""
    if scope == "staged":
        root = repo_root(config.root)
        names = _git(
            ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
            root)
    elif scope == "range":
        root = repo_root(config.root)
        if not patterns:
            raise ToolError("--range 需要一个 git 范围，例如 origin/main..HEAD")
        rng = patterns[0]
        names = _git(["diff", "--name-only", "--diff-filter=ACMR", "-z", rng],
                     root)
    elif scope == "all":
        try:
            root = repo_root(config.root)
        except ToolError:
            root = Path(config.root).resolve()
        if (root / ".git").exists():
            names = _git(["ls-files", "-z"], root)
            names += _git(["ls-files", "-z", "--others", "--exclude-standard"],
                          root)
        else:
            names = [
                p.as_posix() for p in Path(config.root).rglob("*")
                if p.is_file()
            ]
    elif scope == "paths":
        names = _expand_paths(patterns or [])
        try:
            root = repo_root(config.root)
        except ToolError:
            root = Path(config.root).resolve()
    else:
        raise ToolError("未知范围：{}".format(scope))

    result = []
    seen = set()
    for name in names:
        path = Path(name)
        if not path.is_absolute():
            path = root / path
        try:
            rel = path.resolve().relative_to(root).as_posix()
        except ValueError:
            # 仓库外的文件不参与判定，避免误伤
            continue
        if rel in seen:
            continue
        if not (root / rel).is_file():
            continue
        seen.add(rel)
        result.append(rel)
    return sorted(result)


def group_by_language(config, rel_paths) -> dict:
    """按配置过滤后分组；未启用的语言与未识别的扩展名直接跳过。"""
    grouped = {}
    for rel in rel_paths:
        if matches_any(rel, config.exclude):
            continue
        lang = language_for(Path(rel))
        if lang is None:
            continue
        spec = config.languages.get(lang)
        if spec is None or not spec.enabled:
            continue
        grouped.setdefault(lang, []).append(config.root / rel)
    return grouped


def resolve(config, scope: str = "staged", patterns=None) -> dict:
    rel_paths = list_files(config, scope, patterns)
    return group_by_language(config, rel_paths)
