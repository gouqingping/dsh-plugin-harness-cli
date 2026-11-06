from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

CONFIG_NAME = "harness-style.json"

# 每个语言允许的最低/最高严重级别由配置决定；这里只做合法性校验
VALID_SEVERITIES = ("error", "warning")


class ConfigError(Exception):
    pass


@dataclass
class LangConfig:
    name: str
    enabled: bool = True
    engine: str = ""
    severity: str = "error"
    options: Optional[dict] = None


@dataclass
class Config:
    path: Path
    root: Path
    raw: dict
    languages: Dict[str, LangConfig]
    exclude: List[str]
    commitlint: dict
    vendor_dir: Optional[Path]

    @property
    def profile(self) -> str:
        return self.raw.get("profile", "google")

    def language(self, name: str) -> Optional[LangConfig]:
        return self.languages.get(name)

    def severity_cap(self, name: str) -> str:
        lang = self.languages.get(name)
        return lang.severity if lang else "error"

    def commitlint_config_path(self) -> Optional[Path]:
        candidate = self.root / "commitlint.config.cjs"
        return candidate if candidate.exists() else None


def find_config(start: Optional[Path] = None) -> Path:
    current = (start or Path.cwd()).resolve()
    for directory in [current] + list(current.parents):
        candidate = directory / CONFIG_NAME
        if candidate.is_file():
            return candidate
    raise ConfigError("未找到 {}（从 {} 向上查找）。先运行 `harness-style init`。".format(
        CONFIG_NAME, current))


def load(path: Optional[Path] = None, start: Optional[Path] = None) -> Config:
    config_path = Path(path).resolve() if path else find_config(start)
    if not config_path.is_file():
        raise ConfigError("配置文件不存在：{}".format(config_path))
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError("配置不是合法 JSON：{}:{}: {}".format(
            config_path, exc.lineno, exc.msg))
    except OSError as exc:
        raise ConfigError("无法读取配置 {}：{}".format(config_path, exc))

    if raw.get("version") != 1:
        raise ConfigError("不支持的配置版本：{!r}（期望 1）".format(raw.get("version")))

    languages_raw = raw.get("languages") or {}
    if not isinstance(languages_raw, dict):
        raise ConfigError("languages 必须是对象")

    languages: Dict[str, LangConfig] = {}
    for name, spec in languages_raw.items():
        if not isinstance(spec, dict):
            raise ConfigError("languages.{} 必须是对象".format(name))
        severity = spec.get("severity", "error")
        if severity not in VALID_SEVERITIES:
            raise ConfigError(
                "languages.{}.severity 只能是 error/warning，实际 {!r}".format(
                    name, severity))
        languages[name] = LangConfig(
            name=name,
            enabled=bool(spec.get("enabled", True)),
            engine=spec.get("engine", ""),
            severity=severity,
            options=spec,
        )

    exclude = raw.get("exclude") or []
    if not isinstance(exclude, list):
        raise ConfigError("exclude 必须是数组")

    commitlint = raw.get("commitlint") or {}
    if not isinstance(commitlint, dict):
        raise ConfigError("commitlint 必须是对象")

    vendor = raw.get("vendorDir")
    vendor_dir = (config_path.parent / vendor).resolve() if vendor else None

    return Config(
        path=config_path,
        root=config_path.parent,
        raw=raw,
        languages=languages,
        exclude=[str(p) for p in exclude],
        commitlint=commitlint,
        vendor_dir=vendor_dir,
    )
