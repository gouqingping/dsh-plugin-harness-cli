# dsh-plugin.org 收录自查

> 对照 <https://dsh-plugin.org/zh/submit> 的收录要求，检查本仓库是否满足。
> 这个文件同时是提交 Issue 的模板来源；本地项会被 `plugin/tests/listing.test.js` 自动断言。

## 一、本地可验证项（自动检查）

`node --test` 会跑 `listing.test.js`，覆盖：

| 要求 | 检查方式 |
|---|---|
| 仓库根目录有 `package.json`（包名 + 版本） | 读取根 `package.json`，校验 `name` / `version` |
| 插件导出 `apply(ctx)` | 动态 `import` 根 `main`（`plugin/cordis.mjs`），断言 `apply` 是函数、`inject` 是数组 |
| `dsh plugin add` 后能自动合入 profile | 根 `package.json` 声明 `dsh.bundle.patch`，且 `cordis.patch.yml` 有 `insert` 条目 |
| README 含安装命令 | 匹配 `dsh plugin --profile <name> add <包名>` 与 `github:OWNER/<repo>` |
| README 写清一句话价值 / 兼容 / 权限 | 关键词断言 |
| 许可证 | 根 `package.json` 的 `license` + 仓库根 `LICENSE` |
| CLI 入口存在 | `plugin/bin/dsh-plugin-harness-cli.js` |

跑完 `node --test` 即完成本地自查。

## 二、远端状态

| 项 | 状态 | 说明 |
|---|---|---|
| GitHub 公开仓库 | ✅ | <https://github.com/gouqingping/dsh-plugin-harness-cli>（`origin`；master 与远端一致） |
| GitHub topic `dsh-plugin` | ✅ | 另加 `deepseek-harness` / `harness-engineering` / `agents-md` |
| 根 `package.json` | ✅ | 包名 / 版本 / license / `repository` 指向本仓库 / `dsh.bundle.patch` |
| 安装验证 | ✅ | DSH 0.2.2-rc.1：`dsh plugin --profile markettest add dsh-plugin-harness-cli` 装上 `0.1.0`，profile 的 `dsh.profile.bundles` 自动追加本包，`dsh --profile markettest --dump-config` 出现 `- id: harness-cli` 行，装完 11 个 `harness_cli_*` 工具随即注册进运行中的 DSH |
| 收录 Issue | ✅ | <https://github.com/dshplugin/dsh-plugin-hub/issues/661>（已补评论把安装命令升级成 npm 一键安装） |
| NPM 发布 | ✅ | [`dsh-plugin-harness-cli@0.1.0`](https://www.npmjs.com/package/dsh-plugin-harness-cli)，`dist-tags.latest` 指向 0.1.0 |

> 发布时踩到的两个 npm 现状（下次发版照做即可）：
> - 带 bypass-2FA 的 granular token 已经**不能**直接发布/暂存（`403 You may not perform that action with these credentials`）。
>   必须在交互终端里 `npm publish`，走 web auth 完成 2FA；发布是异步的，`PUT 202` 之后要等 2–3 分钟才在 registry 出现。
> - 处理期间 registry 会生成 `0.0.0-stage` 占位 stub（`"stub": true`，2 个文件）。它是正常现象，完成后 `latest` 会自动指回真实版本；想去掉可以 `npm unpublish dsh-plugin-harness-cli@0.0.0-stage`。

## 三、提交 Issue 模板（可直接复制）

> 真正的模板源是 hub 的 Issue Form：<https://github.com/dshplugin/dsh-plugin-hub/blob/main/.github/ISSUE_TEMPLATE/plugin_submission.yml>
> （字段名以它为准，下面按同样的英文小节填）。

**标题**

```
[插件提交] gouqingping/dsh-plugin-harness-cli — 把项目协作规范变成可生成、可校验的文件，模型直接调用
```

**正文**

```md
### Repository

https://github.com/gouqingping/dsh-plugin-harness-cli

### One-line value

Installing it gives DSH 11 `harness_cli_*` tools and 10 `/harness-cli-*` commands that generate and check a repo's Harness setup (AGENTS.md, env/scope/state/gate files, spec docs, task progress, antd-style UI specs, business wiki), so the model follows one shared spec instead of improvising.

### Category

Development & Operations (dev)

### Install command

dsh plugin --profile web add github:gouqingping/dsh-plugin-harness-cli

### npm package

none (not published yet; the name `dsh-plugin-harness-cli` is reserved for an upcoming publish, and `repository` in package.json already points at this repo so the entry can bind to the npm package once it exists)

### License

CC0-1.0

### Notes

- `dsh-plugin` topic: ✅
- `dsh.bundle` in package.json: ✅ (`cordis.patch.yml` at repo root; `main` exports `apply(ctx)` and `inject: ['tools']`)
- `repository` in package.json: `git+https://github.com/gouqingping/dsh-plugin-harness-cli.git` ✅
- `engines.node`: `>=18`, zero runtime dependencies, works offline; only the `style` subcommand needs a local `python3` (3.8+)
- Install verified on DSH 0.2.2-rc.1 (macOS arm64): after `dsh plugin --profile markettest add <repo>`, the profile's `dsh.profile.bundles` gained the package and `dsh --profile markettest --dump-config` contains `- id: harness-cli`
- Not an official plugin; no affiliation with DeepSeek AI. Reads/writes only the target repo; no network calls, no telemetry; `plans --serve` binds `127.0.0.1` only.

### Self-check

- [x] The repository has the dsh-plugin topic.
- [x] The install command succeeds locally and the DSH version requirement is met.
- [x] repository in package.json matches this owner/repo.
```

## 四、发布 NPM（已发布 0.1.0，发新版本的步骤）

```sh
npm login              # 必须交互式登录：bypass-2FA token 已不能直接发布
npm pack --dry-run     # 先看内容：2542 个文件、约 12.8 MB tar / 42 MB 解包
npm publish            # 会打开 web auth 完成 2FA；PUT 202 后等 2–3 分钟才出现在 registry
```

`dist-tags.latest` 确认：

```sh
npm view dsh-plugin-harness-cli dist-tags   # { latest: '0.1.0' }
```

注意：`files` 里带 `plugin/vendor`（约 48 MB，含离线 yapf/isort/commitlint），发布包会比较大，
但换来「装完即可离线跑 `style`」。不想带可以删掉 `files` 里的 `plugin/vendor`，`style` 会退化为不可用。

## 五、徽章

README 顶部已放徽章，owner 已填 `gouqingping`；**被收录后**链接才会 200：

```md
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/gouqingping/dsh-plugin-harness-cli)
```
