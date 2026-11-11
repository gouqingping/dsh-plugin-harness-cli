# ADR-0002：同时发布 DSH 与 Codex 插件

- 状态：已接受
- 日期：2026-11-11
- 相关：ADR-0001、`codex plugin marketplace add`、MCP stdio

## 1. 背景

本仓库目前以 DSH（Cordis）插件发布，根 `package.json` 的 `main` 导出 `apply(ctx)`，
再通过 `cordis.patch.yml` 注册 13 个工具和一条聚合斜杠命令。

Codex 插件使用另一套入口：根目录的 `.codex-plugin/plugin.json` 描述展示信息与资源，
`skills/` 提供可按需加载的工作流，`.mcp.json` 可以把本地 stdio MCP 服务注册为模型工具。
Codex 市场从 `.agents/plugins/marketplace.json` 读取可安装插件索引。

用户要求同一个项目同时支持两个宿主。若只增加一份 Codex 技能说明，用户仍要手工拼 CLI 参数；
若另写一套工具实现，又会与 DSH 的 13 个工具漂移。因此两条宿主链路必须共享业务实现。

## 2. 决策

采用“双适配层、单业务核心”的结构：

```text
                    plugin/src/ + plugin/templates/
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
       plugin/cordis.mjs             plugin/codex-mcp.mjs
          (DSH tools)                  (Codex MCP)
                 │                           │
        cordis.patch.yml                 .mcp.json
                                               │
                                     .codex-plugin/plugin.json
                                               │
                                          skills/
```

- `plugin/src/` 与 `plugin/templates/` 继续是唯一业务实现和文案真源。
- DSH 继续由 `plugin/cordis.mjs` 把工具注册到 Cordis，不改现有调用方式。
- Codex 新增零依赖 stdio MCP 服务 `plugin/codex-mcp.mjs`，直接复用 `cordis.mjs` 导出的
  `TOOL_SPECS` 与 `runCli`，只负责 MCP 握手、工具列出、参数校验和结果封装。
- Codex 工具名与 DSH 完全一致，仍为 `harness_cli_check` 等 13 个工具。
- Codex 的 MCP 工具要求显式传 `root`。MCP 服务的工作目录属于插件包，不是用户仓库；
  强制显式传根目录可以避免把目标仓库误判成插件包。
- 新增 `skills/harness-cli/SKILL.md`，负责 Codex 的操作流程：开工前先问手动 / 自动 loop、
  写入前先 `dry_run`、破坏性操作先取得用户明确确认、交付前跑 `check` 和 `doctor`。
- 根 `.codex-plugin/plugin.json` 只声明 Codex 元数据、技能目录和 MCP 配置；
  不把主入口改成 Codex，避免破坏 DSH 的 `main` 与市场收录约束。
- 根 `.agents/plugins/marketplace.json` 把当前仓库根目录作为唯一插件来源，
  用户可先添加 Git 市场，再按插件名安装。

## 3. 接口与错误语义

### MCP 请求

- `initialize`：返回请求中的协议版本（缺省为 `2025-06-18`）、`tools` 能力和服务信息。
- `notifications/initialized`：只确认收到，不返回响应。
- `ping`：返回空结果。
- `tools/list`：返回 13 个工具；每个 `inputSchema` 都在 `required` 中包含 `root`。
- `tools/call`：调用对应 CLI 子命令；CLI 退出码非 0 时返回 `isError: true`，
  同时保留完整文本，模型可据此修复并重试。
- 未知工具、缺失 `root`、未知请求方法：返回 JSON-RPC 错误或可读的工具错误，不崩溃、不静默成功。

### 安全边界

- `check` / `doctor` 仍只读。
- `init --force`、`plan --confirm`、`delete` 等破坏性或确认类操作仍由命令参数约束；
  Codex 技能要求先向用户展示影响并取得明确确认。
- Codex MCP 不写全局配置、不联网、不上传数据；文件只写入显式 `root` 指向的目录。
- 可选的 `plans --serve` 面板只接受回环 `Host`，写操作还要求同源 `Origin` 与
  `application/json`，防止 DNS 重绑定、跨站表单和简单请求触发删除或保存。

## 4. 被否决方案

| 方案 | 否决理由 |
|---|---|
| 只提供 Codex `SKILL.md`，让模型自己拼 CLI | 工具发现、参数 schema 和错误语义都不稳定，且无法做到与 DSH 的 13 个工具对齐 |
| 把 Codex 设为根 `main` | 会破坏 DSH Cordis 入口和现有市场收录 |
| 在 `codex-mcp.mjs` 重写各子命令 | 形成第二套业务逻辑，后续必然漂移 |
| 引入 MCP SDK | 违反“零运行时依赖、离线可用”约束 |
| MCP 默认使用 `process.cwd()` | Codex 启动 MCP 时的目录通常是插件根目录，可能误写插件包而不是用户项目 |

## 5. 实施计划

### Task 1：先写失败的 Codex 插件契约测试

**文件**

- 新建：`plugin/tests/codex-plugin.test.js`

**接口**

