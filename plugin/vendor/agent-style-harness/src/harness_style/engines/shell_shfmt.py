from __future__ import annotations

import json
import re
from pathlib import Path

from ..util import ToolError, relpath, run
from ..vendor import find_binary
from .base import Engine

_HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+\d+")


def _diff_line(diff: str) -> int:
    for line in diff.splitlines():
        match = _HUNK.match(line)
        if match:
            return int(match.group(1))
    return 1


class ShellEngine(Engine):
    """shfmt（格式）+ shellcheck（语义）。

    两者都不是 Google 官方实现，因此这个语言在配置里默认 warning，不阻断提交。
    """

    name = "shfmt"
    languages = ("shell", )

    def _shfmt(self):
        return find_binary("shfmt", self.config)

    def _shellcheck(self):
        opts = (self.config.languages.get(self.lang).options or {})
        if not opts.get("shellcheck", True):
            return None
        return find_binary("shellcheck", self.config)

    def available(self) -> bool:
        if not self._shfmt():
            return False
        opts = (self.config.languages.get(self.lang).options or {})
        if opts.get("shellcheck", True) and not self._shellcheck():
            return False
        return True

    def unavailable_reason(self) -> str:
        if not self._shfmt():
            return "未找到 shfmt"
        return "languages.shell.shellcheck=true 但未找到 shellcheck"

    def version(self) -> str:
        binary = self._shfmt()
        if not binary:
            return "unknown"
        rc, out, err = run([binary, "--version"], cwd=self.root)
        return (out or err).strip().splitlines()[0] if rc == 0 and (
            out or err) else "unknown"

    def check(self, files):
        shfmt = self._shfmt()
        if not shfmt:
            raise ToolError(self.unavailable_reason())
        violations = []
        for path in files:
            rc, out, err = run([shfmt, "-d", "-i", "2", "-ci",
                                str(path)],
                               cwd=self.root)
            if rc == 1 and out.strip():
                violations.append(
                    self.make(
                        "format",
                        path,
                        line=_diff_line(out),
                        message="shfmt 判定格式不符",
                        fixable=True,
                    ))
            elif rc not in (0, 1):
                raise ToolError("shfmt 失败：{}".format((err
                                                      or out).strip()[:300]))

        checker = self._shellcheck()
        if checker:
            violations.extend(self._run_shellcheck(checker, files))
        return violations

    def _run_shellcheck(self, binary, files):
        rc, out, err = run([binary, "-f", "json", "-x"] +
                           [str(f) for f in files],
                           cwd=self.root)
        if rc not in (0, 1):
            raise ToolError("shellcheck 失败：{}".format((err
                                                       or out).strip()[:300]))
        if not out.strip():
            return []
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            return []
        violations = []
        for item in data:
            level = item.get("level", "warning")
            violations.append(
                self.make(
                    code="SC{}".format(item.get("code", "0000")),
                    path=item.get("file", ""),
                    line=item.get("line", 1),
                    column=item.get("column", 1),
                    message=item.get("message", ""),
                    fixable=False,
                ))
            # shellcheck 的 info/style 在 Google 语境下不作为错误
            if level in ("info", "style"):
                violations[-1].severity = "warning"
        return violations

    def fix(self, files):
        shfmt = self._shfmt()
        if not shfmt:
            raise ToolError(self.unavailable_reason())
        before = {str(f): f.read_bytes() for f in files}
        rc, out, err = run([shfmt, "-w", "-i", "2", "-ci"] +
                           [str(f) for f in files],
                           cwd=self.root)
        if rc != 0:
            raise ToolError("shfmt -w 失败：{}".format((err
                                                     or out).strip()[:500]))
        return [
            relpath(Path(p), self.root) for p, data in before.items()
            if Path(p).read_bytes() != data
        ]
