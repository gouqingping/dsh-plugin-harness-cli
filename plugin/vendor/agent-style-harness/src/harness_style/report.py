from __future__ import annotations

import json

from . import __version__
from .violation import Result

SCHEMA = "harness-style/v1"


def to_payload(result: Result) -> dict:
    return {
        "schema": SCHEMA,
        "ok": not result.errors,
        "scope": result.scope,
        "env": {
            "offline": True,
            "tool": "harness-style {}".format(__version__),
            "engines": dict(sorted(result.engines.items())),
        },
        "summary": {
            "files": result.files_checked,
            "errors": len(result.errors),
            "warnings": len(result.warnings),
            "fixable": len(result.fixable),
            "suppressed": result.suppressed,
        },
        "violations": [v.to_dict() for v in result.violations],
    }


def render_json(result: Result) -> str:
    return json.dumps(to_payload(result), ensure_ascii=False, indent=2)


def render_human(result: Result) -> str:
    lines = []
    by_file = {}
    for violation in result.violations:
        by_file.setdefault(violation.file, []).append(violation)

    for path in sorted(by_file):
        lines.append(path)
        for v in sorted(by_file[path],
                        key=lambda x: (x.line, x.column, x.code)):
            flag = " [fixable]" if v.fixable else ""
            lines.append("  {:>4}:{:<3} {:<7} {}/{}: {}{}".format(
                v.line, v.column, v.severity, v.engine, v.code, v.message,
                flag))
        lines.append("")

    docs = {}
    for v in result.violations:
        if v.doc:
            docs.setdefault("{}/{}".format(v.engine, v.code), v.doc)
    if docs:
        lines.append("规范依据：")
        for code in sorted(docs):
            lines.append("  {} -> {}".format(code, docs[code]))
        lines.append("")

    summary = "{} errors, {} warnings in {} {}".format(
        len(result.errors),
        len(result.warnings),
        result.files_checked,
        "file" if result.files_checked == 1 else "files",
    )
    extras = []
    if result.fixable:
        extras.append("{} fixable".format(len(result.fixable)))
    if result.suppressed:
        extras.append("{} suppressed by baseline".format(result.suppressed))
    if extras:
        summary += " ({})".format(", ".join(extras))

    if result.errors:
        lines.append("✖ " + summary)
        lines.append("  修复：harness-style fix --staged  然后重新 check")
    elif result.violations:
        lines.append("⚠ " + summary)
    else:
        lines.append("✔ 无违规：" + summary)
    return "\n".join(lines)
