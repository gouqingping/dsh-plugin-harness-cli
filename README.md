# dsh-plugin-harness-cli

> **DSH / Codex 插件**：同一个包在 DSH 里提供 14 个工具（`harness_cli_*`）与 1 条聚合斜杠命令
> （`/harness-cli`），在 Codex 里通过本地 MCP 提供同样的 14 个工具和一条 `$harness-cli` 技能；
> 两个宿主共用 `src/`、`templates/` 与业务执行，不靠提示词各自发挥。

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/gouqingping/dsh-plugin-harness-cli)

## 安装（DSH 插件市场）

```sh
# npm 最新发布 0.1.6-rc
dsh plugin --profile web add dsh-plugin-harness-cli

# 只从源码安装（不需要 npm 包，也能用）
dsh plugin --profile web add github:gouqingping/dsh-plugin-harness-cli
```

装完重启 DSH，然后在任意项目里执行 `/harness-cli` 并选「初始化」；命令与工具清单见 `/harness-cli help`；从开工到收尾的完整流程见 `/harness-cli help process`（别名 `flow` / `workflow` / `流程`）。

## 安装（Codex 插件市场）

```sh
# Git 市场；固定版本时在仓库名后加 @<ref>
codex plugin marketplace add gouqingping/dsh-plugin-harness-cli
codex plugin add dsh-plugin-harness-cli@dsh-plugin-harness-cli

# 本地开发时直接添加当前仓库
codex plugin marketplace add .
```

新开一个 Codex 会话后，插件会加载 `$harness-cli` 技能并启动本地 stdio MCP 服务。
模型通过 `harness_cli_*` 工具调用现有 CLI；Codex 侧没有 DSH 的确认弹窗，所以覆盖、方案确认与删除
都要求模型先向你说明影响并取得明确同意。检查安装状态：

```sh
codex plugin list
codex mcp list
```

> 收录状态、提交模板与自查项见 [`docs/MARKETPLACE.md`](docs/MARKETPLACE.md)；
> `node --test` 里的 `listing.test.js` 会断言仓库内的收录要求。

| 项 | 值 |
|---|---|
| 一句话价值 | 把「项目怎么协作」变成可生成、可校验的文件：入口 / 环境 / 范围 / 状态 / 门禁 / 规范文档 / 业务 wiki 全自动，模型直接调用。 |
| 能力分类 | 开发与运维 |
| 支持 profile | `web`、`desktop`（默认值 `web`，见安装命令） |
| 兼容与运行要求 | DSH 0.2.x（安装与 profile 合成在 0.2.2-rc.1 验证；桌面端 profile 名为 `desktop`）；Codex CLI 0.144.x（插件市场与本地 MCP）；Node.js ≥ 18；零运行时依赖、离线可用；`style` 子命令需要本机 `python3` |
| 权限与外部服务 | 只读写**目标仓库内**的文件；不联网、不收集数据；`plans --serve` 仅监听 `127.0.0.1`，并校验回环 Host、同源 Origin 与 JSON 写入请求（可选） |
| 许可证 | CC0-1.0（公共领域奉献，见 [LICENSE](LICENSE)） |
| 打包形态 | DSH：根 `package.json` + `cordis.patch.yml`（`dsh.bundle.patch`），`main` 导出 `apply(ctx)`；Codex：`.codex-plugin/plugin.json` + `.mcp.json` + `skills/` + `.agents/plugins/marketplace.json` |

数据处理方式见 [PRIVACY.md](PRIVACY.md)，使用条款见 [TERMS.md](TERMS.md)。

### 真实输出（演示）

```
$ dsh-plugin-harness-cli init --preset prototype
  CREATE  harness-cli.json / AGENTS.md / init.sh / scripts/gate.sh / docs/feature_list.json …
  CREATE  prototype/README.md / prototype/progress.html / scripts/prototype-check.js
已写入 20 项，跳过 0 项

$ dsh-plugin-harness-cli plan 登录页面
  CREATE  docs/specs/登录页面/{proposal,spec,design,tasks}.md
  WRITE   prototype/登录页面/{progress,plan}.html（契约 / 用例 / 规划已同步）
  规范文档：写入 4 篇，保留 0 篇

$ dsh-plugin-harness-cli check
  OK    A102   AGENTS.md 八节齐全
  OK    F107   WIP 正常（in_progress = 0 / 上限 1）
  OK    C201   in_progress 全部有认领（0 个）
  合计 23 项：错误 0，警告 2。结果：通过（有警告）✓
```

公共项目配置工具：按 Harness Engineering 规范，为任意仓库生成**四件套 + 门禁 + 状态文件**，
并让 `AGENTS.md` 由配置直接生成、由 `check` 校验。零运行时依赖，离线可用。

```sh
node plugin/bin/dsh-plugin-harness-cli.js init --preset prototype   # 生成配置与骨架
node plugin/bin/dsh-plugin-harness-cli.js agents                    # 只重生成 AGENTS.md
node plugin/bin/dsh-plugin-harness-cli.js check                     # 规则自检（只读）
node plugin/bin/dsh-plugin-harness-cli.js style check --staged      # 代码风格 / 提交信息
```

## 1. 目录结构

```
common-agent/                    ← 工作区里的项目目录
├── plugin/                      ← 插件本体（包名 dsh-plugin-harness-cli）
│   ├── bin/                     CLI 入口
│   ├── src/                     实现
│   ├── templates/               生成物模板（文案唯一真源）
│   ├── cordis.mjs               DSH 适配层：把子命令注册成工具与斜杠命令（导入 DSH 时用）
│   ├── codex-mcp.mjs            Codex 适配层：本地 stdio MCP，复用同一批工具规格
│   ├── tests/                   196 个用例
│   ├── vendor/agent-style-harness/  随包的 harness-style（Python，含离线依赖）
│   └── package.json             name / bin / scripts
├── .codex-plugin/plugin.json    Codex 插件清单
├── .agents/plugins/marketplace.json  Codex Git 市场索引
├── .mcp.json                    Codex 本地 MCP 服务注册
├── skills/harness-cli/          Codex 技能与操作流程
├── harness-cli.json             插件自身的配置（AGENTS.md 由它生成）
├── AGENTS.md                    入口地图（生成物）
├── README.md                    本文件
├── plans.html                   任务总览与操作台（init 生成；plans 命令刷新）
├── README-INSTALL.md            安装说明（Windows / macOS / Linux）
├── install.ps1                  一键安装脚本（PowerShell，三平台通用）
├── install.sh                   一键安装脚本（bash，macOS / Linux）
└── docs/adr/                    设计决策
```

外壳只放文档与配置，不放可执行代码；`plugin/` 是自包含的——拷到别处仍可运行。

