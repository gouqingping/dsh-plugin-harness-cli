# dsh-plugin-harness-cli

> **DSH 插件**：装好后在 DSH 里获得 11 个工具（`harness_cli_*`）与 10 条斜杠命令（`/harness-cli-*`），
> 让模型按同一套 Harness 规范生成、校验、推进项目，而不是靠提示词自觉。

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/gouqingping/dsh-plugin-harness-cli)

## 安装（DSH 插件市场）

```sh
# 已发布到 npm（0.1.1），也是 DSH 插件中心用的命令
dsh plugin --profile web add dsh-plugin-harness-cli

# 只从源码安装（不需要 npm 包，也能用）
dsh plugin --profile web add github:gouqingping/dsh-plugin-harness-cli
```

装完重启 DSH，然后在任意项目里执行 `/harness-cli-init`；命令与工具清单见 `/harness-cli-help`。

> 收录状态、提交模板与自查项见 [`docs/MARKETPLACE.md`](docs/MARKETPLACE.md)；
> `node --test` 里的 `listing.test.js` 会断言仓库内的收录要求。

| 项 | 值 |
|---|---|
| 一句话价值 | 把「项目怎么协作」变成可生成、可校验的文件：入口 / 环境 / 范围 / 状态 / 门禁 / 规范文档 / 业务 wiki 全自动，模型直接调用。 |
| 能力分类 | 开发与运维 |
| 支持 profile | `web`、`desktop`（默认值 `web`，见安装命令） |
| 兼容与运行要求 | DSH 0.2.x（安装与 profile 合成在 0.2.2-rc.1 验证；桌面端 profile 名为 `desktop`）；Node.js ≥ 18；零运行时依赖、离线可用；`style` 子命令需要本机 `python3` |
| 权限与外部服务 | 只读写**目标仓库内**的文件；不联网、不收集数据；`plans --serve` 仅监听 `127.0.0.1`（可选） |
| 许可证 | CC0-1.0（公共领域奉献，见 [LICENSE](LICENSE)） |
| 打包形态 | 根 `package.json` + `cordis.patch.yml`（`dsh.bundle.patch`），`main` 导出 `apply(ctx)`；安装后由 DSH 自动合入 profile |

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
│   ├── tests/                   108 个用例
│   ├── vendor/agent-style-harness/  随包的 harness-style（Python，含离线依赖）
│   └── package.json             name / bin / scripts
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

装到 DSH 环境见 [`README-INSTALL.md`](README-INSTALL.md)（含手动步骤与卸载）。

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
| `page <任务名> [--user-words "原话"]` | 建任务页 + 四份规范文档 + 方案页 + 刷新总览（预设未开启会自动补；任务名支持中文） | 0 / 1 / 2 |
| `review [任务名] [--agent <标识>]` | 复盘：跑项目判定，写 `docs/specs/<task>/review.md`（含四份文档指纹）；**省略任务名=自动选最近的任务** | 0 / 1 / 2 |
| `plan [任务名] [--confirm --by "确认人"]` | 建任务时一次补全 `docs/specs` 四份文档 + 任务页 + 方案页；确认前校验「复盘通过 + 文档指纹未变」；省略任务名=最近的任务 | 0 / 1 / 2 |
| `progress <任务名> [--step N --pct 0..100] [--status …] [--note …]` | 唯一进度写入口：改步骤 / 状态 → 追加记录 → 重算总进度 → 同步总览 | 0 / 1 / 2 |
| `ui [任务名] [--user-words "原话"] [--force]` | 生成 antd 风格 UI 设计稿、同步 `design.md`，并把「设计说明缺口」列成清单；斜杠命令会自动发起补全 | 0 / 1 / 2 |
| `check [--strict] [--json]` | 只读校验；`--strict` 让警告也算失败 | 0 / 1 / 2 |
| `doctor [--json]` | 工具自检：Node 版本、模板、配置、可写、是否 git 仓库、python3 | 0 / 2 |
| `plans [--serve] [--port 7788]` | 根目录 `plans.html`：任务总览（**点任务名弹窗看 `progress.html`** / 展开编辑文档 / UI 弹窗预览 / 对话 / 删除 / 重跑）；`--serve` 后按钮直接落盘 | 0 / 2 |
| `wiki [--update\|--keep\|--ask] [--check] [--dry-run]` | 生成 / 更新 `docs/wiki`（13 篇业务文档），并同步每个任务 `proposal.md` 的业务背景区块 | 0 / 1 / 2 |
| `style <参数...>` | 把参数原样转给随包的 `harness-style`（代码风格 / 提交信息） | 透传 |

