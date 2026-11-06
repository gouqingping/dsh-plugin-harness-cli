# harness-style

离线代码规范判定器：把 [Google Style Guide](https://google.github.io/styleguide/) 里**能机械判定的部分**
落到 CLI 与 git hook，把提交信息交给 [commitlint](https://commitlint.js.org/)。

> 设计决策、权衡与被否决的方案见 [`docs/adr/ADR-0001-style-harness.md`](docs/adr/ADR-0001-style-harness.md)。

核心分工：

```
AGENTS.md 契约 → harness-style 判定 → git hooks 强制 → skill 薄壳说明
```

**工具是唯一判定者；skill 不判定，只教 agent 怎么用。**

## 快速开始

在**目标仓库**里执行（目标仓库必须是 git 仓库）：

```sh
# 1. 接入：复制配置模板 + 写 harness-style.json + 安装 hook
/path/to/agent-style-harness/bin/harness-style init --lang py,ts

# 2. 自检：缺什么依赖会明确告诉你
./bin/harness-style doctor      # 注意：解压/放置工具后，把本仓库的 bin 加进 PATH 或直接用绝对路径

# 3. 检查 / 修复
./bin/harness-style check --all
./bin/harness-style fix --all
```

> `init` 会把模板复制到目标仓库根目录（`.editorconfig`、`.style.yapf`、`.eslintrc.json`、
> `commitlint.config.cjs` 等），因为所有判定器都从 cwd 向上自动发现配置。

## 命令

| 命令 | 作用 |
|---|---|
| `harness-style check [--staged\|--range A..B\|--all] [--json] [--strict]` | 只读检查 |
| `harness-style fix [--staged\|--all] [--dry-run]` | 自动修复（显式触发，hook 里不自动改文件） |
| `harness-style commit-msg <file>` | 校验提交信息（含 merge/revert/rebase 边界） |
| `harness-style install-hooks [--force]` | 写 `.githooks/` 并设置 `core.hooksPath` |
| `harness-style uninstall-hooks` | 移除 hook 与 hooksPath |
| `harness-style baseline update --all` | 记录当前违规作为基线 |
| `harness-style doctor [--json]` | 依赖、配置、hook 完整性自检 |
| `harness-style init --lang py,ts,java,cpp,sh` | 首次接入 |

### 退出码（严格区分）

| code | 含义 | 调用方动作 |
|---|---|---|
| `0` | 通过 | 放行 |
| `1` | 有违规 | 阻断 |
| `2` | **工具自身故障**（缺依赖、配置错、vendor 损坏） | 阻断，但**不要**去改代码 |

把 `2` 当成 `1`，会让 agent 在"依赖没装好"时开始瞎改代码——这是本项目最重要的约束之一。

## 目录

```
agent-style-harness/
├── bin/harness-style          # 入口（直接挂 src/，无需安装）
├── src/harness_style/         # 核心：config / discovery / engines / checker / hooks
├── templates/                 # 各语言配置模板（init 复制到目标仓库根目录）
├── rules.map.json             # 规则码 → Style Guide 章节
├── vendor/                    # 离线依赖（py / node）
├── skill/google-style-guard/  # 薄 skill（~90 行）
├── tests/                     # 39 个用例，不依赖外部工具链
├── harness-style.json         # 本仓库自身配置
└── docs/adr/                  # 设计文档
```

## 离线依赖

`vendor/` 已包含可直接使用的依赖，运行时**不联网**：

| 路径 | 内容 |
|---|---|
| `vendor/py/` | yapf 0.43.0、isort 5.13.2（Python 引擎，已端到端验证） |
| `vendor/node/node_modules/` | @commitlint/cli 19.8.1、config-conventional 19.8.1（已端到端验证） |

commitlint 的 `extends` 以「配置文件所在目录」为起点解析模块，目标仓库没有 `node_modules` 时会
`MODULE_NOT_FOUND`。工具在调用 commitlint 时注入 `NODE_PATH` 指向 `vendor/node/node_modules`，
因此**目标仓库零安装**即可使用离线依赖（已端到端验证）。

补齐其它语言（当前机器上没有对应工具链，故未随附）：

```sh
# TypeScript：在目标仓库里
npm install --save-dev gts@6 typescript@5

# Java：把 google-java-format jar 放到 vendor/java/
# C++：把 clang-format / clang-tidy 静态二进制放到 vendor/bin/<platform>/
#    平台名形如 linux-x64、darwin-arm64、windows-x64
# Shell：shfmt、shellcheck 同上
# Go：需要 Go 工具链（gofmt 随工具链提供）
```

## 引擎状态

| 语言 | 引擎 | 状态 |
|---|---|---|
| Python | yapf(google) + isort | ✅ 本机端到端验证（check / fix / baseline / hook 阻断） |
| 提交信息 | commitlint 19 | ✅ 端到端验证（hook 真实拒绝过 `update`，接受过 `feat: 增加示例脚本`） |
| TypeScript | gts（eslint 8） | ⚠️ 代码完成，本机未装 gts，未端到端验证 |
| Java | google-java-format | ⚠️ 代码完成，缺 jar |
| C++ | clang-format | ⚠️ 代码完成，缺二进制 |
| Shell | shfmt + shellcheck | ⚠️ 代码完成，缺二进制 |
| Go | gofmt | ⚠️ 代码完成，缺 Go 工具链；配置里默认关闭 |

未验证的引擎在 `doctor` 里会明确标红并给出缺失项，不会静默通过。

## 已知限制

- **Java 的行号**：`google-java-format --dry-run` 只输出文件名，所以违规统一报在第 1 行。
- **gofmt / Java 的基线粒度**：每文件一条违规，`baseline` 只能按文件计数。
- **TypeScript**：依赖 gts 6（eslint 8）。项目里不要放 eslint 9 的 `eslint.config.js`，
  否则 gts 读不到配置会**静默通过**——比报错更危险。
- **无 vendor 校验和清单**：`vendor/MANIFEST.sha256` 尚未生成（P2 待办），
  `doctor` 目前只检查目录是否存在。
- **hook 可被绕过**：`--no-verify` 仍然有效，CI 必须再跑一次 `check --range`。

## 在 DeepSeek Harness 中使用

DSH 用两个互相独立的机制接入，缺一不可：

| 机制 | 作用 | 本工具怎么用 |
|---|---|---|
| skill（`dsh-skill-filesystem`） | 让 agent 在会话里发现"何时该跑检查、怎么读结果" | `harness-style install-skill` |
| AGENTS.md（`dsh-agent-instructions`） | 把硬约束注入每次请求 | `harness-style init` 自动写入 |

### 1. 安装 skill

DSH 只扫描以下根的**顶层** `<name>/SKILL.md`，不支持嵌套：

| rank | 路径 | 范围 |
|---|---|---|
| 100 | `<repo>/.dsh/skills` | 当前仓库 |
| 200 | `<repo>/.agents/skills` | 当前仓库 |
| 400 | `~/.dsh/skills` | 所有项目 |

```sh
harness-style install-skill                # 当前仓库
harness-style install-skill --scope user   # 所有项目
```

装完无需重启：provider 监听目录变化，下一次请求的 `<available_skills>` 里就会出现
`google-style-guard`。用户可用 `/google-style-guard` 显式调用。

> 仓库里的 `skill/google-style-guard/SKILL.md` 是**源文件**，位于 `<repo>/skill/...`，
> 不在扫描根上——必须 `install-skill` 复制过去，DSH 不会自动发现它。

### 2. AGENTS.md

`init` 会往仓库根 `AGENTS.md` 追加带 `<!-- harness-style:begin -->` 标记的硬约束段，
重复执行幂等（替换而非重复追加）。DSH 从项目根到 cwd 逐级加载 AGENTS.md，写在根即可覆盖整个仓库。

### 3. 验证

1. 下一轮对话的目录里出现 `google-style-guard`；
2. `/google-style-guard` 可显式调用；
3. 让 agent 改完代码后提交，它应当先跑 `check` 再提交；
4. `git commit` 时 hook 仍然生效——这是最后一道门，不依赖 agent 记性。

## 测试

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -t .
```

覆盖：glob 匹配、diff 分块、配置校验、语言分组、baseline 抑制、JSON schema、
hook 安装/篡改检测、commit-msg 的 empty/merge/revert/fixup 分支、`exit 2` 语义。