装到 DSH 或 Codex 环境见 [`README-INSTALL.md`](README-INSTALL.md)（含手动步骤与卸载）。

## 2. 它解决什么问题

讲义里的五类失败模式，各自对应一个文件；没有文件，问题就只能靠人记：

| 文件 | 解决的失败 |
|---|---|
| `AGENTS.md` | 需求模糊、隐性约定没写下来 |
| `init.sh` | 环境配置有缺口 |
| `docs/feature_list.json` | 范围不清、状态丢失（含 `acceptance` / `evidence` / WIP 上限、并行认领） |
| `claude-progress.md` | 跨会话接不上 |
| `scripts/gate.sh` | 验证手段缺失（lint → 测试 → WIP 上限 + 认领一致性） |

工具只做两件事：**把文件按规范生成出来**，以及**把规范变成失败**。规则写在 `templates/`
与 `check` 的判定里，不写在提示词里——文档会腐烂，判定不会。

## 3. 用法

| 命令 | 作用 | 退出码 |
|---|---|---|
| `init [--preset prototype] [--force] [--force-state] [--dry-run]` | 生成配置与骨架；已存在的非空文件默认不覆盖，状态文件即使 `--force` 也不覆盖 | 0 / 2 |
| `agents [--stdout] [--force]` | 由 `harness-cli.json` 生成 `AGENTS.md`，并报行数（>100 警告，>120 失败） | 0 / 1 |
| `page <任务名> [--user-words "原话"]` | 建任务页 + 五份规范文档（含业务流程图）+ 方案页 + 刷新总览；DSH 侧依次追问 UX → 数模 → UI（选了 UX / 数模后 UI 走关联生成）；任务名支持中文 | 0 / 1 / 2 |
| `review [任务名] [--agent <标识>]` | 复盘：跑项目判定，写 `docs/specs/<task>/review.md`（含五份文档指纹，业务流程图改动也会让确认失效）；**省略任务名=自动选最近的任务** | 0 / 1 / 2 |
| `plan [任务名] [--confirm --by "确认人"]` | 只更新 / 生成 `docs/specs/<任务>/` 五份文档；未开工（总进度 0、方案未确认）时顺带把页面与方案页骨架补齐，已开工 / 已确认后只写 docs/specs；确认是可选步骤（确认前校验「复盘通过 + 文档指纹未变」）；省略任务名=最近的任务 | 0 / 1 / 2 |
| `progress <任务名> [--step N --pct 0..100] [--status …] [--note …]` | 唯一进度写入口：改步骤 / 状态 → 追加记录 → 重算总进度 → 同步总览；**不要求先确认方案**（P21 由 check 在交付前拦） | 0 / 1 / 2 |
| `ux [任务名...] [--user-words "需求"] [--resolve <编号...>] [--by "确认人"] [--apply]` | UX 与需求分析：整体报告 `prototype/ux.html` 永远覆盖全部任务与项目需求，另有 `prototype/<任务>/ux/index.html`；缺口带稳定编号，补文档重跑会自动移除，`--resolve` 逐条关闭；`--apply` 把结论写回任务 `design.md` 并同步直接关联任务；DSH 侧报告完成后询问更新任务 / 关闭待确认项 / 创建任务流程 | 0 / 1 / 2 |
| `ui [任务名] [--user-words "原话"] [--force]` | 生成 antd 风格 UI 设计稿、同步 `design.md`，并把「设计说明缺口」列成清单；同时追加一条任务进度记录并更新 `task_queue.json`；CLI 默认保留已有设计，`/harness-cli ui` 默认覆盖重写 | 0 / 1 / 2 |
| `sql [任务名] [--dry-run]` | 数据库设计：补 `docs/specs/<task>/schema.sql` 与 `database.md`，按 Google 数模规范 lint，生成 `er.mmd`、单任务数模图 `prototype/<task>/db/index.html`（含关系说明 / 字段说明）与整体数模图 `prototype/db.html`；同时追加任务进度记录并更新 `task_queue.json`；`/harness-cli sql` 对已有 schema 也会覆盖执行并重新派发设计；省略任务名=最近的任务 | 0 / 1 / 2 |
| `delete <任务名> [<任务名>...] [--yes]` | 批量删除任务页 / 设计稿 / 数据模型 / 规范文档 / 复盘；删除后同步 `progress.html`、`plans.html`、`db.html`、`db-layout.json` 与 `docs/wiki`；默认只预演，`--yes` 才真删（DSH 侧多选后直接删，进行中的任务先停止） | 0 / 1 / 2 |
| `check [--strict] [--json]` | 只读校验；`--strict` 让警告也算失败 | 0 / 1 / 2 |
| `doctor [--json]` | 工具自检：Node 版本、模板、配置、可写、是否 git 仓库、python3 | 0 / 2 |
| `plans [serve [端口] \| stop]` | 根目录 `plans.html`：任务总览（`serve` 省略端口时用随机安全端口，启动后回显地址；指定端口被占用会强制接管；`stop` 停止）（**点任务名弹窗看 `progress.html`** / 展开编辑五份文档与 `database.md` / `schema.sql` / 操作列「UI」「数模」「UX」弹窗预览，顶部「整体 UX」「整体数模图」按钮 / 对话 / 删除 / 重跑 / 保存数模并刷新）；`--serve` 后按钮直接落盘，并通过 SSE 自动刷新列表与进度弹窗 | 0 / 2 |
| `wiki [--merge\|--update\|--keep] [--check] [--dry-run]` | 生成 / 更新 `docs/wiki`（13 篇业务文档，默认增量合并、人工段落保留），并同步每个任务 `proposal.md` 的业务背景区块 | 0 / 1 / 2 |
| `style <参数...>` | 把参数原样转给随包的 `harness-style`（代码风格 / 提交信息） | 透传 |
| `help [process]` | 查看用法；不带主题时弹窗列出所有指令（可跳过看完整帮助）；`help process`（别名 `flow` / `workflow` / `流程`）打印从开工到收尾的完整任务流程 | 0 |

通用参数：`--root <dir>` 指定目标仓库，`--json` 机器可读，`--dry-run` 只打印不落盘。

### 3.1 开工前先选操作模式（默认动作）

每个 Agent 开始任务前先问用户二选一：

- **手动**：所有操作都等用户确认，删除 / 覆盖 / 确认方案 / 改文档都要先问；
- **自动 loop**：任务自动推进，所有确认与选择都采用推荐项，不再逐项询问。

推荐项的口径：**复盘通过 + 文档指纹未变 + 不破坏人工内容**；有风险时取保守项，
并在进度记录里注明「自动 loop」。用户没回答前不开工。这条规则会写进生成的 `AGENTS.md`。

