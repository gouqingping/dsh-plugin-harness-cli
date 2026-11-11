# dsh-plugin-harness-cli 安装包

公共项目配置工具（DeepSeek Harness 插件包）：按 Harness 规范为任意仓库生成并校验
`AGENTS.md`、四件套（环境 / 范围 / 状态 / 门禁）、CI 骨架与业务白话版本说明。

本包可迁移 / 备份 / 分享到 DSH（Seadun）或 Codex，支持 **Windows / macOS / Linux**。

## 包内容

- `plugin/` 插件本体（`package.json` + `bin/` + `src/` + `templates/` + `tests/`）
- `plugin/cordis.mjs` DSH 适配层；`plugin/codex-mcp.mjs` Codex 本地 MCP 适配层
- `plugin/vendor/agent-style-harness/` 随包的 `harness-style`（Python，含 yapf / isort / commitlint 离线依赖，约 48 MB）
- `.codex-plugin/`、`.mcp.json`、`skills/`、`.agents/plugins/marketplace.json` Codex 插件清单、技能与市场索引
- `install.ps1` 一键安装脚本（Windows 必用；macOS / Linux 装了 `pwsh` 也能用）
- `install.sh` 一键安装脚本（macOS / Linux，无需 PowerShell）
- `README-INSTALL.md` 本说明

## 安装（Codex）

Codex 0.144.x 及支持插件市场 / 本地 MCP 的版本：

```sh
codex plugin marketplace add gouqingping/dsh-plugin-harness-cli
codex plugin add dsh-plugin-harness-cli@dsh-plugin-harness-cli
codex plugin list
codex mcp list
```

本地开发或离线包可直接把解压目录加为市场：

```sh
codex plugin marketplace add /absolute/path/to/dsh-plugin-harness-cli
codex plugin add dsh-plugin-harness-cli@dsh-plugin-harness-cli
```

新开会话后可使用 `$harness-cli` 技能，模型会通过本地 stdio MCP 调用同一批 `harness_cli_*` 工具。
Codex 侧必须给每个工具传目标仓库的绝对 `root`；覆盖、方案确认和删除要先取得你的明确同意。

## 安装（DSH 目标机器）

### 方式一：一键脚本（推荐）

1. 解压本包到任意目录
2. 按系统执行：

   **Windows（PowerShell）**
   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```

   **macOS / Linux（bash）**
   ```sh
   bash install.sh
   ```

   **macOS / Linux（PowerShell 7）**
   ```sh
   pwsh ./install.ps1
   ```

3. 脚本会打印 harness 路径与注册结果；完全退出并重启 Seadun 应用。

非默认安装位置时显式指定：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -HarnessRoot "D:\path\to\runtime\harness"
```

```sh
DSH_HARNESS_ROOT=/path/to/runtime/harness bash install.sh
```

### 方式二：手动安装

1. 复制 `plugin` 目录到 harness：
   `<Seadun>\versions\<版本>\runtime\harness\node_modules\@deepseek-ai\dsh-plugin-harness-cli`
   （macOS：`~/Library/Application Support/Seadun/...`；Linux：`~/.config/Seadun/...`）
2. 创建链接（profiles 模块扫描需要）：
   - Windows（管理员 PowerShell）：`cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh-plugin-harness-cli" "<harness>\node_modules\@deepseek-ai\dsh-plugin-harness-cli"`
   - macOS / Linux：`ln -sfn "<harness>/node_modules/@deepseek-ai/dsh-plugin-harness-cli" "$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh-plugin-harness-cli"`
3. 编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加：
   ```yaml
   - insert:
       - id: harness-cli
         name: '@deepseek-ai/dsh-plugin-harness-cli'
   ```
4. 重启 Seadun

## 装完怎么用

插件本身是命令行工具，装好后在**任意项目目录**里用（把 `<harness>` 换成本机路径）：

```sh
node <harness>/node_modules/@deepseek-ai/dsh-plugin-harness-cli/bin/dsh-plugin-harness-cli.js init --preset prototype
node <harness>/node_modules/@deepseek-ai/dsh-plugin-harness-cli/bin/dsh-plugin-harness-cli.js check
node <harness>/node_modules/@deepseek-ai/dsh-plugin-harness-cli/bin/dsh-plugin-harness-cli.js ui login-flow   # antd 风格 UI 设计稿
node <harness>/node_modules/@deepseek-ai/dsh-plugin-harness-cli/bin/dsh-plugin-harness-cli.js wiki            # 生成/更新 docs/wiki
```

`init` 给目标项目生成 `AGENTS.md`、`init.sh`、`scripts/gate.sh`、`harness-cli.json` 等；
`check` 只读校验，退出码 `0` 通过 / `1` 有违规 / `2` 工具坏了。

代码风格与提交信息走随包的 `harness-style`（Python），参数原样透传：

```sh
P=<harness>/node_modules/@deepseek-ai/dsh-plugin-harness-cli/bin/dsh-plugin-harness-cli.js
node "$P" style doctor                 # 依赖与配置自检
node "$P" style init --lang py,ts      # 给项目接入风格配置 + git hooks
node "$P" style check --staged         # 0 通过 / 1 有违规 / 2 工具坏
node "$P" style commit-msg <msg-file>
```

⚠ `style` 子命令需要目标机器有 **python3**（3.8+）。没有时其余命令照常可用，
`doctor` 会给出警告。

## 卸载

### Codex

```sh
codex plugin remove dsh-plugin-harness-cli@dsh-plugin-harness-cli
codex plugin marketplace remove dsh-plugin-harness-cli
```

### DSH

1. 从 `~/.dsh/profiles/web/cordis.patch.yml` 删除 `harness-cli` 条目
2. 删除 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-plugin-harness-cli`（链接）
3. 删除 harness `node_modules` 下的 `dsh-plugin-harness-cli` 目录
4. 重启 Seadun

## 注意事项

- 安装脚本会**备份** `cordis.patch.yml`（备份名 `cordis.patch.yml.bak-<时间戳>`），
  并用 `# >>> dsh-plugin-harness-cli >>>` … `# <<< dsh-plugin-harness-cli <<<` 标记块维护自己的注册，
  重复安装只替换标记块，不会产生重复条目。
- 若该 id 已被 DSH 内置（bundle 层已注册），脚本只更新插件文件，不再写 `cordis.patch.yml`。
- 根包 `main` 是 DSH 的 `apply(ctx)` 入口；Codex 则通过 `.mcp.json` 启动独立的
  `plugin/codex-mcp.mjs`，两条适配层共用 `src/` 与 `templates/`。
- 如果 DSH 重启后启动日志报插件加载失败，用 `-SkipCordis`（Windows）/
  `SKIP_CORDIS=1`（macOS / Linux）跳过注册步骤即可，命令行工具本身不受影响。
- 插件运行期不写任何全局状态；生成物全部落在**目标项目仓库**里。
- 依赖由目标 DSH 提供；主工具零运行时依赖，`node >= 18` 即可；
  仅 `style` 子命令额外需要 `python3`（3.8+），其 Python/Node 依赖已随包携带，无需联网安装。
- 包体积主要来自 `plugin/vendor/agent-style-harness/vendor/`（yapf、isort、commitlint），约 48 MB；
  复制/安装比一般插件慢几秒属正常。
