from __future__ import annotations

import os
import re
from pathlib import Path

from .util import ToolError, read_text, run
from .vendor import find_module_js, find_node, node_modules

FIXUP = re.compile(r"^(fixup|squash|amend)!\s")


def normalize(text: str) -> str:
    """去掉 git 注释行与首尾空行，与 git 实际提交内容对齐。"""
    lines = [line.rstrip() for line in text.splitlines()]
    lines = [line for line in lines if not line.startswith("#")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def classify(message: str) -> str:
    header = message.splitlines()[0].strip() if message else ""
    if not header:
        return "empty"
    if header.startswith("Merge "):
        return "merge"
    if header.startswith('Revert "'):
        return "revert"
    if FIXUP.match(header):
        return "fixup"
    return "normal"


def _git_dir(root: Path) -> Path:
    rc, out, err = run(["git", "rev-parse", "--git-dir"], cwd=root)
    if rc != 0:
        raise ToolError("不是 git 仓库：{}".format((err or out).strip()))
    path = Path(out.strip())
    return path if path.is_absolute() else (Path(root) / path)


def rebase_in_progress(root: Path) -> bool:
    try:
        git_dir = _git_dir(root)
    except ToolError:
        return False
    return (git_dir / "rebase-merge").exists() or (git_dir /
                                                   "rebase-apply").exists()


def commitlint_cli(config):
    override = config.commitlint.get("cli")
    if override:
        path = Path(override)
        return path if path.is_absolute() else Path(config.root) / path
    return find_module_js(config, "@commitlint/cli/cli.js")


def validate(config, message: str, rebase: bool = False) -> tuple:
    """返回 (是否通过, 说明列表)。结构性问题不进 commitlint，先短路。"""
    kind = classify(message)
    if kind == "empty":
        return False, ["提交信息为空（去掉注释后没有任何内容）"]
    if kind in ("merge", "revert"):
        return True, ["跳过校验：{} 提交".format(kind)]
    if kind == "fixup":
        if rebase:
            return True, ["跳过校验：rebase 进行中的 {} 提交".format("fixup/squash")]
        return False, [
            "fixup!/squash! 只允许在 rebase 过程中使用；"
            "普通提交请写完整信息，或用 `git commit --amend`"
        ]

    cli = commitlint_cli(config)
    node = find_node()
    if not node:
        raise ToolError("未找到 node，commitlint 无法运行（这是工具故障，不是提交信息不合规）")
    if cli is None or not Path(cli).is_file():
        raise ToolError(
            "未找到 @commitlint/cli（node_modules 或 vendor/node/node_modules），"
            "执行 `harness-style doctor` 查看缺什么")
    cfg = config.commitlint_config_path()
    if cfg is None:
        raise ToolError("未找到 commitlint.config.cjs，执行 `harness-style init`")

    rc, out, err = run(
        [node, str(cli), "--config",
         str(cfg), "--color", "false"],
        cwd=config.root,
        input_text=message + "\n",
        env=_node_env(config),
    )
    detail = (out + "\n" + err).strip()
    if rc == 0:
        return True, [detail] if detail else []
    if rc == 1:
        return False, [detail or "commitlint 拒绝了这条提交信息"]
    raise ToolError("commitlint 执行失败（退出码 {}）：{}".format(rc, detail[:800]))


def _node_env(config):
    """让 extends: ['@commitlint/config-conventional'] 能从工具 vendor 解析。

    commitlint 的 resolve-extends 以「配置文件所在目录」为起点做 node 解析，
    目标仓库没有 node_modules 时会 MODULE_NOT_FOUND。NODE_PATH 是官方支持的兜底，
    这样目标仓库可以零安装使用离线依赖。
    """
    paths = [str(p) for p in node_modules(config)]
    if not paths:
        return None
    env = dict(os.environ)
    env["NODE_PATH"] = os.pathsep.join(paths +
                                       [env.get("NODE_PATH", "")]).strip(
                                           os.pathsep)
    return env


def validate_file(config, path: Path) -> tuple:
    message = normalize(read_text(Path(path)))
    return validate(config,
                    message,
                    rebase=rebase_in_progress(Path(config.root)))
