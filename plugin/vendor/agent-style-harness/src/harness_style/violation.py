from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict

SEVERITIES = ("error", "warning")


@dataclass
class Violation:
    """跨引擎统一的违规模型。

    engine/code 组合是稳定标识，baseline 与 rules.map.json 都以它为键。
    file 一律是相对仓库根的 POSIX 路径，保证跨平台可比较。
    """

    engine: str
    code: str
    file: str
    line: int = 1
    column: int = 1
    severity: str = "error"
    fixable: bool = False
    message: str = ""
    doc: str = ""

    def key(self) -> str:
        """baseline 抑制粒度：文件 + 引擎 + 规则码（不含行号）。"""
        return "{}|{}|{}".format(self.file, self.engine, self.code)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "engine": self.engine,
            "code": self.code,
            "file": self.file,
            "line": int(self.line),
            "column": int(self.column),
            "severity": self.severity,
            "fixable": bool(self.fixable),
            "message": self.message,
            "doc": self.doc,
        }

    def sort_key(self):
        return (self.file, self.line, self.column, self.engine, self.code)


@dataclass
class Result:
    violations: list = field(default_factory=list)
    files_checked: int = 0
    files_by_language: Dict[str, int] = field(default_factory=dict)
    engines: Dict[str, str] = field(default_factory=dict)
    suppressed: int = 0
    scope: str = "staged"

    @property
    def errors(self):
        return [v for v in self.violations if v.severity == "error"]

    @property
    def warnings(self):
        return [v for v in self.violations if v.severity == "warning"]

    @property
    def fixable(self):
        return [v for v in self.violations if v.fixable]
