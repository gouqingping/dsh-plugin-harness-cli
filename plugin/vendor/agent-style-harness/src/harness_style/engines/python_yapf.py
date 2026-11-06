from __future__ import annotations

import re
import sys
from pathlib import Path

from ..util import ToolError, diff_hunks, read_text, relpath, run
from ..vendor import python_paths
from .base import Engine

_DIFF_HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def parse_diff_line(diff: str) -> int:
    """统一 diff 中第一处改动的旧文件行号。"""
    for line in diff.splitlines():
        match = _DIFF_HUNK.match(line)
        if match:
            return int(match.group(1))
    return 1


class PythonEngine(Engine):
    """yapf（Google 官方）+ isort（profile=google）。

    两者都用 API/CLI 直接调用，不依赖 PATH 上的可执行文件：
    vendor/py 通过 sys.path 注入，子进程用 PYTHONPATH 传递。
    """

    name = "yapf"
    languages = ("python", )

    def __init__(self, config, lang):
        super().__init__(config, lang)
        self._yapf = None
        self._isort_ok = None
        self._import_sorting = bool((config.languages.get(lang).options
                                     or {}).get("importSorting", True))
        try:
            from yapf.yapflib import yapf_api  # noqa: F401

            self._yapf = yapf_api
        except Exception:
            self._yapf = None

    def available(self) -> bool:
        if self._yapf is None:
            return False
        if self._import_sorting and not self._has_isort():
            return False
        return True

    def unavailable_reason(self) -> str:
        if self._yapf is None:
            return "yapf 未安装（应位于 vendor/py 或项目依赖）"
        return "isort 未安装，但 languages.python.importSorting=true"

    def _has_isort(self) -> bool:
        if self._isort_ok is None:
            try:
                import isort  # noqa: F401

                self._isort_ok = True
            except Exception:
                self._isort_ok = False
        return bool(self._isort_ok)

    def version(self) -> str:
        try:
            import yapf

            return getattr(yapf, "__version__", "unknown")
        except Exception:
            return "unknown"

    # --- 判定 -------------------------------------------------------------
    def check(self, files):
        violations = []
        for path in files:
            violations.extend(self._check_format(path))
            if self._import_sorting:
                violations.extend(self._check_imports(path))
        return violations

    def _check_format(self, path: Path):
        source = read_text(path)
        try:
            result = self._yapf.FormatFile(str(path), in_place=False)
        except Exception as exc:
            raise ToolError("yapf 处理 {} 失败：{}".format(path, exc))
        # yapf 不同版本返回 2 元或 3 元组
        reformatted = result[0]
        changed = result[-1] if isinstance(result[-1],
                                           bool) else reformatted != source
        if not changed:
            return []
        return [
            self.make(
                "format",
                path,
                line=line,
                message="yapf(google) 判定格式不符",
                fixable=True,
            ) for line in diff_hunks(source, reformatted)
        ]

    def _isort_env(self):
        paths = [str(p) for p in python_paths(self.config)]
        if not paths:
            return None
        import os

        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(paths +
                                            [env.get("PYTHONPATH", "")]).strip(
                                                os.pathsep)
        return env

    def _check_imports(self, path: Path):
        rc, out, err = run(
            [
                sys.executable, "-m", "isort", "--check-only", "--diff",
                str(path)
            ],
            cwd=self.root,
            env=self._isort_env(),
        )
        if rc == 0:
            return []
        if rc != 1:
            raise ToolError("isort 执行失败：{}".format((err or out).strip()[:500]))
        return [
            self.make(
                "import-order",
                path,
                line=parse_diff_line(out),
                message="import 顺序不符合 isort google profile",
                fixable=True,
                engine="isort",
            )
        ]

    # --- 修复 -------------------------------------------------------------
    def fix(self, files):
        changed = []
        for path in files:
            source = read_text(path)
            try:
                result = self._yapf.FormatFile(str(path), in_place=False)
            except Exception as exc:
                raise ToolError("yapf 处理 {} 失败：{}".format(path, exc))
            reformatted = result[0]
            if reformatted != source:
                path.write_text(reformatted, encoding="utf-8")
                changed.append(relpath(path, self.root))
            if self._import_sorting:
                rc, _, err = run(
                    [sys.executable, "-m", "isort",
                     str(path)],
                    cwd=self.root,
                    env=self._isort_env(),
                )
                if rc != 0:
                    raise ToolError("isort 修复 {} 失败：{}".format(
                        path,
                        err.strip()[:300]))
                if relpath(path, self.root) not in changed and read_text(
                        path) != source:
                    changed.append(relpath(path, self.root))
        return changed
