from __future__ import annotations

import os
from pathlib import Path

from .vendor import TOOL_ROOT

SKILL_NAME = "google-style-guard"
BEGIN = "<!-- harness-style:begin -->"
END = "<!-- harness-style:end -->"

AGENTS_BLOCK = """{begin}
## 代码规范（强制 · 由 harness-style 维护）

- 提交前必须让 `harness-style check --staged` 返回 `0`。返回 `1` 先跑 `harness-style fix --staged`；
  返回 `2` 是工具故障，跑 `harness-style doctor`，**不要改代码去凑**。
- 提交信息必须通过 `harness-style commit-msg <file>`（Conventional Commits）。
- 禁止 `git commit --no-verify`；禁止修改 `.githooks/` 或 `.harness-style/baseline.json` 让检查通过。
- `fixable: false` 的违规不得静默忽略：在提交信息 body 或 PR 描述里逐条列出。
- 汇报完成必须附命令与退出码。"已遵守规范"不算证据。
{tool_hint}{end}
"""


def source_skill() -> Path:
    return TOOL_ROOT / "skill" / SKILL_NAME / "SKILL.md"


def dsh_home() -> Path:
    return Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))


def target_path(root: Path, scope: str) -> Path:
    if scope == "user":
        return dsh_home() / "skills" / SKILL_NAME / "SKILL.md"
    return Path(root) / ".dsh" / "skills" / SKILL_NAME / "SKILL.md"


def install(root: Path,
            scope: str = "project",
            tool_path: Path = None,
            overwrite: bool = True) -> Path:
    """把 skill 复制到 DSH 的扫描目录。

    DSH 的 filesystem provider 只扫描根目录**顶层**的 <name>/SKILL.md，
    不支持嵌套，所以不能直接把仓库里的 skill/ 目录当成安装位置。
    """
    src = source_skill()
    if not src.is_file():
        raise FileNotFoundError("找不到 skill 源文件：{}".format(src))
    dest = target_path(root, scope)
    if dest.exists() and not overwrite:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    text = src.read_text(encoding="utf-8")
    if tool_path:
        text = text.rstrip("\n") + "\n\n## 本机路径\n\n- 本机 CLI：`{}`\n".format(
            Path(tool_path).resolve())
    dest.write_text(text, encoding="utf-8")
    return dest


def upsert_agents(root: Path, tool_path: Path = None) -> tuple:
    """把硬约束写进目标仓库的 AGENTS.md（幂等）。

    DSH 的 agent-instructions 会从项目根到 cwd 逐级加载 AGENTS.md，
    写在项目根即可被同一仓库内所有子目录的会话继承。

    条款里统一用 `harness-style`（不带绝对路径），保证 AGENTS.md 可提交、
    对同事可读；本机路径只是附注。
    """
    path = Path(root) / "AGENTS.md"
    hint = ""
    if tool_path:
        hint = "\n> 本机 CLI 路径（未加入 PATH 时使用）：`{}`\n".format(
            Path(tool_path).resolve())
    block = AGENTS_BLOCK.format(begin=BEGIN, end=END, tool_hint=hint)

    if not path.exists():
        path.write_text(block, encoding="utf-8")
        return path, "created"

    text = path.read_text(encoding="utf-8")
    if BEGIN in text and END in text:
        head, rest = text.split(BEGIN, 1)
        _, tail = rest.split(END, 1)
        path.write_text(head + block.rstrip("\n") + tail, encoding="utf-8")
        return path, "updated"

    separator = "" if text.endswith("\n\n") else (
        "\n" if text.endswith("\n") else "\n\n")
    path.write_text(text + separator + block, encoding="utf-8")
    return path, "appended"
