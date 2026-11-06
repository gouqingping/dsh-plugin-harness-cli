# ADR-0001：dsh-plugin-harness-cli 的设计决策

- 状态：已接受
- 日期：2026-11-06
- 相关：讲义 W3（四件套）、W4（门禁 / DoD）、W8 D4（六步施工法）

## 1. 背景

讲义把 Harness 的落地拆成四件套（入口 / 环境 / 范围 / 状态）+ 门禁，并要求"规则要由机器保证"。
手工维护的问题很具体：每个项目重写一遍模板、每份 AGENTS.md 结构都不一样、`done` 没有证据、
`in_progress` 同时出现两个、新项目干脆从零开始攒。

平台侧的 `dsh-project` 骨架（`docs/{current,summary,graph,feature_list}.json`、
`version-info/`、`.harness/<id>_ci.yaml`、`.gitignore` 八条）是既有格式约定，必须对齐；
但本机**没有安装** `dsh-project`，`npx dsh-project` 需要联网。于是自建一个离线等价物。

## 2. 决策一：生成四件套，而不是再写一份文档

- 采用「入口 `AGENTS.md` + 环境 `init.sh` + 范围 `feature_list.json` + 状态 `claude-progress.md`」，
  再加一道 `gate.sh` 门禁。它们对应五类失败模式，缺一格就有对应的失忆。
- 四件套由 `AGENTS.md` 统一索引（§3 命令、§5 工作流、§8 链接），形成"读入口即可导航"的闭环。
- 否决：只生成一份 README——README 面向人，不承载「禁止事项 / 完成定义」，Agent 读不出边界。

## 3. 决策二：Node.js 实现，零运行时依赖

- 选 Node 而非 Python：生成的 CI 骨架与目标仓库大多是 Node 项目（`node:18-bullseye`、`npm`），
  工具与被测环境同栈，`npx` 直接可用，不需要额外安装步骤。
- 零依赖（只用 `fs` / `path` / `child_process` / `node:test`）：离线环境 `npm install` 会失败，
  一旦有依赖，工具在干净机器上就等于坏掉——而"换台机器也能跑"正是 `init.sh` 的验收标准。
- 否决：用 Python 复用 `agent-style-harness` 的 vendor（跨语言，且生成的 CI 是 Node 镜像）；
  引入 `handlebars` / `ajv`（离线装不上，见上）。

## 4. 决策三：功能清单放 `docs/feature_list.json`

讲义 W3 D4 把 `feature_list.json` 放在仓库根目录；平台骨架放在 `docs/` 下。

- 选择 `docs/`：与平台 `harness_check` 对齐，避免同一个仓库出现两份清单。
- 代价：与讲义路径不同。缓解办法是路径可配置（`paths.featureList`），并在本文件留档。
- 命名演进：`common-agent.json` → `harness-pro.json` → `harness-cli.json`（本版）。
  旧名按新→旧顺序保留为兼容候选，读到就提示改名，不静默忽略；一个都读不到才用默认配置。
- 字段取并集：平台的 `project` / `description` / `generatedAt` / `conventions` / `maintenance`，
  讲义的 `id` / `name` / `description` / `status` / `acceptance` / `evidence` / `depends_on`。

## 5. 决策四：模板是唯一真源

- 所有生成物文案放 `templates/*.tmpl`；`src/` 只负责取值、拼装、判定。
- 配置里需要引用路径时用 `{featureList}` 这类占位符，由 `src/context.js` 展开，
  避免默认值里写死相对路径（曾因此在 `AGENTS.md` 里产生过失效链接，被 `A104` 抓住）。
- 判定项一律带 `id`（`A102`、`F107`、`P5`…），失败信息给出可行动的下一步。

## 6. 决策五：`check` 只读，修复交给 `init` / `agents`

- 自动改写会掩盖漂移：Agent 看到"绿"就停手，问题被顺手改掉而不是被理解。
- 唯一例外是显式命令（`init --force`、`agents`），且默认永不覆盖非空文件。
- 漂移用 `A106` 表达：`AGENTS.md` 与配置重新渲染的结果不一致时给警告，而不是偷偷覆盖。

## 7. 决策六：状态文件连 `--force` 都不覆盖

`docs/feature_list.json`、`claude-progress.md`、`docs/current.md`、`task_queue.json` 标记为
`state`：生成器只在它们缺失或为空时写入，`--force` 也不行，必须显式 `--force-state`。

- 起因：自举时跑 `init --force` 把进度日志与功能清单一起冲掉了——正是讲义 W1 D5 的
  "跨会话状态丢失"，只不过这次是工具自己造成的。