`/harness-cli page` / `plan` 会把选择写进 `prototype/<task>/.harness-mode.json`：
- **手动**：确认方案时仍弹窗点选；
- **自动 loop**：确认方案时直接选择「确认」，确认人记为「自动 loop」，不再弹窗。

进入工作流后先读 `claude-progress.md`，恢复上次进度；有未完成任务时先继续完成，
不要从零重做或另起无关任务。没有未完成任务时，才从功能清单领取新工作。

## 4. 生成物

```
AGENTS.md                    入口地图（八节，≤100 行，超 120 行判失败）
init.sh                      环境初始化（幂等、set -euo pipefail、失败显式退出）
scripts/gate.sh              门禁（lint → 测试 → WIP 上限 + 认领一致性）
scripts/claim.js             并行 loop 的认领工具（add / release / heartbeat / list / verify / prune）
docs/specs/README.md         规范文档约定（每个任务四份：proposal / spec / design / tasks）
docs/specs/<task>/flow.md    业务流程图（先规划并确认，再做设计与文档）
docs/specs/<task>/schema.sql 数据库 DDL（sql 子命令生成骨架，唯一真源）
docs/specs/<task>/database.md 数据模型设计（Google 数模规范）
docs/specs/<task>/er.mmd     Mermaid ER 图（自动生成）
prototype/<task>/db/index.html 单任务数模图（关系说明 + 字段说明，自动生成）
prototype/db.html             整体数模图（全部任务合并，可拖动调整布局）
prototype/db-layout.json      整体数模图的手动布局（plans 保存时写入）
docs/wiki/*.md                业务文档（由 wiki 子命令生成，13 篇；业务域下钻页在 dirs 声明 name 时才有）
prototype/ux.html             整体 UX 与需求分析报告（永远覆盖全部任务；同目录还有 ux.json、.ux-gaps.json、.ux-resolved.json）
prototype/<task>/ux/index.html 单任务 UX 报告（同目录还有 report.json 与 .ux-gaps.json）
docs/ux/requirements.md       项目级 UX 需求（ux --user-words 追加；整体报告每次都会带上）
docs/claims/README.md        认领协议（人读的约定；每个 loop 的认领落在 docs/claims/<F-xxx>.json）
docs/feature_list.json       功能清单（acceptance / evidence / depends_on / WIP 上限内并行）
claude-progress.md           进度日志（六节，含「下一步行动」）
task_queue.json              任务队列（wipLimit + 任务条目：ui/sql 产物、状态、进度）
docs/current.md              任务日志（顶部追加）
docs/summary.json            当前任务与下一步
docs/graph.json              模块依赖
docs/adr/ADR-0001-*.md       第一个设计决策
_VERSIONS/v<version>.md      版本说明（业务白话：改了什么 / 怎么做的 / 怎么验证）
.harness/<project>_ci.yaml   CI 流水线骨架
.gitignore                   八条必需规则（追加，不覆盖已有内容）
```

其中 `docs/feature_list.json`、`claude-progress.md`、`docs/current.md`、`task_queue.json`
是**状态文件**：只能增量维护，`init --force` 也不会覆盖它们（要覆盖得显式 `--force-state`）。

## 5. 校验项（`check`）

- **A1xx** `AGENTS.md`：八节齐全、行数、引用路径无失效链接、定位非占位、与配置同源
- **H1xx** 骨架：`init.sh` 可执行、`gate.sh` 含 `set -e`、进度日志含「下一步行动」、
  `wipLimit` 合法、`docs/` 与 `_VERSIONS/` 齐备、CI 配置存在、`docs/wiki` 存在时与事实一致（H109）
- **F1xx** 功能清单：必填字段、id 格式与唯一性、状态合法、**WIP 上限**（默认 1 = 单 WIP，
  调大 `wipLimit` 即可并行）、`done` 必须有 `evidence`、`depends_on` 引用存在且无环
- **V1xx** 版本说明：四个板块齐全（更新内容 / 实现方式 / 逻辑图 / 验证标准）、有编号条目、
  不留待补占位、验证标准可勾选
- **G1xx** `.gitignore` 八条规则
- **C2xx** 并行认领：每个 `in_progress` 都有认领、认领指向未结束的任务、`scope` 不重叠、
  心跳不超时、认领数不超 `wipLimit`（规则实现在生成物 `scripts/claim.js` 里，`check` 只负责调用）
- **P1xx**（preset）任务页：目录数上限、任务名合法（字母/数字/中文/_-）、规划编号连续、步骤百分比一致、
  `100%` 与「待验收」互斥、进度记录末条 = 汇总、总览页与任务页一致
- **P13–P16** 拆规范：DDD 四段齐全（上下文 / 统一语言 ≥3 / 聚合 / 不变量）、
  SDD 契约 ≥2 条且六格都填、TDD 每条契约至少一条用例且红绿合法、验证步骤为模拟环境沙箱测试、每步绑定契约
- **P20** UI 设计稿：必须是 antd v5 风格（设计令牌 + 组件），同目录说明写清组件清单 / 状态 / 契约；
  混入第二套设计体系判失败；没有设计稿只警告
- **P21** 方案确认：每个任务必须有 `plan.html` 且七节齐全；已有进度或状态不是「进行中」时，方案必须「已确认」
- **P22** 文档定稿：已开工的任务，`docs/specs/<task>/*.md` 的指纹必须与确认时一致，且 `review.md` 为「已通过」
  （人改文档后必须重新复盘 + 重新确认，不允许边改边跑）
- **P23** UI 同步：有 `ui/index.html` 时，`design.md` 必须有 UI 摘要块且指纹一致（改设计稿后跑 `ui` 同步）
- **P24** 业务同步：有 `docs/wiki` 时，`proposal.md` 必须有业务背景块且指纹一致（改 wiki 后跑 `wiki` 同步）
- **P25** 进度写入：`data-pct > 0` 的每一步都必须有 `data-step` 记录且百分比一致；手改页面判失败
- **P26** 进度及时：已开工任务的最后一条进度记录必须晚于方案确认时间
- **P17–P19** 文档归纳：`docs/specs/<task>/` 四份文档齐全不留待填、
  `tasks.md` 与页面步骤一致、`spec.md` 与页面契约编号一致、`design.md` 含 DDD 四段

每条判定都有对应的**失败用例**（`tests/e2e.test.js`），确保它不是在装饰。

## 6. 配置

`harness-cli.json` 是唯一可调整入口（最小覆盖：只覆盖显式声明的字段）：

