from __future__ import annotations

import sys
from pathlib import Path

from . import __version__, hooks, vendor
from .engines import for_language
from .util import ToolError, run
from .vendor import find_module_js, find_node


def _item(name, ok, detail, critical=True):
    return {
        "name": name,
        "ok": bool(ok),
        "detail": detail,
        "critical": critical
    }


def run_checks(config) -> list:
    items = []

    version_ok = sys.version_info >= (3, 8)
    items.append(
        _item(
            "python",
            version_ok,
            "{}.{}.{}".format(*sys.version_info[:3]) +
            ("" if version_ok else "（需要 >=3.8）"),
        ))

    rc, out, err = run(["git", "rev-parse", "--show-toplevel"],
                       cwd=Path(config.root))
    is_repo = rc == 0
    items.append(
        _item("git", is_repo,
              out.strip() if is_repo else "不是 git 仓库，hook 无法安装"))

    hooks_problems = hooks.verify(config)
    items.append(
        _item(
            "hooks",
            not hooks_problems,
            "未安装" if hooks_problems and "未指向" in hooks_problems[0] else
            ("完好" if not hooks_problems else "; ".join(hooks_problems)),
            critical=False,
        ))

    for lang, spec in sorted(config.languages.items()):
        if not spec.enabled:
            items.append(
                _item("lang:{}".format(lang), True, "未启用（跳过）", critical=False))
            continue
        engine_cls = for_language(lang)
        if engine_cls is None:
            items.append(_item("lang:{}".format(lang), False, "没有注册判定器"))
            continue
        engine = engine_cls(config, lang)
        ok = engine.available()
        items.append(
            _item(
                "engine:{}".format(engine.name),
                ok,
                engine.version() if ok else engine.unavailable_reason(),
            ))

    node = find_node()
    cli = find_module_js(config, "@commitlint/cli/cli.js")
    cfg = config.commitlint_config_path()
    items.append(
        _item(
            "commitlint",
            bool(node and cli and cfg),
            "node={} cli={} config={}".format(
                str(node) if node else "缺失",
                "ok" if cli else "缺失",
                str(cfg.name) if cfg else "缺失",
            ),
        ))

    vendor_dirs = vendor.roots(config)
    existing = [str(p) for p in vendor_dirs if p.is_dir()]
    items.append(
        _item(
            "vendor",
            bool(existing),
            existing[0] if existing else "没有 vendor 目录（离线依赖未就绪）",
            critical=False,
        ))
    return items


def healthy(items) -> bool:
    return all(item["ok"] for item in items if item["critical"])


def render_text(items) -> str:
    lines = []
    for item in items:
        mark = "✔" if item["ok"] else ("✖" if item["critical"] else "⚠")
        lines.append("{mark} {name:<24} {detail}".format(
            mark=mark, name=item["name"], detail=item["detail"]))
    bad = [i for i in items if not i["ok"] and i["critical"]]
    lines.append("")
    if bad:
        lines.append("{} 项阻塞问题；修复后再提交（hook 会以 exit 2 拒绝）。".format(len(bad)))
    else:
        lines.append("全部关键检查通过。")
    return "\n".join(lines)


def tool_path() -> Path:
    return vendor.TOOL_ROOT / "bin" / "harness-style"


def ensure_tool_path() -> Path:
    path = tool_path()
    if not path.is_file():
        raise ToolError("找不到 CLI 入口：{}".format(path))
    return path
