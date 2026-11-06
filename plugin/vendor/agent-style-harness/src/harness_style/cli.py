from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from . import __version__
from . import baseline as baseline_mod
from . import checker, commitmsg, hooks, report, skill, vendor
from .config import CONFIG_NAME, ConfigError, load
from .doctor import ensure_tool_path, healthy, render_text, run_checks
from .util import ToolError

EXIT_OK = 0
EXIT_VIOLATIONS = 1
EXIT_TOOL_ERROR = 2


def default_config():
    path = vendor.TOOL_ROOT / "templates" / "default-config.json"
    return json.loads(path.read_text(encoding="utf-8"))


TEMPLATE_DIRS = {
    "typescript": ["ts", "tsx", "js", "jsx", "typescript", "javascript"],
    "python": ["py", "python"],
    "cpp": ["c", "c++", "cpp", "cc"],
    "shell": ["sh", "shell", "bash"],
}


def _pick_scope(args):
    if getattr(args, "range_", None):
        return "range", [args.range_]
    if getattr(args, "all", False):
        return "all", None
    if getattr(args, "paths", None):
        return "paths", args.paths
    return "staged", None


# --------------------------------------------------------------------------
# 子命令
# --------------------------------------------------------------------------
def cmd_check(config, args) -> int:
    scope, patterns = _pick_scope(args)
    result = checker.run(config,
                         scope=scope,
                         patterns=patterns,
                         strict=args.strict)
    if args.json:
        print(report.render_json(result))
    else:
        if result.files_checked == 0:
            print("没有需要检查的文件（scope={}）".format(scope))
        else:
            print(report.render_human(result))
    return EXIT_VIOLATIONS if result.errors else EXIT_OK


def cmd_fix(config, args) -> int:
    scope, patterns = _pick_scope(args)
    if args.dry_run:
        result = checker.run(config, scope=scope, patterns=patterns)
        if not result.violations:
            print("没有需要修复的项。")
            return EXIT_OK
        print(report.render_human(result))
        print("\n--dry-run：以上 {} 项中有 {} 项可自动修复。".format(
            len(result.violations), len(result.fixable)))
        return EXIT_OK

    changed, result = checker.fix(config, scope=scope, patterns=patterns)
    if changed:
        print("已修复 {} 个文件：".format(len(changed)))
        for path in changed:
            print("  " + path)
    else:
        print("没有产生改动。")
    print()
    print(report.render_human(result))
    return EXIT_VIOLATIONS if result.errors else EXIT_OK


def cmd_commit_msg(config, args) -> int:
    passed, notes = commitmsg.validate_file(config, Path(args.file))
    payload = {"schema": "harness-style/v1", "ok": passed, "notes": notes}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for note in notes:
            if note:
                print(note, file=sys.stdout if passed else sys.stderr)
        print("✔ 提交信息通过" if passed else "✖ 提交信息不符合 commitlint 规范")
    return EXIT_OK if passed else EXIT_VIOLATIONS


def cmd_install_hooks(config, args) -> int:
    tool = Path(
        args.tool_path).resolve() if args.tool_path else ensure_tool_path()
    written = hooks.install(config, tool, force=args.force)
    print("已安装 hook（core.hooksPath=.githooks）：")
    for path in written:
        print("  " + path)
    print("用 --no-verify 可绕过，但 CI 会再校验一次；不要依赖它。")
    return EXIT_OK


def cmd_uninstall_hooks(config, args) -> int:
    removed = hooks.uninstall(config)
    print("已移除：" + (", ".join(removed) if removed else "无"))
    return EXIT_OK


def cmd_baseline(config, args) -> int:
    if args.action != "update":
        raise ToolError("只支持 `baseline update`")
    scope, patterns = _pick_scope(args)
    result = checker.run(config,
                         scope=scope,
                         patterns=patterns,
                         use_baseline=False)
    path = baseline_mod.write(config, result.violations)
    print("已写入 {}：{} 条违规记录到基线。".format(path, len(result.violations)))
    print("基线只抑制已有计数；新增同类违规仍会被报出。")
    return EXIT_OK


def cmd_doctor(config, args) -> int:
    items = run_checks(config)
    if args.json:
        print(
            json.dumps({
                "schema": "harness-style/v1",
                "checks": items
            },
                       ensure_ascii=False,
                       indent=2))
    else:
        print(render_text(items))
    return EXIT_OK if healthy(items) else EXIT_VIOLATIONS


def _template_files(directory: Path):
    """glob('*') 不会匹配 dotfile，模板里恰好全是 dotfile。"""
    for entry in sorted(directory.iterdir()):
        if entry.name in (".", ".."):
            continue
        if entry.is_file():
            yield entry


def _copy_templates(target: Path, langs, force: bool) -> list:
    copied = []
    root_template = vendor.TOOL_ROOT / "templates" / "root"
    for src in _template_files(root_template):
        dest = target / src.name
        if dest.exists() and not force:
            continue
        shutil.copy2(src, dest)
        copied.append(dest.name)

    wanted = set()
    for lang in langs:
        for key, aliases in TEMPLATE_DIRS.items():
            if lang in aliases:
                wanted.add(key)
    for key in sorted(wanted):
        directory = vendor.TOOL_ROOT / "templates" / key
        if not directory.is_dir():
            continue
        for src in _template_files(directory):
            dest = target / src.name
            if dest.exists() and not force:
                continue
            shutil.copy2(src, dest)
            copied.append(dest.name)
    return copied


