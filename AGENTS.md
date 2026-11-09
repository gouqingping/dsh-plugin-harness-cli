# AGENTS.md

> 本文件是仓库入口地图，不是手册：约 100 行，细节都在 `docs/`，由 §8 链接过去。
> 由 `dsh-plugin-harness-cli agents` 从 `harness-cli.json` 生成 —— 要改内容就改配置再重新生成，不要手改。
> **开工前先问用户**：所有操作都等确认（手动），还是所有任务自动 loop（自动推进，所有确认 / 选择都采用推荐项）？未回答不开工。

## 1. 项目定位

公共项目配置工具：把 Harness 规范（入口 / 环境 / 范围 / 状态 / 门禁）变成可生成、可校验的配置。输入一份项目说明，输出一整套能被人和 Agent 直接使用的配置文件。

- 技术栈：JavaScript
- 运行环境：Node.js >= 18（零运行时依赖）
- 版本：0.1.1

## 2. 目录地图

| 路径 | 职责 |
|---|---|
| `plugin/bin/` | CLI 入口，只做参数转发与退出码 |
| `plugin/src/` | 实现：渲染、配置、探测、脚手架、判定、自检 |
| `plugin/templates/` | 生成物模板，文案的唯一真源 |
| `plugin/vendor/agent-style-harness/` | 随包的 harness-style（Python）：代码风格与提交信息判定，经 style 子命令调用 |
| `plugin/tests/` | node:test 用例，含“规则会失败”的反向用例 |
| `docs/adr/` | 设计决策记录 |

新增或移动目录时，在同一个改动里补一行 —— 这条是防止地图腐烂的唯一机械手段。

## 3. 常用命令

| 操作 | 命令 |
|---|---|
| 跑测试 | `node --test` |
| Lint | `node plugin/bin/dsh-plugin-harness-cli.js doctor` |
| 门禁（提交前必跑） | `node --test && node plugin/bin/dsh-plugin-harness-cli.js doctor` |
| 查看并行认领 | `node scripts/claim.js list` |
| 认领 / 释放任务 | `node scripts/claim.js add F-001 --owner <标识> --scope <路径>` |

以上命令失败即停：退出码非 0 就视为不通过，不要带着错误继续下一步。

## 4. 编码约定

- 零运行时依赖：只用 Node 内置模块；要引入依赖先写 ADR。
- 模板是唯一真源：文案改 templates/，不要在 src/ 里内联第二份。
- 新增子命令必须同时补 tests/ 用例与 README 用法表。
- 判定只读：check 不写盘，修复交给 init / agents。
- 退出码固定 0 / 1 / 2，与 harness-style 对齐，便于串进同一条门禁。
- 并行推进靠认领：开工先 `node scripts/claim.js add <F-xxx> --owner <会话/Agent 标识> --scope <路径>`；认出上限或 scope 冲突说明该换任务，不要硬上。
- 长任务定期 `node scripts/claim.js heartbeat <F-xxx> --owner <标识>`：心跳超过 12h 会被判成死掉的 loop。

## 5. 工作流

1. 先读 `README.md` 与 `docs/adr/ADR-0001-harness-cli.md`，确认改动落在哪一层：模板、判定还是 CLI。
2. 改 `plugin/templates/` 或 `plugin/src/`；新增判定必须同时加一条“它真的会失败”的用例。
3. 跑 `node --test` 与 `node plugin/bin/dsh-plugin-harness-cli.js doctor`，两者都绿才算过。
4. 文案类改动只改模板，不在代码里再写一份。
5. 行为变化同步 README 用法表与生成源 `harness-cli.json`，必要时补 ADR。

### 5.2 并行 loop（认领）

多个会话 / 多个 Agent 可以同时推进，但谁做哪个任务、会改哪些文件必须写在仓库里：

- 开工先认领：`node scripts/claim.js add F-003 --owner <会话/Agent 标识> --scope <路径>`；
  被拒（已有人认领 / 超过 `wipLimit` / scope 冲突）就换任务，不要硬上。
- 只改自己 scope 里的文件；要跨 scope 先 `release`，拆小范围重新认领。
- 长任务定期心跳：`node scripts/claim.js heartbeat F-003 --owner <标识>`（超过 12h 没心跳会被当死 loop）。
- 收工释放：`node scripts/claim.js release F-003`，再推进 `docs/feature_list.json` 状态与进度日志。
- 看清谁在做什么：`node scripts/claim.js list`；认领约定见 `docs/claims/README.md`。

## 6. 禁止事项

- 不覆盖已存在的非空文件（除显式 --force）；状态文件连 --force 也不覆盖。
- 不在 check 里改文件，也不静默降级：配置坏就退出 2。
- 不把规则只写进文档或提示词：规则必须落在 templates/ 或 check 的判定里。
- 不引入 npm 依赖（离线环境装不上就等于坏了）。
- 不在模板里写死本仓库的路径与版本号。
- 不在 plugin/ 之外放可执行代码：外壳只留文档与配置。
- 不在没有认领的情况下把 feature 置为 in_progress，也不改别人 scope 里的文件。

## 7. 完成定义（DoD）

把 `done` 从感觉变成可勾选条件，缺一条就不算完成：

- [ ] `acceptance` 逐条核对通过，每条能说出验证方式。
- [ ] `node --test` 全绿，新增判定有对应的失败用例。
- [ ] `node plugin/bin/dsh-plugin-harness-cli.js doctor` 无错误。
- [ ] README 的用法表与实际子命令一致。
- [ ] 模板里没有写死本仓库路径或版本号的文案。
- [ ] 行为变化已记进 ADR 或 README。
- [ ] 收工已 `node scripts/claim.js release <F-xxx>`，认领与 feature 状态一致。
- [ ] `node scripts/claim.js verify` 通过：每个 in_progress 都有认领，scope 不重叠。

## 8. 深入阅读

- 工具说明与用法：`README.md`
- 设计决策（零依赖 / docs 功能清单 / _VERSIONS / 状态文件保护）：`docs/adr/ADR-0001-harness-cli.md`
- 模板目录（生成物文案的唯一真源）：`plugin/templates/`

> 本文件超过 120 行说明写成了手册。超出部分拆到 `docs/`，在这里只留链接。
