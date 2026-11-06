---
name: google-style-guard
description: 在修改代码后、提交前，用离线 CLI harness-style 检查 Google 代码风格并校验 commitlint 提交信息。当用户要求提交代码、修复代码风格、或检查提交信息格式时使用。
---

# Google Style Guard

规则的唯一判定者是 `harness-style` CLI。你（agent）不判断代码是否符合规范，**你负责调用它并转述结果**。

## 何时用

- 改完任何代码之后（尤其是准备 `git commit` 之前）
- 用户报告"格式检查失败"或"提交被拒绝"时
- 需要确认提交信息格式时

## 命令表

| 场景 | 命令 |
|---|---|
| 检查暂存区（默认，hook 同款） | `harness-style check --staged` |
| 检查全部改动 | `harness-style check --all` |
| 机器可读结果 | `harness-style check --staged --json` |
| 自动修复 | `harness-style fix --staged` |
| 校验某条提交信息 | `harness-style commit-msg <file>` |
| 环境坏了 | `harness-style doctor` |

`harness-style` 不在 PATH 时，用仓库内的 `./bin/harness-style`。

## 修复循环（严格遵守）

1. 先 `fix`，再 `check`。
2. `check` 返回 `0` → 继续下一步。
3. 返回 `1` → 看 `fixable`：
   - `true`：再跑一次 `fix`，但**同一文件最多 2 轮**。
   - `false`：不要硬改，把它连同 `file:line` 原样上报，让用户决定。
4. 返回 `2` → **工具故障，不是违规**。跑 `doctor`，把输出贴给用户，不要改代码。
5. 2 轮后仍有违规 → 停止，输出剩余清单与命令输出，不要自行发挥。

## 退出码语义（不要混淆）

| code | 含义 | 你的动作 |
|---|---|---|
| 0 | 通过 | 可以提交 |
| 1 | 有违规 | 修复或上报 |
| 2 | 工具/依赖故障 | 上报，禁止改代码"绕过" |

## 工具管不了的条款（提交前自查）

工具只覆盖可机械判定的部分。以下需要你自己过一遍：

- [ ] 命名是否表达了真实语义（不是 `data` / `tmp` / `foo`）
- [ ] 公开函数/类型是否有意义明确的文档注释（不是复述签名）
- [ ] 错误处理：异常是否被吞掉？边界条件是否覆盖？
- [ ] 是否有为了过检查而写的空实现、`pass`、`TODO` 占位
- [ ] 新增依赖/配置是否真的必要

## 禁止

- 禁止 `git commit --no-verify`
- 禁止修改 `.githooks/`、`.harness-style/baseline.json` 来让检查通过
- 禁止在报告里写"已符合规范"而不附退出码

## 证据格式

汇报时贴这两行（原样，不要改写）：

```
$ harness-style check --staged
exit code: 0
```