def cmd_init(config, args) -> int:
    root = Path.cwd().resolve()
    langs = [
        lang.strip() for lang in (args.lang or "").split(",") if lang.strip()
    ]

    copied = _copy_templates(root, langs, args.force)
    if copied:
        print("已复制模板：" + ", ".join(sorted(copied)))

    config_path = root / CONFIG_NAME
    if not config_path.exists() or args.force:
        payload = default_config()
        for lang in langs:
            for key, aliases in TEMPLATE_DIRS.items():
                if lang in aliases:
                    payload["languages"][key]["enabled"] = True
            if lang in payload["languages"]:
                payload["languages"][lang]["enabled"] = True
        config_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")
        print("已写入 " + CONFIG_NAME)

    tool = ensure_tool_path()
    if not args.no_hooks:
        hooks.install(load(config_path), tool, force=True)
        print("已安装 git hook（core.hooksPath=.githooks）")

    path, action = skill.upsert_agents(root, tool)
    label = {"created": "新建", "updated": "更新", "appended": "追加"}[action]
    print("已{} AGENTS.md 规范条款：{}".format(label, path))
    return EXIT_OK


def cmd_install_skill(args) -> int:
    root = Path.cwd().resolve()
    tool = Path(
        args.tool_path).resolve() if args.tool_path else ensure_tool_path()
    dest = skill.install(root,
                         scope=args.scope,
                         tool_path=tool,
                         overwrite=args.force)
    print("已安装 skill：{}".format(dest))
    print("DSH 会监听该目录；下一次请求的目录里出现 {}，用户可用 /{} 显式调用。".format(
        skill.SKILL_NAME, skill.SKILL_NAME))
    if args.scope == "project" and not (root / ".git").exists():
        print("提示：当前目录不是 git 仓库，DSH 以 cwd 作为项目根；真实项目请从仓库根运行。")
    return EXIT_OK


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness-style",
        description="离线代码规范判定器：Google Style Guide + commitlint",
    )
    parser.add_argument("--version",
                        action="version",
                        version="harness-style " + __version__)
    sub = parser.add_subparsers(dest="command")

    def add_scope(sp):
        group = sp.add_mutually_exclusive_group()
        group.add_argument("--staged", action="store_true", help="只检查暂存区（默认）")
        group.add_argument("--range",
                           dest="range_",
                           metavar="A..B",
                           help="检查 git 范围")
        group.add_argument("--all", action="store_true", help="检查全部受管文件")
        sp.add_argument("paths", nargs="*", help="显式路径（文件或目录）")

    check = sub.add_parser("check", help="只读检查")
    add_scope(check)
    check.add_argument("--json", action="store_true")
    check.add_argument("--strict",
                       action="store_true",
                       help="warning 也当 error")

    fix = sub.add_parser("fix", help="自动修复")
    add_scope(fix)
    fix.add_argument("--dry-run", action="store_true")

    msg = sub.add_parser("commit-msg", help="校验提交信息")
    msg.add_argument("file")
    msg.add_argument("--json", action="store_true")

    install = sub.add_parser("install-hooks", help="安装 pre-commit/commit-msg")
    install.add_argument("--force", action="store_true")
    install.add_argument("--tool-path")

    sub.add_parser("uninstall-hooks", help="移除 hook")

    base = sub.add_parser("baseline", help="基线抑制")
    base.add_argument("action", choices=["update"])
    add_scope(base)

    doc = sub.add_parser("doctor", help="依赖与配置自检")
    doc.add_argument("--json", action="store_true")

    init = sub.add_parser("init", help="接入当前仓库")
    init.add_argument("--lang", default="", help="逗号分隔：ts,py,java,cpp,sh,go")
    init.add_argument("--force", action="store_true")
    init.add_argument("--no-hooks", action="store_true")

    sk = sub.add_parser("install-skill", help="安装到 DSH skill 扫描目录")
    sk.add_argument("--scope", choices=["project", "user"], default="project")
    sk.add_argument("--force", action="store_true")
    sk.add_argument("--tool-path")

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return EXIT_TOOL_ERROR

    try:
        if args.command == "init":
            return cmd_init(None, args)
        if args.command == "install-skill":
            return cmd_install_skill(args)
        config = load()
        vendor.activate_python(config)
        handlers = {
            "check": cmd_check,
            "fix": cmd_fix,
            "commit-msg": cmd_commit_msg,
            "install-hooks": cmd_install_hooks,
            "uninstall-hooks": cmd_uninstall_hooks,
            "baseline": cmd_baseline,
            "doctor": cmd_doctor,
        }
        return handlers[args.command](config, args)
    except CommitAbort as exc:  # pragma: no cover - 预留
        print(str(exc), file=sys.stderr)
        return EXIT_VIOLATIONS
    except (ConfigError, ToolError) as exc:
        print("harness-style: {}".format(exc), file=sys.stderr)
        return EXIT_TOOL_ERROR
    except KeyboardInterrupt:  # pragma: no cover
        print("已中断", file=sys.stderr)
        return 130


class CommitAbort(Exception):
    pass
