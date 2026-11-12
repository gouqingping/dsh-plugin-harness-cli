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

## 14. 补充决策（2026-11-09）：操作模式与按步进度

- **开工先问操作模式**：生成的 `AGENTS.md` 顶部固定写一条默认动作——每个 Agent 开工前先问用户
  选「手动」（每步操作等确认）还是「自动 loop」（自动推进，所有确认 / 选择走推荐项）。
  规则放在模板里，所有生成物同源；推荐项的口径是「复盘通过 + 文档指纹未变 + 不破坏人工内容」。
- **续接优先**：默认工作流要求先读进度日志，有未完成任务时先继续完成，禁止从零重做
  或另起无关任务；没有未完成任务时才从功能清单领取新工作。
- **进度按步落盘**：任务页约定从「完成一步再更新」收紧为「每一步变化（开始 / 完成 / 阻塞 / 改规划）
  都立刻更新并同步总览，不许攒到收工」。机械可判定的部分从 P9 / P11 扩展到 P25（步骤百分比必须能
  追溯到 progress 记录）与 P26（记录必须晚于方案确认）；模板与复盘继续约束「每一步都写」的行为。
- **总览页实时化**：`plans --serve` 的 `/` 每次请求都按当前任务页重新渲染，而不是返回上一次
  `plans` 命令写下的静态快照；点任务名直接在弹窗里加载 `prototype/<任务>/progress.html`。
  这样 Agent 更新任务页后，刷新总览即可看到最新进度。

## 15. 补充决策（2026-11-09）：进度写入口与 DSH 实时桥接

- **进度只能由 `progress` 写**：模板不再教 Agent 手改 `.step-pct`；`progress` 追加的记录带
  `data-step` / `data-pct`，P25 要求页面百分比能追溯到记录，P26 要求记录晚于方案确认。
  这样「手改页面」和「先写进度后补确认」都会在门禁里失败。
- **总览推送而不是刷新**：`plans --serve` 增加 `/api/tasks` 与 SSE `/api/events`，任务页变化会推给
  总览页；任务页在 HTTP 下用 `Last-Modified` 自检并自动重载。`file://` 仍保持静态快照语义。
- **DSH todo 事件桥接**：DSH 的 `todo/write` 是会话日志里的整表快照（`event.data.todos`，每项只有
  `content` / `status`），会话目录在 `session.header.cwd`。插件在 `cordis.mjs` 订阅 `session/event`，
  只处理顶层会话，按 todo 标题匹配当前任务页步骤，再调用 `progress` 落盘；方案未确认、任务不唯一
  或匹配不到步骤时跳过，不绕过 P21/P22 的确认链。

## 16. 补充决策（2026-11-09）：TDD 验证步骤改为模拟环境沙箱测试

- **口径**：TDD 用例的验证步骤不再要求真机，统一写成「模拟环境沙箱测试」：沙箱入口、准备数据、
  执行命令、断言四件事写清楚。
- **落点**：任务页模板、`prototype-README`、`AGENTS.md` 与自动生成的用例命令都使用同一口径。
- **判定**：P15 检查用例正文；仍含「真机」的用例直接失败，提示改成模拟环境沙箱测试。

## 17. 补充决策（2026-11-11）：选择先反馈，命令后执行

- **选择即时反馈**：`userQuestions` 的每次点选或文本输入，在 `askChoice` 返回前立即追加为当前会话的
  `user/message`（`surfaceOp: append`），正文用「已选择：…」或「已输入：…」；它只显示在对话里，
  不唤醒新的模型回合。命令菜单、任务名、UI、确认、删除、wiki 冲突与端口等全部选择共用这条路径。
  前提是会话已有 `system` head；首轮开始前没有 head 时跳过（见 §19）。
- **page / plan 两阶段执行**：先完成任务名与「是否生成 UI 设计稿」的选择，再执行主命令；选择 UI 时
  依次执行主命令与 `ui`。主命令失败则不继续生成 UI。
