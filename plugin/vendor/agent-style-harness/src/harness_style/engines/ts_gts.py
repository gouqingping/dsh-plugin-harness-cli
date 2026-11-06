from __future__ import annotations

import json
from pathlib import Path

from ..util import ToolError, relpath, run
from ..vendor import find_module_js, find_node
from .base import Engine


class GtsEngine(Engine):
    """gts 只提供规则集；这里直接调它捆绑的 eslint。

    原因：`gts lint` 的 glob 固定为 **/*.ts，无法只检查暂存文件。
    用 eslint 显式传文件，才能做到增量判定（ADR §5.3）。
    """

    name = "gts"
    languages = ("typescript", )

    def _eslint(self):
        return find_module_js(self.config, "eslint/bin/eslint.js")

    def _node(self):
        return find_node()

    def available(self) -> bool:
        return bool(self._node() and self._eslint())

    def unavailable_reason(self) -> str:
        if not self._node():
            return "未找到 node（>=18）"
        return "未找到 eslint；请安装 gts 到项目或 vendor/node"

    def version(self) -> str:
        js = self._eslint()
        node = self._node()
        if not js or not node:
            return "unknown"
        rc, out, err = run([node, js, "--version"], cwd=self.root)
        return (out or err).strip() if rc == 0 else "unknown"

    def _run(self, args):
        node = self._node()
        js = self._eslint()
        if not node or not js:
            raise ToolError(self.unavailable_reason())
        return run([node, js] + args, cwd=self.root)

    def check(self, files):
        rc, out, err = self._run([
            "--format", "json", "--no-color", "--no-error-on-unmatched-pattern"
        ] + [str(f) for f in files])
        # eslint: 0 无问题，1 有 error，2 配置/内部错误
        if rc not in (0, 1):
            raise ToolError("eslint 执行失败：{}".format((err
                                                     or out).strip()[:800]))
        if not out.strip():
            return []
        try:
            report = json.loads(out)
        except json.JSONDecodeError as exc:
            raise ToolError("无法解析 eslint JSON 输出：{}".format(exc))

        violations = []
        for entry in report:
            path = entry.get("filePath") or ""
            for msg in entry.get("messages", []):
                fatal = bool(msg.get("fatal"))
                violations.append(
                    self.make(
                        code=msg.get("ruleId")
                        or ("parse-error" if fatal else "unknown"),
                        path=path,
                        line=msg.get("line", 1),
                        column=msg.get("column", 1),
                        message=msg.get("message", ""),
                        fixable=bool(msg.get("fix")) and not fatal,
                    ))
                if fatal:
                    violations[-1].severity = "error"
        return violations

    def fix(self, files):
        before = {relpath(f, self.root): f.read_bytes() for f in files}
        rc, out, err = self._run(["--fix", "--no-color"] +
                                 [str(f) for f in files])
        if rc not in (0, 1):
            raise ToolError("eslint --fix 失败：{}".format(
                (err or out).strip()[:800]))
        changed = []
        for rel, path in before.items():
            try:
                if path.read_bytes() != before[rel]:
                    changed.append(rel)
            except OSError:
                continue
        return changed
