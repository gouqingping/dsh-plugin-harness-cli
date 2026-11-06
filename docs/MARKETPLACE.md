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

## 二、需要在 GitHub / NPM 侧完成的远端项

> 当前 `origin` 是 Gitee（`gitee.com/qingping/dsh-plugin-harness-cli`），而 dsh-plugin.org 只扫描 GitHub。
> 需要把仓库**镜像/推送到 GitHub**（例如 `github.com/qingping/dsh-plugin-harness-cli`），
> 再在 GitHub 仓库的 Settings → Topics 添加 `dsh-plugin`。

- [ ] 仓库已推送到 GitHub 并设为 public
- [ ] 已在 GitHub 仓库 Topics 添加 **`dsh-plugin`**
- [ ] （可选）已发布 NPM 包 `dsh-plugin-harness-cli`：只有发到 npm 才会出现在 DSH「插件中心」；
      不发布也能被收录，安装命令用源码方式
- [ ] 提交 Issue（或用自动扫描等下一轮刷新）

## 三、提交 Issue 模板（可直接复制）

**标题**

```
[插件提交] qingping/dsh-plugin-harness-cli — 把项目协作规范变成可生成、可校验的文件，模型直接调用
```

**正文**

```md
### 仓库地址
https://github.com/gouqingping/dsh-plugin-harness-cli

### 一句话价值
安装后 DSH 里多出 11 个 harness_cli_* 工具与 10 条 /harness-cli-* 命令：一条命令生成项目骨架、补全 docs/specs、生成 antd UI 设计稿、推进任务进度并跑门禁，让模型按同一套 Harness 规范干活。

### 能力分类
开发与运维

### 安装命令
dsh plugin --profile web add dsh-plugin-harness-cli

（仅源码安装：dsh plugin --profile web add github:qingping/dsh-plugin-harness-cli）

### 兼容与运行要求
DSH 0.1.5 系列（host 协议 3），profile 支持 web / desktop；Node.js >= 18；零运行时依赖、离线可用；
style 子命令需要本机 python3；plans --serve 仅监听 127.0.0.1（可选）。

### 许可证
CC0-1.0

### 截图 / 演示
README「真实输出（演示）」一节有 init / plan / check 的真实命令行输出。

### 补充说明
- 只读写目标仓库内文件，不联网、不收集数据。
- 安装后由 dsh.bundle.patch 自动合入 profile；卸载 dsh plugin remove 即可移除整包。
- 不是官方插件，与 DeepSeek AI 无隶属关系。

### 提交前自查
- [x] 仓库已公开
- [x] 已添加 GitHub topic：dsh-plugin
- [x] README 包含安装命令
- [x] 插件导出 apply(ctx) 模块
- [x] 仓库根目录包含 package.json
```

## 四、发布 NPM（可选，想让插件进「插件中心」才需要）

```sh
npm publish            # 包名：dsh-plugin-harness-cli
# 已登录 npm；scope 包需 npm publish --access public
```

注意：`files` 里带 `plugin/vendor`（约 48 MB，含离线 yapf/isort/commitlint），发布包会比较大，
但换来「装完即可离线跑 `style`」。不想带可以删掉 `files` 里的 `plugin/vendor`，`style` 会退化为不可用。

## 五、徽章

被收录后把 `your-owner` 换成详情页里的 owner：

```md
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/your-owner/dsh-plugin-harness-cli)
```
