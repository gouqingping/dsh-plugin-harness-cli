from __future__ import annotations

from pathlib import Path

from ..violation import Violation


class Engine:
    """语言判定器适配器。

    纪律：适配器只做"翻译"，不新增规则。规则由引擎（eslint/yapf/...）决定，
    这里只负责把原始输出变成统一 Violation。
    """

    name = ""
    languages = ()  # type: tuple

    def __init__(self, config, lang: str):
        self.config = config
        self.lang = lang
        self.root = Path(config.root)

    # --- 能力探测 ---------------------------------------------------------
    def available(self) -> bool:
        raise NotImplementedError

    def unavailable_reason(self) -> str:
        return "{} 不可用".format(self.name or self.__class__.__name__)

    def version(self) -> str:
        return "unknown"

    # --- 判定与修复 -------------------------------------------------------
    def check(self, files):
        raise NotImplementedError

    def fix(self, files):
        return []

    # --- 工具方法 ---------------------------------------------------------
    def make(self,
             code,
             path,
             line=1,
             column=1,
             message="",
             fixable=False,
             engine=None) -> Violation:
        from ..util import relpath

        return Violation(
            engine=engine or self.name,
            code=code,
            file=relpath(Path(path), self.root),
            line=max(1, int(line or 1)),
            column=max(1, int(column or 1)),
            severity=self.config.severity_cap(self.lang),
            fixable=fixable,
            message=message,
        )