- **plan 开工延后**：如果 `plan` 同时选择生成 UI，方案命令完成后先执行 `ui`；只有 UI 成功生成后
  才启动总览服务并自动发起「开始执行」回合。UI 失败时不自动开工。
- **判定**：`plugin/tests/cordis.test.js` 在选择回调发生时检查目标文件尚未写入，并断言每条选择都产生
  一条即时对话消息；`plan` 用例在首次自动开工回调时断言 UI 文件已经存在。

## 18. 补充决策（2026-11-11）：键盘选择与自动消息直投

- **键盘菜单**：输入框工具栏的 Harness-CLI 指令菜单支持 `↑/↓` 循环、`Home/End` 跳首尾、
  `Enter/空格` 执行当前项、`Esc` 关闭并回到指令按钮。菜单项使用 roving focus，鼠标点击行为不变。
- **自动消息直投**：plan 自动开工、UI 缺口补全和 wiki 反推补全都优先调用 `agent.steer()`，
  直接送入当前执行流，不再经由 `agent.followup()` 排到下一轮；只有缺少 `steer()` 的旧宿主才回退到队列。
- **判定**：`plugin/tests/client.test.js` 覆盖键盘索引循环与首尾跳转；`cordis.test.js` 对三条自动消息
  同时记录 `steer` / `followup`，要求前者调用一次、后者零次。

## 19. 补充决策（2026-11-12）：首轮前不写选择反馈，保住 v4 日志可冷读

- **问题**：新会话在首轮开始前调用 `/harness-cli`，`appendChoiceFeedback` 直接追加 `user/message`，
  surface 的第一个节点变成用户消息；DSH v4 要求首个节点是受保护的 `system/message`，冷读会报
  `system/message requires a protected first surface head`，整个会话历史打不开。2026-11-11 的
  4 个会话就是这条路径写坏的，已按「把 head 之前的 surface 消息移到 head 之后」修复并复原。
- **决策**：`appendChoiceFeedback` 先看 `session.surface.nodes`：为空或首节点不是 `system/message`
  时跳过，不写日志；没有 surface API 的旧宿主沿用旧行为。命令结果仍由当前 handler 返回，模型上下文
  不丢，只是少一条独立的「已选择：…」消息。
- **判定**：`plugin/tests/cordis.test.js` 的「首轮前没有 system head 时跳过选择反馈」同时覆盖空
  surface 与首节点为 `user/message` 两种情形，并断言删除命令本身仍然成功。

## 20. 补充决策（2026-11-12，已由 §23 撤销）：UI 设计先选方向，再生成 index.html

- **问题**：`ui` 一跑就直接写 `ui/index.html`，等于在「用哪个设计方向」还没定的时候就先画完了；
  人看到的是一份默认管理后台，想换方向只能整页重写，选择没有落到文件里。
- **决策**：引入设计方向目录（`plugin/src/ui-designs.js`）：`admin` 标准管理后台、`dashboard` 数据看板、
  `workbench` 流程工作台。三个方向共用 antd v5 令牌与组件，只改信息架构重点（表格 + 表单 / 趋势图 + 明细 /
  步骤 + 待办 + 时间线），设计稿的 `<html data-design="…">` 记录选中的方向。
- **门禁**：`ui` 必须带 `--design <id>`（或沿用已有 `index.html` 的 `data-design`）才写 `index.html`；
  没选方向时只写一份「方向待选」的 `ui/README.md` 并退出 1，绝不生成设计稿。`ui --list-designs` 列方向；
  未知方向按用法错误退出 2。
- **旧稿迁移**：已存在但没有 `data-design` 的旧设计稿不猜方向，也不在旁边再写待选说明；要求显式
  `--design` 后才重写（`--force` 可整页覆盖）。
- **交互**：`/harness-cli` 的 page / plan 在「生成 UI 设计稿」之后紧接着问「用哪个设计方向」，选定后才
  执行 `ui`；`/harness-cli ui` 同样先弹出方向选择。取消选择则只留待选说明，`plan` 不自动开工。
  工具 `harness_cli_ui` 增加 `design` 枚举参数，模型必须先问用户再调用。
