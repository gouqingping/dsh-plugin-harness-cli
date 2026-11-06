# templates/ —— 风格配置模板

目标仓库**不共享**这些配置的运行时副本；`harness-style init --lang <...>` 会按语言
把对应文件复制到目标仓库**根目录**。放在根目录是因为所有判定器都从 cwd 向上自动发现配置，
这样 IDE、CLI、CI 读到的是同一份，不会出现"编辑器绿、hook 红"。

## 1. 文件清单

| 语言 | 判定器 | 落地文件 | 是否官方实现 |
|---|---|---|---|
| 通用 | EditorConfig | `root/.editorconfig` | 规范要求的子集，非官方工具 |
| 通用 | git | `root/.gitattributes` | 保证 LF 落地 |
| 通用 | commitlint | `root/commitlint.config.cjs` | 官方 `@commitlint/config-conventional` |
| TypeScript / JS | gts 6.0.2（内含 eslint 8.57 + prettier 3.3） | `typescript/.eslintrc.json`、`.prettierrc.cjs`、`tsconfig.json` | **是**，Google 维护 |
| Python | yapf（`--style=google`） | `python/.style.yapf` | **是**，Google 维护 |
| Python | isort | `python/setup.cfg` | 否，`profile = google` 为近似 |
| Java | google-java-format | **无配置文件**（用 `root/.editorconfig` 的缩进项即可） | **是** |
| C++ | clang-format | `cpp/.clang-format` | **是**，`BasedOnStyle: Google` |
| C++ | clang-tidy | `cpp/.clang-tidy` | 否，规则子集需 owner 确认 |
| Shell | shfmt | **无配置文件**（适配器固定 `-i 2 -ci`） | 否 |
| Shell | shellcheck | `shell/.shellcheckrc` | 否 |
| Go | gofmt / goimports | **无配置文件** | **是**（gofmt 即规范来源） |
| HTML / CSS / MD | prettier | 复用 `typescript/.prettierrc.cjs` | 否，**仅一致性，不算合规** |

Java 与 Go 没有配置文件不是遗漏：`google-java-format` 刻意不接受风格选项，`gofmt` 没有参数。
给它们造一个"配置文件"只会制造"我们配置过规范"的错觉。

## 2. TypeScript 为什么需要三个文件

gts 只提供**规则集**，不提供**项目接线**：

- `tsconfig.json` —— 继承 `gts/tsconfig-google.json`（`strict: true`、`noImplicitReturns` 等），
  没有它，`@typescript-eslint` 的类型感知规则无法工作。
- `.eslintrc.json` —— `extends: "./node_modules/gts/"`，这是 gts 的唯一官方接法。
  `root: true` 防止 monorepo 上层配置泄漏。
- `.prettierrc.cjs` —— **最容易漏的一个**。gts 开启了 `eslint-plugin-prettier`，
  而 prettier 找不到配置时会退回默认值（双引号），与 Google 的单引号风格冲突，
  于是 `gts lint` 会把正确代码报成违规。

配套的 `package.json` 片段（版本必须与 vendor 中锁定的版本一致）：

```json
{
  "scripts": {
    "lint": "gts lint",
    "fix": "gts fix",
    "compile": "tsc"
  },
  "devDependencies": {
    "gts": "6.0.2",
    "typescript": "5.4.5"
  }
}
```

> gts 6 的 `engines.node >= 18`，且依赖 eslint 8。eslint 9 的 flat config 目前不被 gts 支持，
> 不要混用 `eslint.config.js`，否则 `gts lint` 会读不到配置而静默通过 —— 这是最危险的一种失败。

## 3. 改规则的纪律

1. **不要随手加 `overrides`**。每加一条，都要在 `rules.map.json` 里补 `doc`（规范章节链接），
   否则 `doctor` 会报"未映射规则"。
2. **不要覆盖 preset 已经正确的项**。例如 `.style.yapf` 只固定 `column_limit`，
   缩进/续行交给 `google` preset；`.clang-format` 同理只覆盖 5 项。
   preset 随工具版本演进，覆盖越多越容易与规范漂移。
3. **降级要留痕**。把某条规则从 error 降为 warning，必须写进 ADR 或 CHANGELOG，
   否则半年后没人知道为什么这条不拦了。

## 4. 已知的规范盲区（配置文件解决不了）

| 条款 | 为什么工具管不了 |
|---|---|
| 命名词性（`data` vs `payload`） | 需要语义理解 |
| 注释/文档该写什么 | 只能检查"有没有"，不能检查"对不对" |
| 错误处理策略、异常边界 | 设计问题 |
| C++ 指针所有权、`const` 正确性 | 部分可由 clang-tidy 覆盖，其余靠评审 |
| TS 类型设计（`any` 之外） | 需要领域知识 |

这些走 skill 里的提交前 checklist（ADR §9.1 第 4 项），不要试图用正则补。