```json
{
  "project": {"name": "...", "positioning": "...", "stack": ["TypeScript"]},
  "paths": {"gate": "scripts/gate.sh", "featureList": "docs/feature_list.json", "claims": "docs/claims"},
  "commands": {"test": "npm test", "gate": "bash scripts/gate.sh"},
  "dirs": [{"path": "src/", "name": "订单履约", "desc": "下单、发货、退款"}],
  "conventions": ["..."], "forbidden": ["..."], "dod": ["..."],
  "presets": {"prototype": {"enabled": false, "keep": 10}},
  "claims": {"enabled": true, "ttlHours": 12}
}
```

并行度不在这个文件里，而在 `task_queue.json` 的 `wipLimit`（默认 1）：一个地方定义"同时能做几件事"。

`dirs[].name` 是**业务名**（可省略）：写了才会为这个目录生成「业务域」下钻页；只写 `desc` 不会——
目录名（`bin`、`src`）是代码结构，拿它当业务域会把代码写进业务文档。

文案里可用 `{featureList}` / `{gate}` / `{progress}` 等占位符引用配置过的路径。

## 7. preset：任务页（DDD → SDD → TDD → 计划 → 记录）

`--preset prototype` 把「任务怎么拆」固化成文件结构，顺序不许颠倒：

1. **DDD 划边界**：限界上下文、统一语言（≥3 条）、聚合/实体、不变量；
2. **SDD 定契约**：每条行为写成 `S-01` 起的六格契约（编号 / 契约 / 输入 / 输出 / 错误语义 / 验收标准），≥2 条；
3. **TDD 保质量**：每条用例挂在一条契约上，先 `red` 再 `green`，每条契约至少一条用例；
   验证步骤统一在模拟环境沙箱执行（入口 / 数据 / 命令 / 断言），不写真机验证步骤；
4. **任务规划**：编号 1..N 的步骤（可人工增删），每步绑定一条契约；
5. **步骤流程**：任务页顶部按规划步骤生成横向流程，按百分比标「已完成 / 进行中 / 未开始」，
   当前步骤高亮并标「当前」；点节点定位到步骤卡片，进度一变流程自动重算；
6. **进度记录**：每一步变化（开始 / 完成 / 阻塞 / 改规划）都立刻追加一条并更新任务页，
   不攒到收工；末条总进度必须等于汇总。

状态放 `prototype/`，文档归纳到 `docs/specs/`：

```
prototype/progress.html                总览：进行中 / 待验收的所有任务（--sync 生成）
prototype/<task>/progress.html          单任务：步骤流程 + 领域 + 契约 + 用例 + 规划 + 记录
prototype/<task>/plan.html              方案页：目标 / 方案 / 页面设计 / 流程交互 / 风险 / 验收 / 确认
prototype/<task>/ui/index.html          UI 设计稿（antd v5 风格、离线静态页）
prototype/<task>/ui/README.md           设计说明（页面目标 / 组件清单 / 状态 / 契约对应）
prototype/_template/progress.html       新建任务页的模板
docs/specs/<task>/proposal.md           为什么做 / 范围 / 非目标 / 验收
docs/specs/<task>/spec.md               契约 S-01、S-02…（SDD）
docs/specs/<task>/design.md             限界上下文 / 统一语言 / 聚合 / 不变量（DDD）
docs/specs/<task>/tasks.md              任务规划 1..N，每步标注落地的契约
scripts/prototype-check.js              门禁：P1–P26（见 §5）
```

用法：

```sh
node plugin/bin/dsh-plugin-harness-cli.js init --preset prototype
node plugin/bin/dsh-plugin-harness-cli.js page login-flow --user-words "先把登录做了"
#   → 建页面 + 四份规范文档（已存在的不覆盖）+ 同步总览页
node scripts/prototype-check.js              # 只读检查
node scripts/prototype-check.js --sync       # 用任务页重写总览页
node scripts/prototype-check.js --prune --dry-run
```

新建页是**骨架**（留着「待填」），填完 DDD / SDD / TDD 与文档后 `check` 才通过——这是故意的。
任务一开始先写 `docs/specs/<task>/flow.md` 的业务流程图并在方案页确认；再跑 `plan <task>` 补全 `docs/specs/<task>/` 五份文档（业务流程图 / 提案 / 契约 / 设计 / 规划）。
未开工（总进度 0、方案未确认）时，`plan` 会顺带把任务页的领域·契约·用例·规划区块与 `prototype/<task>/plan.html` 补齐；
一旦有进度或方案已确认，`plan` 只写 `docs/specs`，不再改 `prototype` 下的页面。
内容可以用参数覆盖：`--goal`、`--scope`、`--context`、`--term "术语=定义"`、`--contract "S-01|标题|输入|输出|错误|验收"`
`--step "步骤|S-01"`，或整包 `--input-json '<json>'`。**人可以直接改这些文档**；再跑 `plan` 时已填好的文档默认不覆盖
（`--force` 才重写）。改完：

1. `review <task>` —— Agent 复盘：跑项目判定（文档与页面一致性），写 `review.md`（含五份文档的指纹）；
2. `plan <task> --confirm --by "确认人"` —— 确认方案（**可选**）：核对复盘指纹后，把方案标为「已确认」；
   走 DSH 工具 / 斜杠命令时，确认这一步会**弹窗让你点选**，选「取消」就保持未确认；
3. `plan` 生成成功后**自动开工**（仅限未开工 / 未确认的任务；已开工 / 已确认时只更新 docs/specs，不触发执行）：把任务推入执行，并在当前对话发起一个执行回合（按 `tasks.md` 的 Step 1..N 开工，
   每步调用 `progress` 记录）；同时后台起 `plans` 操作台（默认随机安全端口，地址会回显在对话里）。
   只想改文档不想开工时用 `plan --confirm`（确认）或 `--dry-run`。
4. `progress` **不要求先确认**：发起任务就能记进度，不用等方案确认。
   `check` 的 P21（未确认）与 P22（确认后文档又被改过）仍是红项，交付前会拦——记录不拦、交付拦。
   每一步变化（开始 / 完成 / 阻塞 / 改规划）都立刻跑一次 `progress` 并同步总览，不要攒到收工一次性补。
   `progress` 会先写任务页、再重算 `prototype/progress.html`；同步脚本缺失时自动按模板补回，
   补不回来就报一行可执行的修法（跑 `init`），不会再只更新任务页而让总览停在旧数据。
需要界面时先跑 `ui <task>`：生成 `prototype/<task>/ui/index.html`（antd v5 令牌 + 布局 + 表格 + 表单 + 状态）
与设计说明；CLI 默认不覆盖人工修改，`--force` 才重写；`/harness-cli ui` 默认覆盖重写。所有 UI 统一 antd，P20 会拦第二套设计体系。

