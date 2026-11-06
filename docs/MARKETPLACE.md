# dsh-plugin.org 收录自查

> 对照 <https://dsh-plugin.org/zh/submit> 的收录要求，检查本仓库是否满足。
> 这个文件同时是提交 Issue 的模板来源；本地项会被 `plugin/tests/listing.test.js` 自动断言。

## 一、本地可验证项（自动检查）

`node --test plugin/tests/` 会跑 `listing.test.js`，覆盖：

| 要求 | 检查方式 |
|---|---|
| 仓库根目录有 `package.json`（包名 + 版本） | 读取根 `package.json`，校验 `name` / `version` |
| 插件导出 `apply(ctx)` | 动态 `import` 根 `main`（`plugin/cordis.mjs`），断言 `apply` 是函数、`inject` 是数组 |
| `dsh plugin add` 后能自动合入 profile | 根 `package.json` 声明 `dsh.bundle.patch`，且 `cordis.patch.yml` 有 `insert` 条目 |
| README 含安装命令 | 匹配 `dsh plugin --profile <name> add <包名>` 与 `github:OWNER/<repo>` |
| README 写清一句话价值 / 兼容 / 权限 | 关键词断言 |
| 许可证 | 根 `package.json` 的 `license` + 仓库根 `LICENSE` |
| CLI 入口存在 | `plugin/bin/dsh-plugin-harness-cli.js` |

跑完 `node --test plugin/tests/` 即完成本地自查。

## 二、远端状态

| 项 | 状态 | 说明 |
|---|---|---|
| GitHub 公开仓库 | ✅ | <https://github.com/gouqingping/dsh-plugin-harness-cli>（`origin`；master 与远端一致） |
| GitHub topic `dsh-plugin` | ✅ | 另加 `deepseek-harness` / `harness-engineering` / `agents-md` |
| 根 `package.json` | ✅ | 包名 / 版本 / license / `repository` 指向本仓库 / `dsh.bundle.patch` |
| 安装验证 | ✅ | DSH 0.2.2-rc.1：`dsh plugin --profile markettest add <仓库路径>` 成功后 profile 的 `dsh.profile.bundles` 自动追加本包，`dsh --profile markettest --dump-config` 出现 `- id: harness-cli` 行 |
| 收录 Issue | ✅ | <https://github.com/dshplugin/dsh-plugin-hub/issues/661> |
| NPM 发布 | ⬜ | 未发布。发布后站点会把条目升级成 npm 一键安装，并进入 DSH「插件中心」 |

> NPM 侧未登录：`~/.npmrc` 里 `registry.npmjs.org` 的 token 已失效（`npm whoami` → 401）。
> 本机先 `npm login` 再 `npm publish`（包约 12.8 MB / 解包 42 MB，主要是 `plugin/vendor`）。
> 包名 `dsh-plugin-harness-cli` 在 npm 上仍可用；`repository` 已指向本仓库，
> 发布后 dsh-plugin.org 会把 NPM 包绑到已有条目上，无需重复提交。

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

## 四、发布 NPM（想让插件进「插件中心」才需要）

```sh
npm login              # 当前 ~/.npmrc 里的 npmjs token 已失效，必须重新登录
npm publish            # 包名：dsh-plugin-harness-cli；scope 包需 npm publish --access public
```

发布前想先看内容：`npm pack --dry-run`（本包 2542 个文件、约 12.8 MB tar / 42 MB 解包）。

注意：`files` 里带 `plugin/vendor`（约 48 MB，含离线 yapf/isort/commitlint），发布包会比较大，
但换来「装完即可离线跑 `style`」。不想带可以删掉 `files` 里的 `plugin/vendor`，`style` 会退化为不可用。

## 五、徽章

README 顶部已放徽章，owner 已填 `gouqingping`；**被收录后**链接才会 200：

```md
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/gouqingping/dsh-plugin-harness-cli)
```
