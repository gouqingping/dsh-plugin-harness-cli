# ADR-0001：Agent 代码规范强制层 —— 工具内核 + Skill 薄壳

- **状态**：Accepted（P0/P1 已实现，见 `src/harness_style/` 与 README「引擎状态」）
- **日期**：2026-11-04
- **范围**：离线 agent harness 的代码风格约束（[Google Style Guide](https://google.github.io/styleguide/)）与提交信息规范（[commitlint](https://commitlint.js.org/)）
- **目标读者**：实现这套工具的工程师、维护 harness 规则的人

---

## 1. 背景与问题

Agent 生成代码的速度远高于人审速度，随之出现三类可观测的退化：

1. **风格漂移**：每个任务用不同的命名、缩进、import 顺序，review 成本转移到人身上。
2. **提交信息失控**：`update`、`fix bug`、`修改` 之类的 message，导致 changelog 无法生成、变更无法回溯。
3. **不可审计**：agent 自称"已遵守规范"，但没有任何可复核的证据。

需要一个**离线可运行、可被 hook 与 CI 强制、结果可复现**的约束层。

### 1.1 一个必须先承认的事实

Google Style Guide 的内容分两类：

| 类型 | 例子 | 能否机械判定 |
|---|---|---|
| **形式类** | 缩进、行宽、括号位置、import 排序、javadoc 结构 | 能，且已有官方/成熟工具 |
| **语义类** | 命名词性、错误处理取舍、指针所有权、注释该写什么、API 设计 | 不能，任何正则会误报到不可用 |

所以本文档的每个决策都基于：**工具只对"形式类"负责，并且要明确说出自己不负责什么**。试图让工具覆盖语义类条款，是这个项目最可能的失败方式。

---

## 2. 决策

> **判定逻辑做成离线 CLI 工具（唯一判定者），agent 侧只保留一个薄 skill 作为入口与使用说明。**

具体是四层，不是二选一：

```
        AGENTS.md / 规则文件          硬约束，签名式声明（不是散文）
                 │
        harness-style CLI             唯一判定者：check / fix / commit-msg，返回 exit code
                 │
   git hooks（core.hooksPath）        自动触发：pre-commit / commit-msg
                 │
        skill（薄壳 ~100 行）          何时调、怎么调、报错怎么读、哪些条款机器管不了
```

**为什么不是 skill 为主**（否决理由，见 §11）：skill 没有 exit code、不能挂进 hook/CI、检出率随模型与上下文波动、结果不可复现。规范检查是布尔判定，布尔判定必须由程序给。

**为什么不是纯工具**：工具有发现成本。agent 不知道命令、不知道怎么读 `fixable:false`、不知道哪些条款要靠自查。没有这层说明，典型结局是"装了但没人用"。

---

## 3. 目标 / 非目标

### 目标

- `git commit` 前，暂存区改动必须通过形式类规范检查（离线、无网络）。
- 任何来源的 commit message（人手写、agent 自动生成）都必须通过 commitlint 校验。
- Agent 能在**不被告知**的情况下发现并使用这套工具（靠 skill + AGENTS.md）。
- 每条违规可追溯到 Style Guide 的具体章节（可审计）。
- 每种语言的约束都落到**具体配置文件**（`templates/`），可复制、可 review、可版本化，而不是只存在于文档描述里。
- 老仓库可增量接入，不被历史违规淹没。

### 非目标

- 不校验语义类规范（命名好坏、设计合理性）——由评审与 checklist 负责。
- 不做代码生成、不做自动重构、不做安全扫描。
- 不替代 CI 里的完整 lint/测试，只做提交前的快速门禁。
- 不强制统一到"某一种"风格：只强制 Google profile，其他 profile 属于后续扩展。

---

## 4. 系统架构

### 4.1 目录布局（工具仓库自身）

```
agent-style-harness/
├── AGENTS.md                      # 规则入口（硬约束段）
├── harness-style.json             # 唯一配置源（JSON，见 4.4 说明）
├── .githooks/
│   ├── pre-commit                 # 调 check --staged
│   └── commit-msg                 # 调 commit-msg "$1"
├── bin/harness-style              # 入口 shim（python3，跨平台）
├── src/harness_style/
│   ├── cli.py                     # 参数解析、退出码
│   ├── config.py                  # 配置加载与校验
│   ├── discover.py                # 暂存区/差异 → 文件清单 → 语言分组
│   ├── engines/                   # 每种语言一个适配器（统一接口）
│   │   ├── base.py                # Engine: available()/check()/fix() -> Violation[]
│   │   ├── python_yapf.py
│   │   ├── ts_gts.py
│   │   ├── java_gjf.py
│   │   ├── cpp_clang.py
│   │   ├── go_gofmt.py
│   │   └── shell_shfmt.py
│   ├── commitlint.py              # 包装 @commitlint/cli
│   ├── baseline.py                # 基线抑制
│   ├── report.py                  # 人读 / JSON 输出
│   └── bootstrap.py               # 离线依赖安装与校验
├── rules.map.json                 # 工具规则 → Style Guide 章节 映射
├── templates/                     # 各语言配置文件模板（见 §6.2）
│   ├── root/                      # .editorconfig / .gitattributes / commitlint.config.cjs
│   ├── typescript/  python/  cpp/  shell/
│   └── README.md                  # 文件清单、接线方式、改规则纪律
├── skill/google-style-guard/      # 薄 skill
│   └── SKILL.md
├── vendor/                        # 离线依赖（见 §7）
└── docs/adr/
```

### 4.2 关键决策：CLI 用 Python 3（仅标准库）实现

| 方案 | 优点 | 缺点 |
|---|---|---|
| **Python 3 编排器（选定）** | 本机已有 3.8；零第三方依赖；跨平台；能直接调各语言判定器 | 需分发解释器（多数环境已有） |
| Node/TS 编排器 | 与 commitlint 同栈 | 所有语言都要装 node；Python/Java 场景被绑死 |
| Go 单文件二进制 | 分发最干净 | 本机无 Go 工具链；开发成本最高 |
| Shell 脚本 | 最简单 | Windows 不可用、错误处理差 |

选定 Python，**只用标准库**（`argparse`/`json`/`subprocess`/`hashlib`/`pathlib`）。这也是配置选 JSON 而不是 TOML 的原因：Python 3.11 才有 `tomllib`，3.8 需要额外依赖。

Go 单二进制作为 v2 的可选演进路径记录在此，不作为第一版目标。

### 4.3 引擎适配器统一接口

```python
class Engine(Protocol):
    name: str            # "yapf" / "gts" / "clang-format"
    languages: list[str] # ["python"]
    def available(self) -> bool: ...
    def version(self) -> str: ...
    def check(self, files: list[Path]) -> list[Violation]: ...
    def fix(self, files: list[Path]) -> list[Path]: ...   # 不可修复时返回空
```

约束：**适配器不产生新规则**，只翻译（parse）判定器的原始输出。规则由判定器决定，`rules.map.json` 只做引用与分级。

### 4.4 配置：`harness-style.json`

```json
{
  "version": 1,
  "profile": "google",
  "languages": {
    "python":      { "enabled": true, "engine": "yapf",         "severity": "error" },
    "typescript":  { "enabled": true, "engine": "gts",          "severity": "error" },
    "java":        { "enabled": true, "engine": "google-java-format", "severity": "error" },
    "cpp":         { "enabled": true, "engine": "clang-format", "severity": "error" },
    "go":          { "enabled": false, "engine": "gofmt",       "severity": "error" },
    "shell":       { "enabled": true, "engine": "shfmt",        "severity": "warning" }
  },
  "commitlint": {
    "extends": ["@commitlint/config-conventional"],
    "scopes": ["cli", "hooks", "engines", "docs", "vendor", "ci"]
  },
  "exclude": ["**/vendor/**", "**/dist/**", "**/build/**", "**/*.min.js", "**/node_modules/**"],
  "severity": { "format": "error", "lint": "warning" }
}
```

`languages.go.enabled=false` 的理由见 §6，不是遗漏。

---

## 5. CLI 契约（实现前先冻结）

```
harness-style check  [PATH...] [--staged | --range <A..B> | --all] [--json] [--strict]
harness-style fix    [PATH...] [--staged | --all] [--dry-run]
harness-style commit-msg <msg-file> [--json]
harness-style install-hooks [--force] / uninstall-hooks
harness-style baseline update [--all]      # 显式快照当前违规
harness-style doctor                        # 依赖完整性 + 版本 + hooks 状态
harness-style init --lang ts,py,cpp         # 按语言复制 templates/ + 装 hook
```

### 5.1 退出码（必须严格区分）

| code | 含义 | 调用方行为 |
|---|---|---|
| `0` | 通过 | 放行 |
| `1` | 存在违规 | 阻断；输出违规清单 |
| `2` | 工具自身故障（缺依赖、文件不可读、vendor 校验失败） | **不得**当作"有违规"处理；hook 应打印明确错误，CI 应中断 |

把 2 和 1 混用，会导致"依赖没装好"被误报成"代码不合规"，agent 会开始瞎改代码。这是必须写进代码的纪律。

### 5.2 JSON 输出（`schema: harness-style/v1`）

```json
{
  "schema": "harness-style/v1",
  "ok": false,
  "scope": "staged",
  "env": {
    "offline": true,
    "engines": { "yapf": "0.43.0", "gts": "6.0.2", "clang-format": "18.1.8" }
  },
  "summary": { "files": 4, "errors": 3, "warnings": 7, "fixable": 2 },
  "violations": [
    {
      "engine": "yapf",
      "code": "format",
      "file": "src/foo.py",
      "line": 12,
      "column": 5,
      "severity": "error",
      "fixable": true,
      "message": "...",
      "doc": "https://google.github.io/styleguide/pyguide.html#s3.2"
    }
  ]
}
```

`env.engines` 里的版本号不是装饰：没有它，两次检查结果不一致时无法归因。

### 5.3 增量判定

- `--staged`：`git diff --cached --name-only --diff-filter=ACMR`，只查暂存区。**默认**用于 hook。
- `--range A..B`：CI 用。
- `--all`：全仓，仅用于建立基线或夜间趋势。
- 历史违规用 `.harness-style/baseline.json` 抑制：按 `(file, code)` 记数，只比较计数增量。**只允许 `baseline update` 显式更新**，且该文件变更必须在 PR 里单独 review。

---

## 6. 判定器矩阵

| 语言 | 引擎 | 锁版本（示例） | 覆盖条款 | 级别 | 离线形态 |
|---|---|---|---|---|---|
| TypeScript / JS | `gts`（Google TypeScript Style，内含 eslint + prettier） | 6.0.x | 格式、import 顺序、多数 lint | error（格式）/ warning（lint） | npm tarball + `vendor/node_modules` |
| Python | `yapf --style=google` | 0.43.x | 格式（Google 自己维护） | error | 纯 py wheel |
| Java | `google-java-format` | 1.2x | 格式（官方） | error | jar（JDK 17 已具备） |
| C++ | `clang-format`（`BasedOnStyle: Google`）+ `clang-tidy` 子集 | 18.x | 格式 100%；tidy 选 5~8 条 | error / warning | 静态二进制，分平台 |
| Go | `gofmt` / `goimports` | 随工具链 | `gofmt` 即规范来源 | error | 需 Go 工具链（本机缺失） |
| Shell | `shfmt -i 2 -ci` + `shellcheck` | 3.8 / 0.10 | 近似，非官方 | warning | 静态二进制 |
| HTML / CSS / Markdown | `prettier` | 3.x | **无官方格式化规范**，仅一致性 | warning，默认关闭 | npm |

三条必须写进文档的判断：

1. **Go 默认关闭**：当前环境没有 Go 工具链，`gofmt` 也来自工具链本身。强行"启用"会得到 `exit 2`（工具故障），比关闭更糟。接入 Go 项目时再 `vendor` 工具链。
2. **HTML/CSS/Markdown 不算"合规"**：Google 的 HTML/CSS Style Guide 主要讲语义与可访问性，没有行宽/缩进这类机械条款。用 prettier 只能说"统一"，不能说"符合 Google 风格"。级别必须是 warning，不能阻断。
3. **`clang-tidy` 只选子集**：全量 `google-*` checks 在存量代码上误报极多，第一版只开 `readability-*` 与 `modernize-*` 中经过验证的若干条，且全部 warning。

### 6.1 规则可追溯性

`rules.map.json` 把每个引擎的规则码映射到 Style Guide 章节：

```json
{
  "eslint/@typescript-eslint/no-explicit-any": {
    "doc": "https://google.github.io/styleguide/tsguide.html#any-type",
    "level": "warning"
  },
  "clang-format/format": {
    "doc": "https://google.github.io/styleguide/cppguide.html#Formatting",
    "level": "error"
  }
}
```

这张表是本项目"按规范约束"的证据链：违规 → 规则码 → 规范章节。`doctor` 应报告未映射的规则码（规范更新或引擎升级后的人工校准入口，建议每季度一次）。

### 6.2 各语言的配置文件

判定器之间的差异不只在命令，还在**配置形态**：有的语言用一张配置文件就能完整表达规范，有的语言根本没有配置入口。混为一谈就会造出"看起来配置过"的空壳。完整模板在 `templates/`，落地方式见 §6.2.3。

| 语言 | 落地文件 | 承载内容 | 是否官方 |
|---|---|---|---|
| 通用 | `.editorconfig` | UTF-8、LF、末尾换行、缩进（Python 4 / Go tab / 其余 2） | 规范子集 |
| 通用 | `.gitattributes` | `* text=auto eol=lf`，阻止 CRLF 进入工作区 | 非官方但必需 |
| 通用 | `commitlint.config.cjs` | type/scope 白名单、header 100 列、关闭 subject-case | 官方 config-conventional |
| TS / JS | `.eslintrc.json` + `.prettierrc.cjs` + `tsconfig.json` | 规则集 + 项目接线 + 类型感知 | **是**（gts） |
| Python | `.style.yapf` + `setup.cfg` | 格式化 + import 排序 | yapf 官方 / isort 近似 |
| C++ | `.clang-format` + `.clang-tidy` | 格式化 + 命名与现代化子集 | clang-format 官方 / tidy 非官方 |
| Shell | `.shellcheckrc` | 语义检查基线（`shfmt` 参数在 CLI 里） | 否 |
| Java | **无配置文件** | `google-java-format` 内置风格 | **是** |
| Go | **无配置文件** | `gofmt` 即规范来源 | **是** |

#### 6.2.1 TypeScript 为什么必须是三个文件

gts 只提供**规则集**，不提供**项目接线**，三者缺一不可：

1. `tsconfig.json` —— 继承 `gts/tsconfig-google.json`（`strict`、`noImplicitReturns` 等）。没有它，类型感知规则无法运行。
2. `.eslintrc.json` —— `"extends": "./node_modules/gts/"`，这是 gts 唯一官方接法；加 `"root": true` 防止 monorepo 上层配置泄漏。
3. `.prettierrc.cjs` —— **最容易漏的一个**。gts 开启了 `eslint-plugin-prettier`，而 prettier 找不到配置时会退回默认值（双引号），与 Google 的单引号风格冲突，于是 `gts lint` 把合规代码报成违规。

已对 `gts@6.0.2` 的发布包核对：`engines.node >= 18`，捆绑 `eslint 8.57.1` + `prettier 3.3.3`，`extends` 目录与 `.prettierrc.json` 子路径均可解析。**不要**在该项目里混用 eslint 9 的 `eslint.config.js`：gts 读不到配置时会静默通过，是比报错更危险的失败模式。

#### 6.2.2 Java / Go 没有配置文件，不是遗漏

`google-java-format` 刻意不接受风格选项，`gofmt` 没有参数。给它们造一个配置文件只会制造"我们已经配置过规范"的错觉。这两个语言的机械约束**全部来自引擎本身**，额外文件只剩 `.editorconfig` 里的缩进项。

#### 6.2.3 位置与"最小覆盖"纪律

- 复制的目标一律是**目标仓库根目录**：所有判定器都从 cwd 向上自动发现配置，这样 IDE、CLI、CI 读到同一份，不会出现"编辑器绿、hook 红"。
- 模板刻意只覆盖必须改的项（`.style.yapf` 只固定 `column_limit`，`.clang-format` 只覆盖 6 项）。preset 随工具版本演进，覆盖越多，与规范漂移的风险越大。
- 新增 `overrides` 必须同步 `rules.map.json` 的 `doc` 字段，否则 `doctor` 报未映射规则；把规则从 error 降为 warning 必须留痕。

模板已通过语法校验：JSON / YAML / `.cjs` 均可解析，`.editorconfig` 与 `.shellcheckrc` 结构合法。语义正确性（尤其是 `.clang-tidy` 的命名规则误报率）仍需在目标代码库上实测。

---

## 7. 离线与供应链

运行时**禁止联网**。所有依赖在构建期下载、校验、随仓库分发：

```
vendor/
├── MANIFEST.sha256        # 每个文件的 sha256，doctor 负责校验
├── node/                  # npm pack 的 tarball + 本地 cache；npm ci --offline
├── python/wheels/         # pip download 产物；pip install --no-index --find-links
├── java/google-java-format.jar
└── bin/{linux-x64,darwin-arm64,windows-x64}/   # clang-format, shfmt, shellcheck, gofmt
```

`bootstrap.py --offline` 负责：校验 sha256 → 建 `.venv-tools` → 装 wheel → 解包 node 依赖 → `chmod +x` 二进制。任何一步失败都必须 `exit 2` 并说明缺什么，不能静默降级为"跳过检查"。

**体积约束**：clang-format 单平台约 60~100 MB。若超过 200 MB，改为按平台分发 + 首次联网拉取（并记录在案），不做"预装所有平台"。

**实现备注（2026-11-04）**：commitlint 的 `resolve-extends` 以「配置文件所在目录」为起点解析模块，目标仓库没有 `node_modules` 时会 `MODULE_NOT_FOUND`。包装层通过 `NODE_PATH` 指向 `vendor/node/node_modules` 解决，使目标仓库零安装即可使用离线依赖；这比在目标仓库建符号链接更干净（不会产生未跟踪文件，也不污染 `.gitignore`）。

---

## 8. Git hooks

**选定 `git config core.hooksPath .githooks`，不用 husky。**

| 方案 | 判断 |
|---|---|
| `core.hooksPath`（选定） | 零依赖、跨语言、离线、可被 `git config` 审计 |
| husky | 需要 node；多语言项目里 node 只是 commitlint 的依赖，不该成为提交门禁的前提 |
| `pre-commit`(python 框架) | 需 python 环境 + 自身配置；与自有 CLI 职责重叠 |

### 8.1 pre-commit：**只检查，不改文件**

```sh
#!/bin/sh
exec "$(git rev-parse --show-toplevel)/bin/harness-style" check --staged
```

明确决策：hook 里**不自动格式化**。自动改文件会让"我提交的内容"与"实际入库的内容"不一致，在 agent 场景下尤其危险——agent 会基于未改动的原文件继续推理。自动修复只通过显式 `harness-style fix` 触发，由 skill 指导 agent 调用。

（被否决的替代方案：lint-staged 风格的 fix + re-add。见 §11。）

### 8.2 commit-msg

```sh
#!/bin/sh
exec "$(git rev-parse --show-toplevel)/bin/harness-style" commit-msg "$1"
```

必须处理的边界：

- **merge commit**：跳过校验（commitlint 默认行为，需在包装层显式确认）。
- **revert**：`Revert "..."` 放行。
- **fixup!/squash!**：仅在 rebase 进行中（存在 `.git/rebase-merge` 或 `.git/rebase-apply`）放行。
- **空 message / 纯注释**：拒绝。
- **中文 body**：允许；但必须关闭 `subject-case`，否则英文缩写（`API`、`HTTP`）会被误判。

### 8.3 commitlint 配置要点

完整文件见 `templates/root/commitlint.config.cjs`，这里只记录为什么这样定：

| 规则 | 取值 | 理由 |
|---|---|---|
| `extends` | `@commitlint/config-conventional` | 不自己发明一套 type 语义 |
| `type-enum` | build/chore/ci/docs/feat/fix/perf/refactor/revert/style/test | 与 CHANGELOG 分组一一对应 |
| `scope-enum` | 模块白名单 | 强制 scope 有意义 |
| `subject-case` | **关闭** | 中文无大小写；`API`/`HTTP` 会被误杀 |
| `header-max-length` | 100 | 与 Google 的 80 列无关，提交标题按 git 惯例放宽 |
| `body-max-line-length` | 100（warning） | 中文正文按字符计，过窄会频繁误报 |

合并、回滚、`fixup!` 的豁免**不写在配置里**：配置无法知道"当前是否在 rebase"，由包装层根据 `.git/rebase-merge` 判断，避免把所有 `fixup!` 永久放行。

`scope-enum` 是最容易腐化的一项：新增模块必须同步更新，否则 agent 会挑一个"能过"的 scope。应由 `harness-style doctor` 检查配置与目录结构的一致性。

### 8.4 绕过与第二道门

hook 可以被 `--no-verify` 绕过，也可以被直接改 `.githooks/`。所以：

- **CI 必须再跑一次** `harness-style check --range origin/main..HEAD` 和 commit-msg 校验（对 `git log` 的每个 message）。
- `doctor` 检查 `.githooks` 文件 sha256 是否被篡改。
- AGENTS.md 明令禁止 `--no-verify`；skill 中重复一次。

---

## 9. Agent 侧：skill 与 AGENTS.md

### 9.1 skill 的边界

skill **只写**以下五类内容，不重复规则本身（规则在配置文件与引擎里）：

1. 触发时机：改完代码、`git commit` 之前。
2. 命令选择表：改了哪种文件 → 跑哪条命令。
3. 修复循环：先 `fix`，再 `check`；`fixable:false` 的项不硬改，转为待办。
4. 不可机械化的 checklist（命名、文档、错误处理）——这是 skill 唯一"规则性"的内容，因为工具做不到。
5. 证据要求：必须贴出 `exit code` 或 JSON 的 `summary`，"我检查过了"不算证据。

预估 60~100 行。超过 150 行说明规则泄漏进了 skill。

### 9.2 AGENTS.md 硬约束段（草案）

```md
## 代码规范（强制）

- 任何代码改动在 `git commit` 前必须使 `bin/harness-style check --staged` 返回 0。
- 不得使用 `git commit --no-verify` 绕过 hook；不得修改 `.githooks/`。
- 提交信息必须符合 Conventional Commits，且通过 `bin/harness-style commit-msg <file>`。
- 无法自动修复的违规，在提交信息 body 或 PR 描述中逐条列出，不得静默忽略。
- 汇报完成时必须附上检查命令与退出码，不得只写"已遵守规范"。
```

### 9.3 防止 agent 陷入修复循环

这是实践中最高频的失败模式：一条不可修复的 lint 让 agent 反复改同一文件。

机制：

- `check` 输出区分 `fixable: true/false`。
- skill 规定：同一文件 `fix` 超过 **2 轮**仍失败 → 停止，把违规原样上报，不再自行发挥。
- `warning` 级别不阻断提交，只进报告。

---

## 10. 实施路线

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| P0 | CLI 骨架 + 1 个引擎（TS/gts 或 Python/yapf）+ 该语言的 `templates/` + JSON 输出 | 故意写不合规代码，`check` 退出 1 且 JSON 可解析 |
| P1 | `install-hooks` + commit-msg + commitlint 包装 | `git commit -m "update"` 被阻断，退出码 1；`exit 2` 场景（拔掉 vendor）可复现 |
| P2 | 其余引擎接入（Java / C++ / Shell）+ 对应 `templates/` | 每种语言各有一个"故意违规"用例；`doctor` 全绿 |
| P3 | baseline + CI 第二道门 + skill + AGENTS.md | 老仓库接入后首次提交仅报增量；agent 在无提示下能自行跑通流程 |
| P4 | 指标与校准 | 统计首次通过率、平均修复轮次、误报率、绕过次数 |

**不要一次性上全部语言**：多语言同时接入会得到一个"处处 exit 2、没人知道哪里坏了"的系统。P0 先打通一条端到端链路，价值高于覆盖面。

### 10.1 指标

- 首次 `check` 通过率（目标 > 70%，过低说明规则过严或 agent 没看到 skill）
- 平均修复轮次（目标 < 2）
- 误报率（人工判定为"其实合规"的比例，> 5% 需降级该规则）
- 绕过次数（CI 捕获的 `--no-verify` 提交，目标 0）

---

## 11. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 纯 skill（提示词约束） | 无 exit code、无法挂 hook/CI、检出率随模型漂移、不可审计 |
| 纯 AGENTS.md 声明 | 同上，且上下文压缩后规则最先丢失 |
| 自写正则/规则引擎检查风格 | Style Guide 是自然语言文档，重写等于重新发明 clang-format，且必然滞后于规范更新 |
| husky + lint-staged（fix + re-add） | 引入 node 依赖；hook 中静默改文件，在 agent 场景下会破坏其推理依据 |
| 全仓一次性格式化 | 污染 git blame、与在途分支冲突；且无法证明"新代码合规" |
| 用 LLM 做规范判定 | 不确定、不可复现、成本高；只适合做 §9.1 第 4 项的 checklist 自查 |
| 只做 CI 不做本地 hook | 反馈太晚，agent 已经基于错误代码完成了后续工作 |

---

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 引擎版本与 Style Guide 漂移 | 规则过时或误报 | `rules.map.json` + 季度校准；`doctor` 报未映射规则 |
| 规则过严导致 agent 反复修复 | 任务失败、token 浪费 | fixable 分级 + 2 轮上限 + warning 不阻断 |
| 二进制体积（clang-format） | 仓库膨胀 | 分平台分发；200 MB 阈值 |
| Windows 支持 | hook 是 sh 脚本 | 依赖 Git for Windows 自带 sh；CI 加 windows 矩阵后再定 |
| Go 工具链缺失 | 该语言无法启用 | 默认关闭，接入时再 vendor |
| commitlint 依赖 node | 无 node 环境不可用 | 明确列为运行时前置条件；不自行实现 CC 解析器 |
| agent 篡改 hook | 门禁失效 | doctor 校验 sha256 + CI 二次校验 |

---

## 13. 待定问题（评审时需要结论）

1. 目标环境是否保证有 `python3`（>=3.8）与 `node`（>=18）？若不能保证，P0 的编排器选型要重开。
2. 是否需要 Windows 一等支持（决定二进制矩阵规模）。
3. 是否已有 CI？"第二道门"落在哪个流水线。
4. clang-tidy 子集的具体清单由谁定（需要 C++ owner 参与）。
5. 是否接受把 `vendor/` 提交进仓库（体积 vs 可复现），还是走内部制品库 + 校验和。

---

## 14. 一句话总结

**工具是判定者，skill 是说明书，AGENTS.md 是契约，hook 是不易绕过的执行点，CI 是最后一道门。** 四者缺一，这套东西就会退化成"写在文档里的规范"。