数据建模跑 `/harness-cli sql`：多选任务后补 `docs/specs/<task>/schema.sql` 与 `database.md`，
按 Google 数模规范（snake_case、主键、外键索引、3NF、numeric 金额、timestamptz、审计时间）做 lint，
并自动把 `schema.sql` 渲染成 `docs/specs/<task>/er.mmd`、单任务数模图 `prototype/<task>/db/index.html`
与整体数模图 `prototype/db.html`。单任务图会列出「关系说明」（来源字段 → 目标字段、基数、范围、业务含义）
和「字段说明」；字段说明来自 `COMMENT ON TABLE/COLUMN` 或行尾 `-- 说明`，缺说明会给 DB014/DB015 警告。
关系 / 字段说明还会**反填**进 `database.md` 的受管区块（`<!-- harness-db:begin -->`）；字段名 / 类型 / 约束 / 说明完全相同的行会合并，所属表列在同一行；引用其他任务的表会标成
「外部表，见整体数模图」。整体图里也直接展示每个任务的 `schema.sql` 源码与跨任务关系说明。
整体图支持拖动实体、缩放平移，布局保存在 `prototype/db-layout.json`（`plans serve` 下保存）
或浏览器 localStorage；`plans.html` 里可直接预览整体图与单任务图，并能编辑 / 预览 `database.md`、`schema.sql`。
`ui` / `sql` 生成产物后会往任务页 `progress.html` 追加一条活动记录（**不改步骤百分比**，不伪造进度），
同时把任务状态 / 总进度 / 产物写进 `task_queue.json` 的 `items`；后续 `progress` 会同步队列里的状态与进度，
任务页顶部有「步骤流程」：按规划步骤画成横向流程（已完成 / 进行中 / 未开始），当前步骤高亮，
点节点定位到步骤卡片；老任务页在下一次 `progress` 写进度时会自动补上这个区块。
任务页头部有「方案预览」按钮，点击弹窗加载同任务的 `plan.html`；方案页里的业务流程图源文件链接也可点击，弹窗渲染 `flow.md`（Mermaid 源码按 Markdown 预览，`file://` 下无法 fetch 时回退为新窗口打开）。

`delete` 会把队列条目一并删除，并同步重生成 `prototype/progress.html`、`plans.html`、`prototype/db.html`、
清理 `prototype/db-layout.json` 里已删除表的坐标，再跑一次 `wiki` 增量更新 `docs/wiki`。

所有生成的 HTML（`plans.html`、`progress.html`、`plan.html`、`ui/index.html`、`db/index.html`、`prototype/db.html`）
都带骨架屏：先显示占位块，页面/布局/iframe 数据就绪后再淡出显示真实内容。
schema 还是空的或有 lint 错误时命令退出 1，Agent 按提示补完后重跑即可。

任务中断后不用从零重来：`/harness-cli continue` 会列出「进行中 / 待验收」的任务，选中后把
「从当前进度继续、不重做已完成步骤」的执行说明发到当前对话；也可以直接
`/harness-cli continue <任务名>` 跳过选择。
要整体重来用 `/harness-cli restart`：弹窗多选任务后，把进度归零、方案回到「待确认」、复盘作废
（`docs/specs` 与 UI 设计稿保留），再派发 Agent 重新复盘 / 确认方案 / 从 Step 1 执行；
也可以写 `/harness-cli restart <任务名> [任务名...]` 跳过弹窗。

任务名支持中文（如 `登录页面`）与英文 kebab-case（如 `login-flow`）；目标目录不存在时会自动创建，
所以「任务第一次跑」不会因为目录缺失而失败。

已有项目补开也支持：`init --preset prototype` 只补缺失的 preset 文件，把
`presets.prototype.enabled` 写回 `harness-cli.json`（该配置默认被 keep，不写回就会一直报「preset 未启用」），
并按新配置重生成 `AGENTS.md`；其余文件仍然不覆盖。老任务可用 `page <任务名>` 只补缺失的规范文档。

## 8. 并行 loop：多任务 / 跨会话

单 WIP 是默认值，不是硬编码：并行度来自 `task_queue.json` 的 `wipLimit`（默认 1）。
调大它，再按「认领」分工，多个会话 / 多个 Agent 就能同时推进同一仓库：

```sh
# 1) 提并行上限：task_queue.json 里 "wipLimit": 3

# 2) 每个 loop 开工先认领（独占创建：两个会话同时抢同一个任务，只有一个成功）
node scripts/claim.js add F-003 --owner "session-620d / agent-main" --scope src/auth --scope docs/
node scripts/claim.js list                                              # 谁在做什么
node scripts/claim.js heartbeat F-003 --owner "session-620d / agent-main"  # 长任务续心跳
node scripts/claim.js release F-003                                     # 收工必释放

# 3) 自检（check 与 gate.sh 都会跑）
node scripts/claim.js verify
```

- 认领落在 `docs/claims/<F-xxx>.json`（owner / loop / scope / startedAt / heartbeatAt），
  下一个会话读得到；`loop` 记这个 owner 的第几轮迭代。
- `add` 会拒绝：已被认领、认领数已达 `wipLimit`、`scope` 与别人重叠。
- 规则写在生成物 `scripts/claim.js` 里，`check` 只调用并映射（和 `prototype-check.js` 同一模式），
  工具和项目不会各写一份判定。
- 为什么不是锁：锁要服务、会死锁、跨机器失效；认领是文件 + 独占创建 + 心跳超时警告，
  坏了能人肉收拾，状态就在仓库里。

## 9. 业务 wiki（`wiki` 子命令）

`docs/wiki` 是给**非技术读者**（领导、售前、客户、实施、产品、测试、业务）看的 13 篇文档，
内容从仓库文件扫描生成：配置、功能清单、任务页、规范文档、认领、门禁脚本，以及 `docs/specs`
与 `docs/adr` 里已经写好的业务事实。命令与参数：

```sh
node plugin/bin/dsh-plugin-harness-cli.js wiki            # 默认增量合并：人工段落保留、事实刷新
node plugin/bin/dsh-plugin-harness-cli.js wiki --keep     # 只补缺失，已有文件一个字不动
node plugin/bin/dsh-plugin-harness-cli.js wiki --update   # 整块重写受管区块（回到生成器基线）
node plugin/bin/dsh-plugin-harness-cli.js wiki --check    # 只报告：缺失 / 过期 / 待接管 / 标记损坏
```

生成规则（`src/wiki.js` + `src/wikidocs.js`）：

- **正文是业务白话**：不写命令、代码块、流程图、字段名与文件路径；技术细节留在 `README.md`；
  这一条由用例守着（生成物里出现三反引号、`mermaid` 或命令行即失败）；
