from __future__ import annotations

from pathlib import Path

from ..util import ToolError, relpath, run
from ..vendor import find_binary
from .base import Engine


class GoFmtEngine(Engine):
    """gofmt 即规范来源，没有配置项。"""

    name = "gofmt"
    languages = ("go", )

    def _bin(self):
        return find_binary("gofmt", self.config)

    def available(self) -> bool:
        return self._bin() is not None

    def unavailable_reason(self) -> str:
        return "未找到 gofmt（需要 Go 工具链；本工具不随附）"

    def version(self) -> str:
        binary = self._bin()
        if not binary:
            return "unknown"
        rc, out, err = run([binary, "-h"], cwd=self.root)
        return "go toolchain gofmt"

    def check(self, files):
        binary = self._bin()
        if not binary:
            raise ToolError(self.unavailable_reason())
        rc, out, err = run([binary, "-l"] + [str(f) for f in files],
                           cwd=self.root)
        if rc != 0:
            raise ToolError("gofmt 失败：{}".format((err or out).strip()[:300]))
        listed = {line.strip() for line in out.splitlines() if line.strip()}
        return [
            self.make(
                "format",
                path,
                line=1,
                message="gofmt 判定格式不符",
                fixable=True,
            ) for path in files if str(path) in listed
        ]

    def fix(self, files):
        binary = self._bin()
        if not binary:
            raise ToolError(self.unavailable_reason())
        before = {str(f): f.read_bytes() for f in files}
        rc, out, err = run([binary, "-w"] + [str(f) for f in files],
                           cwd=self.root)
        if rc != 0:
            raise ToolError("gofmt -w 失败：{}".format((err
                                                     or out).strip()[:500]))
        return [
            relpath(Path(p), self.root) for p, data in before.items()
            if Path(p).read_bytes() != data
        ]
