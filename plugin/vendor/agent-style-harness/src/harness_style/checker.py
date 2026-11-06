from __future__ import annotations

from pathlib import Path

from . import baseline as baseline_mod
from . import discovery, rules, vendor
from .engines import for_language
from .util import ToolError
from .violation import Result


def _doc_for(mapping: dict, violation) -> str:
    return (mapping.get("{}/{}".format(violation.engine, violation.code))
            or mapping.get(violation.code) or "")


def run(config,
        scope="staged",
        patterns=None,
        strict=False,
        use_baseline=True) -> Result:
    vendor.activate_python(config)
    grouped = discovery.resolve(config, scope, patterns)
    mapping = rules.rules_map(config)

    result = Result(scope=scope if scope != "paths" else "paths")
    for lang in sorted(grouped):
        files = grouped[lang]
        engine_cls = for_language(lang)
        if engine_cls is None:
            raise ToolError("语言 {} 没有注册判定器".format(lang))
        engine = engine_cls(config, lang)
        if not engine.available():
            raise ToolError("{}（语言 {}，{} 个文件待检查）".format(
                engine.unavailable_reason(), lang, len(files)))
        violations = engine.check(files)
        for violation in violations:
            violation.doc = _doc_for(mapping, violation)
            if strict:
                violation.severity = "error"
        result.violations.extend(violations)
        result.files_by_language[lang] = len(files)
        result.files_checked += len(files)
        result.engines[engine.name] = engine.version()

    result.violations.sort(key=lambda v: v.sort_key())

    if use_baseline:
        result.violations, result.suppressed = baseline_mod.apply(
            config, result.violations)
    return result


def fix(config, scope="staged", patterns=None) -> tuple:
    """先修复再复检。返回 (改动文件列表, 复检结果)。"""
    vendor.activate_python(config)
    grouped = discovery.resolve(config, scope, patterns)
    changed = []
    for lang in sorted(grouped):
        engine_cls = for_language(lang)
        if engine_cls is None:
            raise ToolError("语言 {} 没有注册判定器".format(lang))
        engine = engine_cls(config, lang)
        if not engine.available():
            raise ToolError(engine.unavailable_reason())
        changed.extend(engine.fix(grouped[lang]))
    result = run(config, scope=scope, patterns=patterns, use_baseline=False)
    return sorted(set(changed)), result


def plan(config, scope="staged", patterns=None) -> dict:
    """只算"要检查哪些文件"，供 doctor / --dry-run 使用。"""
    return discovery.resolve(config, scope, patterns)


def exists_git_repo(start=None) -> bool:
    try:
        discovery.repo_root(Path(start) if start else None)
        return True
    except ToolError:
        return False
