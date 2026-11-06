from .vendor import TOOL_ROOT


def rules_map(config) -> dict:
    """engine/code → Style Guide 章节链接。

    目标仓库可用 .harness-style/rules.map.json 覆盖 / 补充工具自带的映射；
    覆盖的意义是各项目的规范版本可能不同。
    """
    import json
    from pathlib import Path

    merged = {}
    candidates = [
        TOOL_ROOT / "rules.map.json",
        Path(config.root) / ".harness-style" / "rules.map.json",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for key, value in data.items():
            if isinstance(value, str):
                merged[key] = value
            elif isinstance(value, dict):
                merged[key] = value.get("doc", "")
    return merged