- 结构文件（`AGENTS.md`、`init.sh`、`gate.sh`、`docs/summary.json`、CI、版本说明）仍可 `--force`：
  它们的真源是配置与模板，重生成不会丢信息。

## 8. 决策七：退出码 0 / 1 / 2 与 harness-style 对齐

`0` 通过、`1` 有违规（可预期失败）、`2` 工具或用法有错。两个工具因此能串进同一条门禁：

```sh
./bin/harness-style check --staged && node ../common-agent/plugin/bin/common-agent.js check
```

## 9. 决策八：可选能力做成 preset，默认关闭

`prototype` preset（任务进度页约定）只对需要的项目开启：

- 关闭时 `AGENTS.md` 少一节、`check` 不跑 `P*` 判定，默认生成物保持最小；
- 开启后追加约定、禁止事项、DoD 与 `scripts/prototype-check.js`；
- 判定逻辑放在**生成到目标仓库的脚本**里，`dsh-plugin-harness-cli check` 通过子进程调用它。
  好处是"生成物本身可独立运行"，规则与本仓库无隐式耦合，也顺带证明了生成物可用。

## 10. 决策九：版本说明改叫 `_VERSIONS/vx.x.x.md`，并写成业务白话

- 原因：版本说明的读者是产品、运营、测试与刚接手的同事，不是本仓库的开发者。
  `version-info` 这种英文目录名 + "实现细节"式写法，非开发同事不会点开，点了也读不懂。
- 做法：目录 `_VERSIONS/`，文件名 `v<版本号>.md`。固定四段——1. 更新内容（编号条目）
  2. 实现方式 3. 逻辑图 4. 验证标准（可勾选），再加 5. 已知限制。
- 白话的边界：讲"做了什么、为什么这么做、怎么确认做好了"，不讲函数名与参数；
  必须出现的术语就在括号里用一句人话解释。
- 代价：平台 `harness_check` / `harness_ensure` 仍按 `version-info/v0.1.0.md` 探测，
  改名后这两项会持续报缺失。这是有意的偏差，记录在此；若要回到平台约定，
  改 `paths.versionInfo` 一处即可，其余不动。
- 判定：`V102`（四段齐全）、`V103`（更新内容有编号条目）、`V104`（不留待补占位）、
  `V105`（验证标准可勾选）。语气是否够白话不做机械判定——判不了，靠模板与评审。

## 11. 决策十：把 harness-style 随包携带，用子进程接入

- 原因：项目配置（四件套）与代码风格（lint / 提交信息）是同一件事的两半——都回答
  "规则由谁保证"。分成两个包安装，实际使用中一定会有一个忘装。
  `harness-style` 的规则与 vendor 依赖已经稳定，重写等于制造第二套会漂移的判定。
- 做法：整包放进 `plugin/vendor/agent-style-harness/`（含 `vendor/py` 的 yapf / isort 与
  `vendor/node` 的 commitlint，离线可用，约 48 MB）；CLI 增加 `style` 子命令，参数与退出码
  **原样透传**，不拦截、不改写。
- 代价：包体积从不到 1 MB 涨到约 48 MB；`style` 需要目标机器有 `python3`（3.8+）；
  vendor 里的 `node_modules` 必须入库，`.gitignore` 为此加了例外（否则离线可用就是空话）。
- 判定：`doctor` 增加 `style` 一项（随包存在 + `python3` 可用），缺失只警告不阻塞——
  配置生成不依赖 Python，不该因为没装 python 就整体失败。
- 被否决：把 harness-style 改写成 Node（重写规则，风险最高、收益最低）；
  运行时按需下载依赖（离线环境直接失效）；只写个路径指向工作区里的
  `agent-style-harness/`（安装包就不自治了，换台机器立刻断）。

## 12. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 把 `dsh-project` 的产物硬编码在脚本里 | 文案会腐烂，且无法按项目裁剪 |
| 用 YAML 写配置 | 需要解析器（依赖）或自写子集（易错）；JSON 零成本 |
| 一个巨型 AGENTS.md | 超过 120 行后模型开始忽略中段（W5 Lecture 3），入口必须短 |
| `check` 自动修一切 | 掩盖漂移，且模板渲染不一定能反推用户意图 |

## 13. 尚未纳入

- **测试数量不退化检查**（W8 D4 第 5 步）：需要保存基线并从测试输出解析用例数，
  各项目测试命令输出格式不一，当前不算可机械判定。
- **多 Agent / worktree 隔离**：超出"项目配置"范围，留给 W9 的专题。