- 每篇只有一个**受管区块**：`<!-- harness-wiki:begin -->` … `<!-- harness-wiki:end -->`；
- **区块外的人工内容永远不会被覆盖**；
- **重跑默认做三路合并**：上次生成的正文当基线，和文件现状、本次生成逐行合并。
  生成器改的事实（数量、状态、清单）自动刷新，人改过的段落原样保留；两边改到同一段时保留人工版本，
  输出里以「保留人工段落 N 处」计数。`--update` 才是整块重写，`--keep` 只补缺失文件；
- 既有文档**没有**受管区块时：默认在标题后补上区块，原文一字不改地留在区块下；
- 合并基线存在 `docs/wiki/.harness-wiki.json`（只记正文与哈希，不进文档正文）；
- 配置里的 `wiki.mode` 可固定模式（`merge` / `auto` / `keep`）；旧版状态只有哈希、没有基线，
  升级后第一次重跑会保留人工段落并补上基线，之后按事实差异合并；
- 只剩一种真冲突：**受管区块标记不完整**（只有开始或只有结束）——写不了也不该猜，退出码 1，等人修；
- **业务内容从 docs 反推**：`docs/specs/<任务>/proposal.md`（为什么做 / 范围 / 验收）、
  `spec.md`（契约标题）、`design.md`（统一语言 / 不变量）、`docs/adr`（关键决策）会被清洗成业务白话
  写进速览、功能清单、验收、术语、口径、规则几篇；读不到的才标「待业务确认」；
- 生成时间只写进状态文件，不进正文，避免每次运行都制造改动；
- **业务域下钻页只在 `dirs` 声明了 `name`（业务名）时生成**：目录名（`bin`、`src`）是代码结构，不是业务域；
- **只反推项目自己的文件**：会排除工作区里嵌入的 harness-cli 工具目录（按包名 / `bin/dsh-plugin-harness-cli.js` 识别）以及它生成的脚本与页面（`scripts/claim.js`、`scripts/prototype-check.js`、`scripts/gate.sh`、`init.sh`、`prototype/`、`plans.html` 等），避免把工具自身当成业务代码；
- 内容只来自扫描到的事实：技术栈、任务/功能、认领、定位都会**反推**；推不出来的业务内容标成
  「待业务确认」，以「仍需人工确认：N 处」列在输出里（文件:行），由 Agent 反推工作区补全后重跑。

DSH 侧对应工具 `harness_cli_wiki` 与斜杠命令 `/harness-cli wiki`：默认模式直接合并，不再因「人工改过」
弹窗；生成后若还有「仍需人工确认」的缺口，命令会通过 `agent.steer` **把「反推补全」消息直接发送到当前对话**
（带缺口清单路径与步骤），Agent 用业务白话补完并重跑直到 0 缺口；`--check` 不会发起。

## 10. UX 分析（`ux` 子命令）

`ux` 把「任务文档 + UI 说明 + 项目需求」整理成一份给产品 / 设计 / 测试看的 HTML 报告：

- `prototype/ux.html`：**整体报告，永远覆盖仓库里的全部任务**；命令里选的任务只决定 `--apply` 回写谁（单任务报告每次都会刷新），不会让整体报告缩水。
- `prototype/<任务>/ux/index.html`：单任务报告；另有 `prototype/ux.json`、`prototype/<任务>/ux/report.json`
  （结构化数据）、`prototype/.ux-gaps.json`（待确认清单）与 `prototype/.ux-resolved.json`（逐条关闭记录）。
- `docs/ux/requirements.md`：项目级需求；`--user-words` 会追加到这里，后续重跑不会丢。

```sh
node plugin/bin/dsh-plugin-harness-cli.js ux                    # 分析全部任务 + 项目需求
node plugin/bin/dsh-plugin-harness-cli.js ux 登录页面           # 同样出整体报告；只把登录页面作为回写目标
node plugin/bin/dsh-plugin-harness-cli.js ux --user-words "做一个审批流……"
node plugin/bin/dsh-plugin-harness-cli.js ux --resolve G-1a2b3c4d --by "张三"
node plugin/bin/dsh-plugin-harness-cli.js ux --apply 登录页面   # 写回 design.md，并刷新直接关联任务
node plugin/bin/dsh-plugin-harness-cli.js ux --dry-run          # 只看将写入哪里
```

报告按**维度优先级**组织：用户与场景 → 需求拆解 → 任务关联 → 体验流程 → 异常与恢复 → 状态与反馈 →
可用性 → 文档完整性。摘要给出维度进度；每个维度先给分析结论，再列缺口与怎么补。

规则（`src/ux.js`）：

- **全项目口径**：整体报告每次都分析全部任务；没有任务参数也能直接跑，不会因为某次只选了一个任务而缩水；
- **优先分析**：用户与场景、需求拆解、体验流程、异常与恢复先形成结论；没有依据的才进待确认清单；
- **缺口可关闭**：缺口编号由「任务 + 维度 + 描述」算出，重跑后保持稳定；补好文档重跑，已修好的条目自动消失，
  关闭记录也会被清理；文档无法自动证明、但人已确认的，用 `ux --resolve <编号> --by "确认人"` 逐条关闭，
  报告只列未关闭项，并把已关闭项折叠展示；
- **任务关联**：在任意任务文档写「关联任务：任务名」即可显式声明（文档里互相提及也会识别）；
  `--apply` 会一并刷新直接关联任务的 UX 复核区块，关联任务之间术语口径不一致也会进待确认；
- **可用性检查只判断「文档里有没有依据」**：目标可感知 / 流程闭环 / 错误可恢复 / 状态可见 /
  口径一致 / 少一步可防错 / 可访问与响应式；通过不等于体验好，待补才是行动项；
- **阻断缺口清零才算分析完成**：缺主流程、为什么做、验收、占位符等计入阻断；
  DSH 侧先派发「按维度逐条补 → 重跑 ux」，清零后才询问下一步；
- **`--apply` 可重复执行**：把结论写进 `design.md` 的 `<!-- ux-report:begin -->` 受管区块，
  只刷新选中任务与它们的直接关联任务；
- **报告可交付**：离线、零依赖、可直接发给非技术读者；来自仓库 / 用户的文本会做 HTML 转义；
- **创建任务走现有流程**：`page` 建任务页 + 规范文档 + 方案页，随后派发
  「补文档 → ui → review → plan → 按步骤实现」。

DSH 侧 `/harness-cli ux`（菜单「UX 分析」）：整体报告覆盖全部任务；多选框只用来指定回写 / 继续处理的任务，
同一个输入框可以写项目需求。报告完成后询问「更新任务 / 逐条关闭待确认项 / 创建新任务 / 仅保留报告」。
模型也可以直接调 `harness_cli_ux`（参数 `tasks` / `user_words` / `resolve` / `by` / `apply`）。
生成报告后会刷新 `plans.html`：操作栏出现单任务「UX」按钮，顶部出现「整体 UX」按钮，点开在弹窗里直接看报告。

