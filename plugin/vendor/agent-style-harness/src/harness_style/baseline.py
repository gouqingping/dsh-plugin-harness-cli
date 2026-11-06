from __future__ import annotations

import json
from pathlib import Path

from .util import ToolError

DIRNAME = ".harness-style"
FILENAME = "baseline.json"


def path_for(config) -> Path:
    return Path(config.root) / DIRNAME / FILENAME


def load(config) -> dict:
    path = path_for(config)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ToolError(
            "baseline 文件损坏，执行 `harness-style baseline update` 重建：{}".format(
                exc))
    if data.get("version") != 1:
        return {}
    return dict(data.get("counts") or {})


def apply(config, violations):
    """按 (file|engine|code) 计数抑制历史违规。

    只抑制计数以内的部分：第 N+1 条同类违规仍然会报出来，
    这样"修好一条又新增一条"不会被 baseline 吞掉。
    """
    allowed = load(config)
    if not allowed:
        return violations, 0
    used = {}
    remaining = []
    suppressed = 0
    for violation in violations:
        key = violation.key()
        limit = allowed.get(key, 0)
        if used.get(key, 0) < limit:
            used[key] = used.get(key, 0) + 1
            suppressed += 1
        else:
            remaining.append(violation)
    return remaining, suppressed


def write(config, violations) -> Path:
    counts = {}
    for violation in violations:
        key = violation.key()
        counts[key] = counts.get(key, 0) + 1
    path = path_for(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "generated_by": "harness-style baseline update",
        "counts": dict(sorted(counts.items())),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    return path