通用参数：`--root <dir>` 指定目标仓库，`--json` 机器可读，`--dry-run` 只打印不落盘。

### 3.1 开工前先选操作模式（默认动作）

每个 Agent 开始任务前先问用户二选一：

- **手动**：所有操作都等用户确认，删除 / 覆盖 / 确认方案 / 改文档都要先问；
- **自动 loop**：任务自动推进，所有确认与选择都采用推荐项，不再逐项询问。

推荐项的口径：**复盘通过 + 文档指纹未变 + 不破坏人工内容**；有风险时取保守项，
并在进度记录里注明「自动 loop」。用户没回答前不开工。这条规则会写进生成的 `AGENTS.md`。

## 4. 生成物

```
AGENTS.md                    入口地图（八节，≤100 行，超 120 行判失败）
init.sh                      环境初始化（幂等、set -euo pipefail、失败显式退出）
scripts/gate.sh              门禁（lint → 测试 → WIP 上限 + 认领一致性）
scripts/claim.js             并行 loop 的认领工具（add / release / heartbeat / list / verify / prune）
docs/specs/README.md         规范文档约定（每个任务四份：proposal / spec / design / tasks）
docs/wiki/*.md                业务文档（由 wiki 子命令生成，13 篇 + 业务域下钻页）
docs/claims/README.md        认领协议（人读的约定；每个 loop 的认领落在 docs/claims/<F-xxx>.json）
docs/feature_list.json       功能清单（acceptance / evidence / depends_on / WIP 上限内并行）
claude-progress.md           进度日志（六节，含「下一步行动」）
task_queue.json              任务队列（wipLimit）
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
  SDD 契约 ≥2 条且六格都填、TDD 每条契约至少一条用例且红绿合法、每步绑定契约
- **P20** UI 设计稿：必须是 antd v5 风格（设计令牌 + 组件），同目录说明写清组件清单 / 状态 / 契约；
  混入第二套设计体系判失败；没有设计稿只警告
- **P21** 方案确认：每个任务必须有 `plan.html` 且七节齐全；已有进度或状态不是「进行中」时，方案必须「已确认」
- **P22** 文档定稿：已开工的任务，`docs/specs/<task>/*.md` 的指纹必须与确认时一致，且 `review.md` 为「已通过」
  （人改文档后必须重新复盘 + 重新确认，不允许边改边跑）
- **P23** UI 同步：有 `ui/index.html` 时，`design.md` 必须有 UI 摘要块且指纹一致（改设计稿后跑 `ui` 同步）
- **P24** 业务同步：有 `docs/wiki` 时，`proposal.md` 必须有业务背景块且指纹一致（改 wiki 后跑 `wiki` 同步）
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
  "dirs": [{"path": "src/", "desc": "源码"}],
  "conventions": ["..."], "forbidden": ["..."], "dod": ["..."],
  "presets": {"prototype": {"enabled": false, "keep": 10}},
  "claims": {"enabled": true, "ttlHours": 12}
}
```

并行度不在这个文件里，而在 `task_queue.json` 的 `wipLimit`（默认 1）：一个地方定义"同时能做几件事"。

文案里可用 `{featureList}` / `{gate}` / `{progress}` 等占位符引用配置过的路径。

## 7. preset：任务页（DDD → SDD → TDD → 计划 → 记录）

`--preset prototype` 把「任务怎么拆」固化成文件结构，顺序不许颠倒：

1. **DDD 划边界**：限界上下文、统一语言（≥3 条）、聚合/实体、不变量；
2. **SDD 定契约**：每条行为写成 `S-01` 起的六格契约（编号 / 契约 / 输入 / 输出 / 错误语义 / 验收标准），≥2 条；
3. **TDD 保质量**：每条用例挂在一条契约上，先 `red` 再 `green`，每条契约至少一条用例；
4. **任务规划**：编号 1..N 的步骤（可人工增删），每步绑定一条契约；
5. **进度记录**：每一步变化（开始 / 完成 / 阻塞 / 改规划）都立刻追加一条并更新任务页，
   不攒到收工；末条总进度必须等于汇总。

状态放 `prototype/`，文档归纳到 `docs/specs/`：

```
prototype/progress.html                总览：进行中 / 待验收的所有任务（--sync 生成）
prototype/<task>/progress.html          单任务：领域 + 契约 + 用例 + 规划 + 记录
prototype/<task>/plan.html              方案页：目标 / 方案 / 页面设计 / 流程交互 / 风险 / 验收 / 确认
prototype/<task>/ui/index.html          UI 设计稿（antd v5 风格、离线静态页）
prototype/<task>/ui/README.md           设计说明（页面目标 / 组件清单 / 状态 / 契约对应）
prototype/_template/progress.html       新建任务页的模板
docs/specs/<task>/proposal.md           为什么做 / 范围 / 非目标 / 验收
docs/specs/<task>/spec.md               契约 S-01、S-02…（SDD）
docs/specs/<task>/design.md             限界上下文 / 统一语言 / 聚合 / 不变量（DDD）
docs/specs/<task>/tasks.md              任务规划 1..N，每步标注落地的契约
scripts/prototype-check.js              门禁：P1–P19（见 §5）
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
任务一开始跑 `plan <task>`：一次补全 `docs/specs/<task>/` 四份文档（提案 / 契约 / 设计 / 规划）、
任务页的领域·契约·用例·规划区块，以及 `prototype/<task>/plan.html`（目标 / 方案 / 页面设计 / 流程交互 / 风险 / 验收）。
内容可以用参数覆盖：`--goal`、`--scope`、`--context`、`--term "术语=定义"`、`--contract "S-01|标题|输入|输出|错误|验收"`
`--step "步骤|S-01"`，或整包 `--input-json '<json>'`。**人可以直接改这些文档**；再跑 `plan` 时已填好的文档默认不覆盖
（`--force` 才重写）。改完：

1. `review <task>` —— Agent 复盘：跑项目判定（文档与页面一致性），写 `review.md`（含四份文档的指纹）；
2. `plan <task> --confirm --by "确认人"` —— 人最终确认：核对复盘指纹后，把方案标为「已确认」并记下文档指纹；
3. 之后才能 `progress` 推进度。**文档在确认后又被改过，确认立即失效**（progress 拒绝、P22 失败），要重新复盘再确认。
   每一步变化（开始 / 完成 / 阻塞 / 改规划）都立刻跑一次 `progress` 并同步总览，不要攒到收工一次性补。
需要界面时先跑 `ui <task>`：生成 `prototype/<task>/ui/index.html`（antd v5 令牌 + 布局 + 表格 + 表单 + 状态）
与设计说明；默认不覆盖人工修改，`--force` 才重写。所有 UI 统一 antd，P20 会拦第二套设计体系。

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
内容从仓库文件扫描生成：配置、功能清单、任务页、规范文档、认领、门禁脚本。命令与参数：

```sh
node plugin/bin/dsh-plugin-harness-cli.js wiki            # 缺则新建，有则更新（默认 ask）
node plugin/bin/dsh-plugin-harness-cli.js wiki --keep     # 只补缺失，冲突文件保留
node plugin/bin/dsh-plugin-harness-cli.js wiki --update   # 覆盖受管区块（人工内容仍不动）
node plugin/bin/dsh-plugin-harness-cli.js wiki --check    # 只报告：缺失 / 过期 / 冲突
```

生成规则（`src/wiki.js`）：

- 每篇只有一个**受管区块**：`<!-- harness-wiki:begin -->` … `<!-- harness-wiki:end -->`；
- **区块外的人工内容永远不会被覆盖**，区块内被人工改过则报冲突；
- 冲突处理三档：`ask`（TTY 逐个询问；非 TTY 报告并以退出码 1 交给人拍板）、`auto`（覆盖）、
  `keep`（保留人工内容，只补缺失文件）；
- 生成时间只写进 `docs/wiki/.harness-wiki.json`，不进正文，避免每次运行都制造改动；
- **只反推项目自己的文件**：会排除工作区里嵌入的 harness-cli 工具目录（按包名 / `bin/dsh-plugin-harness-cli.js` 识别）以及它生成的脚本与页面（`scripts/claim.js`、`scripts/prototype-check.js`、`scripts/gate.sh`、`init.sh`、`prototype/`、`plans.html` 等），避免把工具自身当成业务代码；
- 内容只来自扫描到的事实：技术栈、目录、任务/功能、命令、定位都会**反推**；推不出来的位置不再用「待补」占位，而是以「仍需人工确认：N 处」列在输出里（文件:行），
  命令会要求 Agent 反推工作区补全后重跑。

DSH 侧对应工具 `harness_cli_wiki` 与斜杠命令 `/harness-cli-wiki`：模型先以默认模式跑，遇到退出码 1
（冲突）就询问用户，再带 `auto` 或 `keep` 重跑。生成后若还有「仍需人工确认」的缺口，
命令会通过 `agent.followup` **在当前对话自动发起一条「反推补全」消息**（带缺口清单路径与步骤），
Agent 补完并重跑直到 0 缺口；`--check` 不会发起。

## 10. 随包的 harness-style（`style` 子命令）

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

## 11. 导入 DSH 当工具用（`cordis.mjs`）

CLI 是给人敲的；要让**模型自己**调用，就把它注册成 DSH 插件。适配层是 `plugin/cordis.mjs`
（零依赖，只起子进程），判定与文案仍在 `src/` 与 `templates/`，所以工具行为和命令行逐字一致。

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
| `harness_cli_page` | `page <task>` | 是（页面 + `docs/specs/` 四份文档 + 方案页 + 总览） | 0 / 1 / 2 |
| `harness_cli_review` | `review <task>` | 是（`docs/specs/<task>/review.md`） | 0 / 1 / 2 |
| `harness_cli_plan` | `plan <task> [--confirm]` | 是（`plan.html` + `review.md` 状态） | 0 / 1 / 2 |
| `harness_cli_progress` | `progress <task>` | 是（步骤 / 状态 / 记录 / 总览） | 0 / 1 / 2 |
| `harness_cli_ui` | `ui <task>` | 是（`prototype/<task>/ui/`） | 0 / 1 / 2 |
| `harness_cli_wiki` | `wiki` | 是（`docs/wiki` 受管区块） | 0 / 1（冲突需决策）/ 2 |
| `harness_cli_agents` | `agents` | 是（`dry_run` / `force`） | 0 / 1 |
| `harness_cli_doctor` | `doctor` | 否（工具自检） | 0 / 2 |
| `harness_cli_style` | `style` | 由透传参数决定 | 透传 |

以及十条斜杠命令：`/harness-cli-check [root] [--strict]`、`/harness-cli-init [root] [--preset prototype] [--force] [--dry-run]`
（**默认启用任务页能力**）、`/harness-cli-review [任务名]`、`/harness-cli-plan [任务名] [--confirm --by "人"]`、
`/harness-cli-progress <任务名> --step N --pct X`、`/harness-cli-ui [任务名] [--force]`、
`/harness-cli-wiki [root] [--update|--keep|--check]`、`/harness-cli-doctor [root]`、
`/harness-cli-plans [--serve] [--port 7788] [--stop]`（任务总览：起本机服务后，点任务名弹窗看详细进度，按钮可直接删除 / 重跑 / 保存）、
`/harness-cli-help [命令或工具名]`（一次看全所有工具与命令的用法）。

两个宿主细节写在 `cordis.mjs` 顶部：DSH 桌面端是 Electron，所以子进程要带
`ELECTRON_RUN_AS_NODE=1` 才会被当成 node 执行；目标仓库用子进程的 `cwd` 指定而不是 `--root`，
因为 `style` 的参数是原样透传的，它不认 `--root`。

卸载：删掉 `cordis.patch.yml` 里那段 `- insert:`（`id: harness-cli`），重启 DSH。
工具本身不受影响——命令行仍然可用。

## 12. 开发

```sh
node --test                                  # 108 个用例
node plugin/bin/dsh-plugin-harness-cli.js doctor       # 自检（Node / 模板 / 配置 / 可写）
```

本仓库只放工具本体（`bin/ src/ templates/ tests/` + 入口文档），**不自举**：
它的 `check` 校验的是"目标项目"的配置，在这里直接跑会如实报出"缺少四件套"，
这是预期结果，不是工具坏了。想在本仓库试跑，先 `init` 出一套配置。

设计权衡与被否决的方案见 [`docs/adr/ADR-0001-harness-cli.md`](docs/adr/ADR-0001-harness-cli.md)。