## 11. 随包的 harness-style（`style` 子命令）

代码风格与提交信息判定不重写，直接把 [`harness-style`](../agent-style-harness) 随包携带，
放在 `plugin/vendor/agent-style-harness/`（含 `vendor/py` 的 yapf/isort 与 `vendor/node` 的 commitlint，
离线可用，约 48 MB）。参数原样透传，退出码也原样透传：

```sh
node plugin/bin/dsh-plugin-harness-cli.js style doctor              # 依赖与配置自检
node plugin/bin/dsh-plugin-harness-cli.js style init --lang py,ts   # 给项目接入风格配置 + hooks
node plugin/bin/dsh-plugin-harness-cli.js style check --staged      # 0 通过 / 1 有违规 / 2 工具坏
node plugin/bin/dsh-plugin-harness-cli.js style fix --staged
node plugin/bin/dsh-plugin-harness-cli.js style commit-msg <msg-file>
```

分工：

| 工具 | 管什么 | 失败的典型原因 |
|---|---|---|
| `dsh-plugin-harness-cli check` | 项目配置与流程证据（四件套、WIP 上限、认领、证据、链接） | 超出 `wipLimit`、in_progress 没认领、`done` 没证据 |
| `dsh-plugin-harness-cli style check` | 代码风格与提交信息（Google Style 可机械判定的部分） | 缩进、引号、commit 前缀不合规 |

串成一条门禁（`&&` 短路，任一失败即停）：

```sh
node plugin/bin/dsh-plugin-harness-cli.js style check --staged \
  && node plugin/bin/dsh-plugin-harness-cli.js check
```

前提：`style` 需要目标机器有 `python3`（harness-style 是 Python 实现）。
没有 `python3` 时 `doctor` 会给出警告，其余子命令不受影响。

## 12. 导入 DSH / Codex 当工具用

CLI 是给人敲的；要让**模型自己**调用，就把它注册成宿主插件。DSH 适配层是 `plugin/cordis.mjs`
（零依赖，只起子进程），判定与文案仍在 `src/` 与 `templates/`，所以工具行为和命令行逐字一致。

### Codex（本地 MCP）

`.codex-plugin/plugin.json` 声明技能目录与 `.mcp.json`；`.mcp.json` 用
`node ./plugin/codex-mcp.mjs` 启动本地 stdio 服务。服务直接复用 `cordis.mjs` 的
`TOOL_SPECS` 与 `runCli`，因此 Codex 仍看到同样的 14 个工具名。

Codex 启动 MCP 时的工作目录属于插件安装缓存，不是用户仓库，所以 Codex 工具要求每次显式传
目标仓库的绝对 `root`；缺少或传入相对路径会直接报错，不会误写插件目录。

```sh
codex plugin marketplace add gouqingping/dsh-plugin-harness-cli
codex plugin add dsh-plugin-harness-cli@dsh-plugin-harness-cli
codex mcp list
```

### DSH（Cordis）

注册：在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加入口，然后重启 DSH。

```yaml
- insert:
    - id: harness-cli
      name: 'file:///home/<user>/.dsh/profiles/node_modules/@deepseek-ai/dsh-plugin-harness-cli/cordis.mjs'
      # 用绝对 file:// 路径，不依赖 loader 的裸包名解析；
      # 该路径经 profiles/node_modules 的符号链接指向工作区里的 plugin/。
```

装好后多出 `harness_cli_*` 工具（参数 `root` 省略时用当前 Session 工作目录）：

| 工具 | 对应子命令 | 写盘 | 退出码 |
|---|---|---|---|
| `harness_cli_check` | `check` | 否（门禁） | 0 / 1 / 2 |
| `harness_cli_init` | `init` | 是（`dry_run` 可只预览） | 0 / 2 |
| `harness_cli_page` | `page <task>` | 是（页面 + `docs/specs/` 五份文档 + 方案页 + 总览） | 0 / 1 / 2 |
| `harness_cli_review` | `review <task>` | 是（`docs/specs/<task>/review.md`） | 0 / 1 / 2 |
| `harness_cli_plan` | `plan <task> [--confirm]` | 是（`docs/specs`；未开工骨架补 `plan.html`；`review.md` 状态） | 0 / 1 / 2 |
| `harness_cli_progress` | `progress <task>` | 是（步骤 / 状态 / 记录 / 总览） | 0 / 1 / 2 |
| `harness_cli_ui` | `ui <task>` | 是（`prototype/<task>/ui/`） | 0 / 1 / 2 |
| `harness_cli_ux` | `ux [tasks...] [--user-words] [--resolve] [--by] [--apply]` | 是（`prototype/ux.html`、`prototype/<task>/ux/`、`docs/ux/requirements.md`、`design.md` UX 区块） | 0 / 1 / 2 |
| `harness_cli_sql` | `sql <task>` | 是（`schema.sql` / `database.md` / `er.mmd` / `db/index.html`） | 0 / 1 / 2 |
| `harness_cli_delete` | `delete <task>` | 是（删任务页 / 设计稿 / 数据模型 / 规范文档 / 复盘） | 0 / 1 / 2 |
| `harness_cli_wiki` | `wiki` | 是（`docs/wiki` 受管区块） | 0 / 1（标记损坏）/ 2 |
| `harness_cli_agents` | `agents` | 是（`dry_run` / `force`） | 0 / 1 |
| `harness_cli_doctor` | `doctor` | 否（工具自检） | 0 / 2 |
| `harness_cli_style` | `style` | 由透传参数决定 | 透传 |

另外，插件会订阅 DSH 的 `session/event`：顶层会话每次写 `todo/write`，就按 todo 标题匹配当前任务页步骤，
把 `completed` / `in_progress` / `pending` 自动映射成 `100%` / `50%` / `0%`，再调用 `progress` 落盘。
方案未确认**不再拦进度**（P21 交给 `check` 在交付前拦）；任务不唯一或步骤匹配不到时跳过并在会话里告警；
同一会话的事件串行处理。

需要用户拍板的操作一律**弹窗点选**，不靠打印提示让人自己跑命令：
删除任务（删除 / 取消）、`--force` 覆盖已有文件（覆盖 / 取消）、方案确认（确认 / 取消）都走这条路径；
弹窗来自宿主的 `userQuestions` 服务。会话已经有 `system` head 时，每次点选或输入后，结果会立即
作为一条 `user/message` 反馈到当前对话（例如 `已选择：生成 UI 设计稿`、`已选择：数据看板`、`已输入：登录页面`），
但不会唤醒额外的模型回合；首轮开始前还没有 head 时跳过这条独立反馈（命令结果仍照常返回），
避免 surface 首个节点不是 `system/message` 导致整个会话历史无法冷读。没有可用 UI 时退化为非交互行为
（删除则直接拒绝，要求 `--yes`）。

