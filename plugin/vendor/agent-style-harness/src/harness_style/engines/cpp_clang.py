from __future__ import annotations

import re
from pathlib import Path

from ..util import ToolError, read_text, relpath, run
from ..vendor import find_binary
from .base import Engine

_OFFSET = re.compile(r"offset='(\d+)'")
_TIDY = re.compile(
    r"^(?P<file>.+?):(?P<line>\d+):(?P<col>\d+): "
    r"(?P<sev>warning|error): (?P<msg>.+?) \[(?P<check>[^\]]+)\]$")


class ClangFormatEngine(Engine):
    """clang-format（Google preset）+ 可选 clang-tidy 子集。"""

    name = "clang-format"
    languages = ("cpp", )

    def _bin(self):
        return find_binary("clang-format", self.config)

    def _tidy(self):
        opts = (self.config.languages.get(self.lang).options or {})
        if not opts.get("clangTidy", False):
            return None
        return find_binary("clang-tidy", self.config)

    def available(self) -> bool:
        if not self._bin():
            return False
        opts = (self.config.languages.get(self.lang).options or {})
        if opts.get("clangTidy", False) and not self._tidy():
            return False
        return True

    def unavailable_reason(self) -> str:
        if not self._bin():
            return "未找到 clang-format（vendor/bin/<platform>/ 或 PATH）"
        return "languages.cpp.clangTidy=true 但未找到 clang-tidy"

    def version(self) -> str:
        binary = self._bin()
        if not binary:
            return "unknown"
        rc, out, err = run([binary, "--version"], cwd=self.root)
        return (out or err).strip() if rc == 0 else "unknown"

    def check(self, files):
        binary = self._bin()
        if not binary:
            raise ToolError(self.unavailable_reason())
        violations = []
        for path in files:
            rc, out, err = run(
                [
                    binary, "--style=file", "--output-replacements-xml",
                    str(path)
                ],
                cwd=self.root,
            )
            if rc != 0:
                raise ToolError("clang-format 处理 {} 失败：{}".format(
                    path, (err or out).strip()[:300]))
            offsets = _OFFSET.findall(out)
            if not offsets:
                continue
            source = read_text(path)
            lines = []
            for raw in offsets:
                line = source[:int(raw)].count("\n") + 1
                if line not in lines:
                    lines.append(line)
            for line in sorted(lines)[:20]:
                violations.append(
                    self.make(
                        "format",
                        path,
                        line=line,
                        message="clang-format(Google) 判定格式不符",
                        fixable=True,
                    ))

        tidy = self._tidy()
        if tidy:
            violations.extend(self._check_tidy(tidy, files))
        return violations

    def _check_tidy(self, binary, files):
        violations = []
        for path in files:
            rc, out, err = run(
                [binary, "-p", ".", "--quiet",
                 str(path), "--", "-std=c++17"],
                cwd=self.root,
                timeout=300,
            )
            if rc not in (0, 1):
                raise ToolError("clang-tidy 失败：{}".format(
                    (err or out).strip()[:400]))
            for line in (out + "\n" + err).splitlines():
                match = _TIDY.match(line.strip())
                if not match:
                    continue
                violations.append(
                    self.make(
                        code=match.group("check"),
                        path=match.group("file"),
                        line=int(match.group("line")),
                        column=int(match.group("col")),
                        message=match.group("msg"),
                        fixable=False,
                    ))
        return violations

    def fix(self, files):
        binary = self._bin()
        if not binary:
            raise ToolError(self.unavailable_reason())
        before = {str(f): f.read_bytes() for f in files}
        rc, out, err = run([binary, "--style=file", "-i"] +
                           [str(f) for f in files],
                           cwd=self.root)
        if rc != 0:
            raise ToolError("clang-format -i 失败：{}".format(
                (err or out).strip()[:500]))
        return [
            relpath(Path(p), self.root) for p, data in before.items()
            if Path(p).read_bytes() != data
        ]
