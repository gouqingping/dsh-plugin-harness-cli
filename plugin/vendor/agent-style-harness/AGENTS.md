# AGENTS.md

本仓库的规则入口。**这些是硬约束，不是建议。**

## 代码规范（强制）

1. 任何代码改动在 `git commit` 前，必须使：

   ```sh
   ./bin/harness-style check --staged
   ```

   返回 `0`。返回 `1` 先跑 `./bin/harness-style fix --staged`；返回 `2` 说明工具本身坏了，
   **不要改代码去"修复"它**，先跑 `./bin/harness-style doctor`。

2. 提交信息必须符合 Conventional Commits，并且能通过：

   ```sh
   ./bin/harness-style commit-msg <msg-file>
   ```

3. 禁止 `git commit --no-verify`；禁止修改 `/.githooks/` 下的文件（`doctor` 会校验 sha256）。
4. 无法自动修复的违规（`fixable: false`）不得静默忽略，必须：
   - 在提交信息 body 或 PR 描述里逐条列出，或
   - 明确降级理由并修改 `harness-style.json`（降级必须留痕）。
5. 汇报"已完成"时，必须附上检查命令与退出码。**"我已经遵守规范了"不是证据。**

## 修改规范配置时

- 规则在 `harness-style.json`、`templates/`、`rules.map.json` 里，**不要**把规则写进提示词或文档充当约束。
- 新增规则或 `overrides` 时，同步更新 `rules.map.json` 的 `doc` 字段（指向 Style Guide 章节）。
- 把某条规则从 `error` 降为 `warning`，必须在 `docs/adr/` 里留下记录。

## 工作方式

- 改动前先读 `docs/adr/ADR-0001-style-harness.md`，尤其是 §6.2（配置文件）与 §9（Agent 侧边界）。
- 遵循"最小覆盖"：不要覆盖工具 preset 已经正确的项。
- 在同一个文件上 `fix` 超过 2 轮仍失败，停止自动修改，上报原文与违规清单。