输入框工具栏上还有一个**准星 + 指令**按钮（Web 客户端半边 `plugin/client.js`）：点开在按钮正上方弹出菜单，
列出 15 条中文子指令（「推进度」已从菜单收起，仍可用 `/harness-cli progress` 或 CLI / 工具调用）；选中后只填入输入框，和 `/` 菜单一样按 Enter 才执行；需要任务名的会留一个空格，补完后回车。

客户端还会把宿主写死的两个占位文案做兼容覆盖：问题卡片的自定义输入「输入你的答案」→「请输入」，
会话输入框 →「请输入自定义语义」，`/harness-cli` 的命令输入提示也改为「请输入自定义语义」。
这是运行时补丁；宿主的 `locale` 服务被冻结时保持原样，其他文案不受影响。
菜单支持键盘操作：`↑/↓` 循环选择，`Home/End` 跳到首尾，`Enter/空格` 执行当前项，`Esc` 关闭并回到指令按钮。
菜单 portal 到 `document.body` 并用按钮矩形定位（输入框是 fixed 容器，不 portal 会被裁掉），
颜色只用主题令牌，深浅色自动跟随。客户端半边由页面在启动时加载，装好后需要刷新页面。

以及**一条**聚合斜杠命令：`/harness-cli [子指令] [参数...]`。
不带子指令时弹窗让你选（初始化 / 校验 / 自检 / 建任务 / 方案 / 复盘 / 继续任务 / 重跑任务 / UI 设计 / 数据库设计 / 删除任务 / 业务 wiki / 任务总览 / 入口地图 / 帮助；「推进度」不在菜单里，仍可直接写 `/harness-cli progress`），
选中后执行对应动作；也可以直接写子指令，例如 `/harness-cli check`、`/harness-cli plan 登录页面 --confirm`。

选「帮助」或直接写 `/harness-cli help` 时会先弹一个**非必选**的选择框，选项是指令后缀（`delete` / `page` / `plan` /
`progress` …，含不在菜单里的 `progress`）：选中 `delete` 就执行 `/harness-cli help delete`，只看 delete 的说明；
选择链会并进结果卡片顶部（`已选择：帮助 → delete`），不再单独发「已选择」消息；
跳过 / 取消则回到完整帮助。`/harness-cli help process` 直接看完整流程。

| 子指令 | 作用 | 交互 |
|---|---|---|
| `/harness-cli continue [任务名]` | 继续未完成任务：只列「进行中 / 待验收」，选中后派发「从当前进度继续、不重做已完成步骤」 | 单选弹窗；显式任务名跳过弹窗 |
| `/harness-cli restart [任务名...]` | 重跑任务：进度归零、方案回到待确认、复盘作废（文档与 UI 设计稿保留），再派发「从 Step 1 重新开始」 | 多选弹窗；显式任务名跳过弹窗 |
| `/harness-cli sql [任务名...]` | 数据库设计：多选任务后按 Google 数模规范生成 `schema.sql` / `database.md`，并派发 Agent 补齐设计、跑 lint、生成 ER 数模图 | 多选弹窗；显式任务名跳过弹窗 |
| `/harness-cli delete [任务名...]` | 删除任务：多选后删除任务页 / 方案 / UI / 数据模型 / 规范文档 / 复盘；进行中的任务先发停止指令再删 | 多选弹窗（不可恢复）；显式任务名保留一次确认 |

从菜单选「任务总览」会自动带上 `serve`，并弹一个**非必填**的端口输入框：跳过=随机端口，填数字=固定端口。
`page` 采用两阶段执行：先完成任务名与附加产物选择，再开始执行。问题顺序固定为：
**先问要不要生成 UX**；选了 UX 就问「要不要根据刚才的 UX 报告生成数据库设计」，没选就问「要不要创建数模设计」；
最后问 UI——前面选了 UX / 数模 / 两者之一时问「要不要关联前面的文档生成 UI」，否则问「要不要生成 UI」。
选择后在同一次处理里依次执行 `page` → `ux`（含 `--apply` 回写 design.md）→ `sql` → `ui`。
`plan` 不再追问这些附加产物，只写 `docs/specs`；未开工时文档写完后自动开工，已开工 / 已确认时只更新文档、不触发执行；
所有从菜单发起的指令，结果开头都会写 `已执行 /harness-cli <子指令>`，在对话里可追溯。
任务名后面的说明会自动进 `--user-words`（`/harness-cli plan 登录页面 添加最小6位最大8位的限制`）；
如果整句都被当成了任务名（含标点/空格），会弹窗要一个短名字，原句仍作为需求写进文档。
宿主没有指令分组能力，所以十几条独立指令会塞满菜单——这里统一收成一条入口，子指令行为与原来逐条注册时完全一致。

在 `/` 菜单里选中指令只是把它填进输入框，**要按 Enter 才执行**（输入框的宿主逻辑，插件改不了）。
回车后命令处理器直接向宿主的问答服务发起一次单请求，选择卡片出现在输入框上方；选中即执行对应子指令，
不经过模型；选择结果会立即作为对话消息反馈，主命令仍要等选择完成后才开始。
如果没有可用的问答界面，会返回一行原因并附上子指令写法。

两个宿主细节写在 `cordis.mjs` 顶部：DSH 桌面端是 Electron，所以子进程要带
`ELECTRON_RUN_AS_NODE=1` 才会被当成 node 执行；目标仓库用子进程的 `cwd` 指定而不是 `--root`，
因为 `style` 的参数是原样透传的，它不认 `--root`。

卸载：删掉 `cordis.patch.yml` 里那段 `- insert:`（`id: harness-cli`），重启 DSH。
工具本身不受影响——命令行仍然可用。

## 13. 开发

```sh
node --test                                  # 197 个用例
node plugin/bin/dsh-plugin-harness-cli.js doctor       # 自检（Node / 模板 / 配置 / 可写）
```

本仓库只放工具本体（`bin/ src/ templates/ tests/` + 入口文档），**不自举**：
它的 `check` 校验的是"目标项目"的配置，在这里直接跑会如实报出"缺少四件套"，
这是预期结果，不是工具坏了。想在本仓库试跑，先 `init` 出一套配置。

设计权衡与被否决的方案见 [`docs/adr/ADR-0001-harness-cli.md`](docs/adr/ADR-0001-harness-cli.md)。