- 读取根 `.codex-plugin/plugin.json`、`.mcp.json`、`.agents/plugins/marketplace.json`
- 启动 `plugin/codex-mcp.mjs`，用 JSON-RPC 行协议验证握手、`tools/list`、`tools/call`

**步骤**

- [x] 添加静态契约测试：清单字段、技能路径、MCP 路径、市场来源都存在。
- [x] 添加 MCP 测试：13 个工具、每个 schema 必填 `root`、缺 `root` 会失败。
- [x] 添加真实调用测试：在临时仓库执行 `init` 后，通过 MCP 调 `harness_cli_check`，退出码为 0。
- [x] 运行 `node --test plugin/tests/codex-plugin.test.js`，确认因文件缺失而失败。

### Task 2：实现 Codex MCP 适配层

**文件**

- 新建：`plugin/codex-mcp.mjs`
- 修改：`plugin/package.json` 的 `files`

**接口**

- 消费：`TOOL_SPECS`、`runCli`、`resolveRoot`（来自 `plugin/cordis.mjs`）
- 生产：stdio JSON-RPC MCP 服务，工具名、描述、参数 schema 与 DSH 同源

**步骤**

- [x] 实现 JSON-RPC 行读取、响应与通知忽略。
- [x] 实现 `initialize`、`ping`、`tools/list`、`tools/call`。
- [x] 在 MCP 暴露的 schema 中把 `root` 加入 `required`，并拒绝缺失或空字符串。
- [x] 用 `spec.buildArgs(input)` 生成 CLI 参数，用 `runCli(argv, {cwd: root})` 执行。
- [x] 把 stdout、stderr 与退出码拼进 `content[0].text`；非 0 时设置 `isError: true`。
- [x] 运行目标测试并确认通过。

### Task 3：增加 Codex 清单、技能与 Git 市场

**文件**

- 新建：`.codex-plugin/plugin.json`
- 新建：`.mcp.json`
- 新建：`.agents/plugins/marketplace.json`
- 新建：`skills/harness-cli/SKILL.md`
- 新建：`skills/harness-cli/agents/openai.yaml`
- 修改：根 `package.json` 的 `files`

**步骤**

- [x] 清单保持名称 `dsh-plugin-harness-cli`、版本与根包一致、许可证 `CC0-1.0`。
- [x] `.mcp.json` 使用 `node ./plugin/codex-mcp.mjs`，工作目录为插件根目录。
- [x] 技能写明两种操作模式、显式 `root`、`dry_run` 优先和交付门禁。
- [x] 市场索引把 `source.local.path` 指向 `"."`。
- [x] 将根包 `files` 补入 `.codex-plugin/**`、`.agents/**`、`.mcp.json`、`skills/**`。
- [x] 运行目标测试并确认通过。

### Task 4：同步文档并完成全量验证

**文件**

- 修改：`README.md`
- 修改：`README-INSTALL.md`
- 修改：`docs/MARKETPLACE.md`
- 修改：`plugin/tests/listing.test.js`
- 修改：`harness-cli.json`（只补目录地图与行为约定，必要字段）

**步骤**

- [x] README 同时给出 DSH 与 Codex 安装、使用和权限说明。
- [x] 安装文档写清 Codex 市场添加、插件安装、卸载与本地 MCP 验证。
- [x] 市场文档记录 Codex 清单与 Git 市场入口。
- [x] `codex-plugin.test.js` 断言双平台清单位置、MCP 工具与发布包内容。
- [x] 运行 `node --test`、`node plugin/bin/dsh-plugin-harness-cli.js doctor`。
- [x] 用临时 `CODEX_HOME` 验证 `codex plugin marketplace add` 与 `codex plugin add`。

验证结果（2026-11-11）：

- `node --test`：148 个用例全部通过。
- `doctor`：0 个错误；仅报告当前快照不是 Git 仓库。
- `npm pack --dry-run --json`：Codex 清单、市场、技能、MCP 文件均进入发布包。
- Codex CLI 0.144.6 隔离安装：插件为 `installed, enabled`，MCP 列表出现
  `harness-cli`，命令参数为 `node ./plugin/codex-mcp.mjs`。

## 6. 验收标准

1. DSH 原有 13 个工具与 `/harness-cli` 命令不变，全部既有测试通过。
2. Codex 插件清单、技能、市场和 MCP 配置均存在且相互引用有效。
3. Codex MCP 暴露 13 个同名工具，参数 schema 与 DSH 同源，并强制显式 `root`。
4. 临时仓库经 MCP `harness_cli_check` 调用能返回真实门禁结果。
5. `node --test` 与 `doctor` 全绿；Codex 临时市场安装验证通过。
6. 文案与安装说明不写死本机路径或未来版本号。

## 7. 已知限制

- Codex 侧没有 DSH 的 `userQuestions` 弹窗，因此覆盖、确认和删除必须由技能要求模型先向用户确认，
  再显式传对应参数。
- Codex MCP 需要每次传目标仓库绝对路径；这是为了避免误用插件包工作目录。
- Codex 插件清单依赖当前 Codex 0.144.x 的本地格式；后续格式变化应在新的 ADR 中升级。
