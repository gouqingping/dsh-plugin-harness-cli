from __future__ import annotations

import glob
import shutil
from pathlib import Path

from ..util import ToolError, run
from .base import Engine


class GoogleJavaFormatEngine(Engine):
    """google-java-format：刻意没有配置项，风格内置。"""

    name = "google-java-format"
    languages = ("java", )

    def _jar(self):
        for root in (self.root, self.root.parent):
            pattern = str(root / "google-java-format*.jar")
            for hit in sorted(glob.glob(pattern)):
                return Path(hit)
        from ..vendor import roots

        for base in roots(self.config):
            for hit in sorted(glob.glob(str(base / "java" / "*.jar"))):
                return Path(hit)
        return None

    def _java(self):
        found = shutil.which("java")
        return Path(found) if found else None

    def available(self) -> bool:
        return bool(self._java() and self._jar())

    def unavailable_reason(self) -> str:
        if not self._java():
            return "未找到 java（需要 JRE 17+）"
        return "未找到 google-java-format jar（vendor/java/*.jar）"

    def version(self) -> str:
        jar, java = self._jar(), self._java()
        if not jar or not java:
            return "unknown"
        rc, out, err = run([java, "-jar", jar, "--version"], cwd=self.root)
        return (out or err).strip() if rc == 0 else "unknown"

    def check(self, files):
        java, jar = self._java(), self._jar()
        if not java or not jar:
            raise ToolError(self.unavailable_reason())
        rc, out, err = run(
            [java, "-jar", jar, "--dry-run", "--set-exit-if-changed"] +
            [str(f) for f in files],
            cwd=self.root,
        )
        # gjf: 0 无需修改，1 有文件需要格式化
        if rc == 0:
            return []
        if rc != 1:
            raise ToolError("google-java-format 失败：{}".format(
                (err or out).strip()[:800]))

        reported = set()
        for line in (out + "\n" + err).splitlines():
            candidate = line.strip()
            if candidate and Path(candidate).suffix == ".java":
                reported.add(candidate)

        violations = []
        for path in files:
            # 输出只给文件名，无法定位行；统一报在第 1 行
            if reported and str(
                    path) not in reported and path.name not in reported:
                continue
            violations.append(
                self.make(
                    "format",
                    path,
                    line=1,
                    message="google-java-format 判定格式不符",
                    fixable=True,
                ))
        return violations

    def fix(self, files):
        java, jar = self._java(), self._jar()
        if not java or not jar:
            raise ToolError(self.unavailable_reason())
        before = {str(f): f.read_bytes() for f in files}
        rc, out, err = run([java, "-jar", jar, "--replace"] +
                           [str(f) for f in files],
                           cwd=self.root)
        if rc != 0:
            raise ToolError("google-java-format --replace 失败：{}".format(
                (err or out).strip()[:500]))
        return [
            str(Path(p)) for p, data in before.items()
            if Path(p).read_bytes() != data
        ]
