from __future__ import annotations

from typing import Optional, Type

from .base import Engine
from .cpp_clang import ClangFormatEngine
from .go_gofmt import GoFmtEngine
from .java_gjf import GoogleJavaFormatEngine
from .python_yapf import PythonEngine
from .shell_shfmt import ShellEngine
from .ts_gts import GtsEngine

ENGINES = {
    "python": PythonEngine,
    "typescript": GtsEngine,
    "java": GoogleJavaFormatEngine,
    "cpp": ClangFormatEngine,
    "shell": ShellEngine,
    "go": GoFmtEngine,
}


def for_language(lang: str) -> Optional[Type[Engine]]:
    return ENGINES.get(lang)


def names():
    return sorted({cls.name for cls in ENGINES.values()})