- **判定**：`plugin/tests/e2e.test.js` 覆盖「没选方向 → 退出 1 且没有 index.html」「方向写入 data-design
  且重跑沿用」「未知方向退出 2」；`plugin/tests/cordis.test.js` 在设计方向回调发生时断言 index.html 还不存在，
  并在选完后断言文件已生成。

## 21. 补充决策（2026-11-12）：任务页增加步骤流程条

- **问题**：任务页只有逐步骤卡片和总进度，看不到「整条流程走到哪一步」；当前步骤要靠人从上往下扫卡片判断。
- **决策**：在 `progress.html` 的总进度下面加「步骤流程」：按「4. 任务规划」的顺序画横向流程（1 → 2 → …），
  每个节点显示标题、百分比与状态（100% 已完成 / >0 进行中 / 0 未开始）；第一个未完成步骤高亮并标「当前」。
  上方两行汇总「第 N / M 步 · 已完成 X 步」与「当前步骤：…」；点节点可平滑定位到对应步骤卡片。
- **单一数据源**：流程由页面脚本从 `li.step` / `.step-pct[data-pct]` 读取后生成，不另存一份步骤数据；
  步骤顺序或百分比一改，流程与汇总自动重算。
- **老页面升级**：旧任务页没有该区块时，下一次 `progress` 写入会从当前模板取「步骤流程」区块与脚本补上
  （保留原有内容与百分比），不需要重跑 `page --force`。
- **判定**：`plugin/tests/e2e.test.js` 断言新任务页带 `data-flow` / `data-progress-flow` 与当前高亮逻辑；
  另一个用例把旧页面的区块与脚本删掉后跑 `progress`，断言被补齐且新百分比仍在。

## 22. 补充决策（2026-11-12）：help 先选指令，再给说明

- **问题**：`/harness-cli help` 一次性打印全部命令、工具与流程，想查某条指令的用法要自己翻。
- **决策**：`help` 不带主题时先弹一个**非必选**的选择框，选项是**指令后缀**（`delete` / `page` / `plan` /
  `progress` …，含菜单里收起的 `progress`）与「完整帮助」；选中 `delete` 等价于执行
  `/harness-cli help delete`，只显示该指令的用法、说明与对应工具，跳过 / 取消 / 没有选择框时回退到完整帮助。
  选择链（`已选择：帮助 → delete`）并进结果卡片顶部，不再单独追加「已选择」消息——DSH 把命令结果固定在
  command/run 位置，单独的选择消息必然排在卡片之后，并进卡片才能保持「选择在前、说明在后」的阅读顺序。
  `help <子指令>`、`help process` 仍直接出结果，不再二次弹窗。
- **单一真源**：子指令的用法与说明集中在 `SUBCOMMAND_HELP`，选择框与 `help <子指令>` 共用同一份文案。
- **判定**：`plugin/tests/cordis.test.js` 覆盖「选择框包含所有指令与完整帮助」「选 check 只看 check 说明」
  「取消后回退完整帮助」三个分支。


## 23. 补充决策（2026-11-12）：撤销 UI 设计方向选择，恢复单一 antd 模板

- **背景**：§20 引入的三个方向（`admin` / `dashboard` / `workbench`）在实际使用中多了一步交互，
  用户确认不需要，要求回到之前的方案。
- **决策**：撤销 §20：删除 `plugin/src/ui-designs.js` 与「方向待选」说明；`ui` 不再要求 `--design`，
  直接生成单一 antd v5 模板（布局 + 指标卡 + 表格 + 表单 + 状态）；page / plan 的 UI 询问恢复为
  「要不要生成 UI 设计稿」；P20 的 `data-design` 警告一并移除。
- **保留**：任务页「步骤流程」（§21）与 `help` 指令选择框（§22）不受影响。
- **判定**：删除 `--design` / `--list-designs` / `data-design` 相关用例；`ui` 不带参数仍生成
  `prototype/<任务>/ui/index.html`，`--force` 覆盖语义不变。
