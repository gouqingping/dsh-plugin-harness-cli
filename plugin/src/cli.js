'use strict';

/**
 * CLI：参数解析 + 输出 + 退出码。
 *
 * 退出码（与 harness-style 对齐）：
 *   0 通过 / 1 有违规或前置条件不满足 / 2 工具或用法有错
 */

const path = require('path');
const fs = require('fs');
const {spawnSync} = require('child_process');
const crypto = require('crypto');
const {loadConfig, validateConfig, PRESET_NAMES, CONFIG_FILE, resolveConfigFile} = require('./config');
const {buildContext} = require('./context');
const {buildPlan, applyPlan} = require('./scaffold');
const {runChecks} = require('./check');
const {generate, renderAgents, lineVerdict} = require('./agents');
const {runDoctor} = require('./doctor');
const style = require('./style');
const {applyWiki, planWiki, wikiStatus, collectFacts, wikiGaps, writeGapReport, DEFAULT_DIR: WIKI_DIR} = require('./wiki');
const {syncDesignFromUi, syncProposalFromWiki} = require('./sync');
const {uiGaps, writeUiGapReport} = require('./ui');
const {
  collectUxFacts,
  writeUxReports,
  applyUxContext,
  resolveUxGaps,
  saveUxRequirements,
} = require('./ux');
const {
  parseSchema,
  lintModel,
  renderMermaid,
  renderErPage,
  loadOverall,
  renderOverviewPage,
  syncDatabaseDoc,
} = require('./db');
const {
  refreshPlans,
  collectTasks,
  servePlans,
  deleteTask,
  refreshDerived,
  updateTaskQueue,
  readTaskMode,
} = require('./plans');
const {defaultModel, mergeFlags, renderDocs, applyToPage, applyToPlan} = require('./specs');
const {loadTemplate} = require('./templates');
const {PROCESS_TEXT, isProcessTopic} = require('./process');
const {render} = require('./render');
const {exists, isDir, isText, isTaskName, writeFileSafe, toPosix, today} = require('./util');

const VERSION = require('../package.json').version;

const USAGE = `dsh-plugin-harness-cli ${VERSION} —— 公共项目配置工具（Harness 规范）

用法：
  dsh-plugin-harness-cli init [--preset prototype] [--force] [--force-state] [--dry-run]
  dsh-plugin-harness-cli agents [--stdout] [--force] [--dry-run]
  dsh-plugin-harness-cli page <任务名> [--user-words "原话"]   # DSH 侧会追问 UX / 数模 / UI
  dsh-plugin-harness-cli review [任务名] [--agent <标识>]        # 复盘 docs/specs 与任务页（省略任务名=最近的任务）
  dsh-plugin-harness-cli plan [任务名] [--confirm --by "确认人"] [--user-words "原话"]  # 只写 docs/specs；未开工时补齐页面骨架
  dsh-plugin-harness-cli progress <任务名> [--step N --pct 0..100] [--status 进行中|待验收|完成] [--note "说明"]
  dsh-plugin-harness-cli ui [任务名] [--user-words "原话"] [--force]   （省略任务名=最近的任务）
  dsh-plugin-harness-cli sql [任务名] [--dry-run]                   # 按 Google 数模规范生成 / 校验 schema 与 ER 数模图
  dsh-plugin-harness-cli delete <任务名> [<任务名>...] [--yes]        # 删除任务页 / 设计稿 / 数据模型 / 规范文档 / 复盘
  dsh-plugin-harness-cli check [--strict] [--json]
  dsh-plugin-harness-cli doctor [--json]
  dsh-plugin-harness-cli plans [serve [端口] | stop]   # 省略端口=随机安全端口；指定端口被占用会强制接管
  dsh-plugin-harness-cli wiki [--merge|--update|--keep] [--check] [--dry-run] [--json]
  dsh-plugin-harness-cli ux [任务名...] [--user-words "自定义需求"] [--resolve <编号...>] [--by "确认人"] [--apply] [--dry-run] [--json]
  dsh-plugin-harness-cli style <harness-style 参数...>
  dsh-plugin-harness-cli version | help [process]   # help process 查看完整任务流程（别名：flow / workflow / 流程）

style 子命令把参数原样转给随包的 harness-style（代码风格 / 提交信息判定）：
  style doctor | style check --staged | style fix --staged | style commit-msg <file>
  style init --lang py,ts | style install-hooks

ui 生成 / 更新任务页的 UI 设计稿（Ant Design v5 风格，落在 prototype/<task>/ui/）：
  --force       覆盖已存在的设计稿（默认不覆盖）
  --dry-run     只打印将写入的文件

sql 数据库设计（schema.sql 是唯一真源，省略任务名=最近的任务）：
  docs/specs/<task>/schema.sql     DDL（不覆盖已有内容）
  docs/specs/<task>/database.md    建模说明与 Google 数模规范（不覆盖已有内容）
  docs/specs/<task>/er.mmd         Mermaid ER 图（自动生成）
  prototype/<task>/db/index.html   离线数模图（自动生成）
  退出码 1 表示 schema 还是空的，或有 lint 错误；按提示补 schema.sql 后重跑。

wiki 生成 / 更新 docs/wiki（13 篇业务文档，正文是业务白话，不写命令与代码）：
  默认（--merge）增量合并：人工段落保留，事实（数量 / 状态 / 清单）按本次扫描刷新；
                没有受管区块的既有文档会补区块、原文原样保留
  --update      受管区块整块重写（回到生成器基线，人工段落会被覆盖）
  --keep        只创建缺失文件，已有文件一个字都不动
  --check       只报告：缺失 / 过期 / 待接管 / 标记损坏，不写盘
  业务内容从 docs/specs 的提案 / 契约 / 设计、docs/adr 反推，推不出的才写「待业务确认」
  业务域下钻页只在配置的 dirs 里声明了 name（业务名）时生成，不拿目录名当业务域

ux 用户体验与需求分析（整体报告永远覆盖全部任务：prototype/ux.html；单任务 prototype/<任务>/ux/index.html）：
  默认          分析全部任务 + docs/ux/requirements.md 里的项目需求，按维度优先级出报告
  --user-words  新增项目需求；会并入 docs/ux/requirements.md，后续重跑不会丢
  --resolve     逐条关闭待确认项（可多次或逗号分隔），记录在 prototype/.ux-resolved.json
  --by          关闭人（默认「用户」）
  --apply       把结论写回选中任务及其关联任务的 design.md（UX 复核区块）
  --dry-run     只打印将写入的文件，不落盘
  分析只基于仓库里已写下的事实；补完文档重跑会自动移除已修好的条目

通用参数：
  --root <dir>   目标仓库根目录（默认 cwd）
  --json         机器可读输出
  --dry-run      只打印将发生的动作，不落盘
  --force        覆盖已存在的非空结构文件（默认永不覆盖）
  --force-state  连同状态文件一起覆盖（进度日志 / 功能清单 / 任务队列，慎用）

退出码：0 通过 / 1 有违规 / 2 工具或用法有错`;

const PLAN_TAG = {
  create: 'CREATE',
  overwrite: 'WRITE',
  keep: 'KEEP',
  append: 'APPEND',
  update: 'UPDATE',
  merge: 'MERGE',
  adopt: 'ADOPT',
  conflict: 'CONFLICT',
};
const LEVEL_TAG = {ok: 'OK', warn: 'WARN', error: 'ERR'};

function parseArgs(argv) {
  const flags = {
    json: false,
    dryRun: false,
    force: false,
    forceState: false,
    stdout: false,
    strict: false,
    wikiMode: undefined,
    check: false,
  };
  const positional = [];
  const unknown = [];
  const repeatable = new Set(['term', 'aggregate', 'invariant', 'contract', 'accept', 'step', 'non-goal', 'resolve']);
  const valueFlags = new Set([
    'root', 'preset', 'user-words', 'dir', 'step', 'pct', 'status', 'note', 'agent', 'by',
    'goal', 'scope', 'context', 'term', 'aggregate', 'invariant', 'contract', 'accept', 'non-goal', 'input-json',
    'port', 'resolve',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const name = token.replace(/^-+/, '');
    const eq = name.indexOf('=');
    const key = eq === -1 ? name : name.slice(0, eq);
    const inline = eq === -1 ? undefined : name.slice(eq + 1);

    if (key === 'json') flags.json = true;
    else if (key === 'dry-run') flags.dryRun = true;
    else if (key === 'force') flags.force = true;
    else if (key === 'force-state') flags.forceState = true;
    else if (key === 'stdout') flags.stdout = true;
    else if (key === 'strict') flags.strict = true;
    else if (key === 'apply') flags.apply = true;
    else if (key === 'merge') flags.wikiMode = 'merge';
    else if (key === 'update' || key === 'auto') flags.wikiMode = 'auto';
    else if (key === 'keep') flags.wikiMode = 'keep';
    else if (key === 'ask') flags.wikiMode = 'ask';
    else if (key === 'check') flags.check = true;
    else if (key === 'confirm') flags.confirm = true;
    else if (key === 'yes' || key === 'y') flags.yes = true;
    else if (key === 'serve') flags.serve = true;
    else if (key === 'stop') flags.stop = true;
    else if (key === 'help' || key === 'h') flags.help = true;
    else if (key === 'version' || key === 'v') flags.version = true;
    else if (valueFlags.has(key)) {
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined) unknown.push(`--${key} 缺少取值`);
      else if (repeatable.has(key)) flags[key] = [...(flags[key] || []), value];
      else flags[key === 'user-words' ? 'userWords' : key] = value;
    } else unknown.push(`未知参数 --${key}`);
  }
  return {command: positional[0], args: positional.slice(1), flags, unknown};
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function printPlan(root, results) {
  const lines = [`dsh-plugin-harness-cli init → ${root}`];
  for (const r of results) {
    lines.push(`  ${pad(PLAN_TAG[r.action] || r.action.toUpperCase(), 7)} ${r.rel}`);
  }
  return lines.join('\n');
}

function printChecks(title, root, result) {
  const lines = [`${title} → ${root}`];
  for (const c of result.checks) {
    const id = c.id ? `${pad(c.id, 6)} ` : '';
    lines.push(`  ${pad(LEVEL_TAG[c.level] || c.level, 5)} ${id}${c.message}`);
    if (c.hint) lines.push(`  ${' '.repeat(11)}↳ ${c.hint}`);
  }
  const s = result.summary;
  lines.push('');
  lines.push(
    `合计 ${s.total} 项：错误 ${s.errors}，警告 ${s.warnings}。` +
      (s.errors > 0 ? '结果：不通过 ✗' : s.warnings > 0 ? '结果：通过（有警告）✓' : '结果：通过 ✓')
  );
  return lines.join('\n');
}

function resolveRoot(flags) {
  return path.resolve(flags.root || process.cwd());
}

function fail(message) {
  process.stderr.write(`dsh-plugin-harness-cli: ${message}\n`);
  return 2;
}

/** 前置条件不满足（业务违规，如方案未确认）：退出码 1，和 check 的失败语义一致。 */
function refuse(message) {
  process.stderr.write(`dsh-plugin-harness-cli: ${message}\n`);
  return 1;
}

/**
 * 把 `--preset` 落到已存在的 harness-cli.json 上。
 *
 * 为什么需要单独一步：`applyPlan` 对已存在的配置一律 keep（配置是用户的资产，
 * 里面可能有 positioning / dirs），所以「先 init 过、之后才加 preset」时，
 * 磁盘上的 `enabled` 会一直是 false —— `page` 会报「preset 未启用」，P1xx 校验也会跳过。
 * 这里只改 `presets[<name>].enabled` 一个字段，其余内容原样保留。
 *
 * @param {string} root - 目标仓库根目录。
 * @param {string | undefined} preset - preset 名。
 * @param {boolean} dryRun - 只报告不落盘。
 * @returns {{rel: string, action: string} | null} 需要报告的变更项；无变化返回 null。
 */
function persistPreset(root, preset, dryRun) {
  if (!preset) return null;
  const {name} = resolveConfigFile(root);
  const file = path.join(root, name);
  // 全新项目：plan 里那份配置已经带上 enabled: true，这里不用管。
  if (!exists(file)) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // 配置坏了交给 validateConfig / check 报，这里不猜
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const presets = parsed.presets && typeof parsed.presets === 'object' && !Array.isArray(parsed.presets)
    ? parsed.presets
    : {};
  const current = presets[preset] && typeof presets[preset] === 'object' ? presets[preset] : {};
  if (current.enabled === true) return null;

  parsed.presets = {...presets, [preset]: {...current, enabled: true}};
  if (!dryRun) writeFileSafe(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return {rel: name, action: 'update'};
}

/**
 * 把某个 rel 的结果行改成新的动作，避免同一个文件在计划里出现两行。
 * @param {{rel: string, action: string}[]} results - applyPlan 的结果行。
 * @param {string} rel - 相对路径。
 * @param {string} action - 新动作。
 */
function upsertResult(results, rel, action) {
  const index = results.findIndex((item) => item.rel === rel);
  if (index === -1) results.push({rel, action});
  else results[index] = {rel, action};
}

function cmdInit(root, flags) {
  const {config, hadFile} = loadConfig(root);

  for (const preset of flags.preset ? [flags.preset] : []) {
    if (!PRESET_NAMES.includes(preset)) {
      return fail(`未知 preset：${preset}（可用：${PRESET_NAMES.join(', ')}）`);
    }
  }
  if (flags.preset) {
    config.presets = config.presets || {};
    config.presets[flags.preset] = {...(config.presets[flags.preset] || {}), enabled: true};
  }

  const issues = validateConfig(config);
  if (issues.length) {
    process.stderr.write(`配置有问题，先修 ${CONFIG_FILE}：\n${issues.map((i) => `  - ${i}`).join('\n')}\n`);
    return 2;
  }

  const plan = buildPlan(root, config, {});
  const results = applyPlan(root, plan, {dryRun: flags.dryRun, force: flags.force, forceState: flags.forceState});

  // preset 在已有项目上开启时，配置被 keep 了，磁盘上仍是 enabled:false。
  // 补一次最小写入，并让生成的 AGENTS.md 跟上（§5.1 只在 preset 打开时出现）。
  const presetChange = persistPreset(root, flags.preset, flags.dryRun);
  let regenerated = false;
  if (presetChange) {
    upsertResult(results, presetChange.rel, presetChange.action);
    const agentsChange = generate(root, config, {
      dryRun: flags.dryRun,
      configFile: resolveConfigFile(root).name,
    });
    if (agentsChange.action !== 'keep') {
      upsertResult(results, config.paths.agents, 'update');
      regenerated = true;
    }
  }

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({root, dryRun: Boolean(flags.dryRun), hadConfig: hadFile, files: results}, null, 2)}\n`
    );
    return 0;
  }

  process.stdout.write(`${printPlan(root, results)}\n`);
  const created = results.filter((r) => r.action !== 'keep').length;
  process.stdout.write(`\n${flags.dryRun ? '（dry-run，未落盘）' : `已写入 ${created} 项，跳过 ${results.length - created} 项`}\n`);
  if (config.presets && config.presets.prototype && config.presets.prototype.enabled) {
    process.stdout.write('preset prototype 已启用：任务进度页约定见 prototype/README.md\n');
  }
  if (regenerated) {
    process.stdout.write(`AGENTS.md 已按新配置重生成（preset 的 §5.1 只在打开时出现）\n`);
  }
  process.stdout.write('\n下一步：\n');
  process.stdout.write('  1. 填 harness-cli.json 的 project.positioning 与 dirs\n');
  if (!regenerated) {
    process.stdout.write('  2. node bin/dsh-plugin-harness-cli.js agents    # 重新生成 AGENTS.md\n');
  }
  process.stdout.write(`  ${regenerated ? 2 : 3}. node bin/dsh-plugin-harness-cli.js check     # 自检\n`);
  return 0;
}

/**
 * ui：给任务生成 / 更新 UI 设计稿（antd v5 风格，离线静态页）。
 * 任务页不存在会先补任务页与四份规范文档，因此「任务执行时」不会再出现 prototype 缺失。
 */
function cmdUi(root, flags) {
  let pickedConfig;
  try {
    pickedConfig = loadConfig(root).config;
  } catch (error) {
    return fail(error.message);
  }
  const picked = resolveTaskOrRecent(root, flags, pickedConfig, 'ui');
  if (picked.error) return fail(picked.error);
  const task = picked.task;

  const boot = ensurePreset(root, flags);
  if (boot.error) return boot.error;
  if (boot.dryRun) {
    process.stdout.write(`（dry-run）将创建 ${task} 的 UI 设计稿（antd）\n`);
    return 0;
  }
  const config = boot.config;
  const ctx = buildContext(config, {task, userWords: flags.userWords || ''});

  const pageFile = path.join(root, ctx.prototype.dir, task, ctx.prototype.progressPage);
  if (!exists(pageFile)) {
    const code = cmdPage(root, {
      args: [task],
      userWords: flags.userWords,
      force: false,
      dryRun: false,
      json: false,
    });
    if (code !== 0) return code;
  }

  const uiDir = path.join(root, ctx.prototype.dir, task, 'ui');
  const files = [
    ['index.html', 'prototypeUi'],
    ['README.md', 'prototypeUiReadme'],
  ].map(([name, key]) => {
    const abs = path.join(uiDir, name);
    return {name, abs, content: render(loadTemplate(key), ctx), exists: exists(abs)};
  });

  if (flags.dryRun) {
    for (const file of files) {
      if (!file.exists) process.stdout.write(`（dry-run）将写入 ${file.abs}\n`);
    }
    return 0;
  }

  process.stdout.write(`dsh-plugin-harness-cli ui → ${path.relative(root, uiDir)}/\n`);
  let wrote = 0;
  for (const file of files) {
    if (file.exists && !flags.force) {
      process.stdout.write(`  KEEP    ${path.relative(root, file.abs)}（已存在，加 --force 覆盖）\n`);
      continue;
    }
    writeFileSafe(file.abs, file.content);
    wrote += 1;
    process.stdout.write(`  ${file.exists ? 'WRITE ' : 'CREATE'}   ${path.relative(root, file.abs)}\n`);
  }

  // UI 设计是 specs 的一部分：设计稿一变就把摘要与指纹写回 design.md
  const designSync = syncDesignFromUi(root, task, config.paths);
  if (designSync.action === 'updated') {
    process.stdout.write(
      `  SYNC    docs/specs/${task}/design.md（UI 设计摘要已同步，指纹 ${designSync.hash}）\n`
    );
  }

  // UI 是任务活动：追加一条进度记录，并把状态 / 产物同步进任务队列。
  const uiLog = appendTaskLog(
    root,
    config,
    task,
    `UI 设计稿已生成：${toPosix(path.relative(root, path.join(uiDir, 'index.html')))}`
  );
  if (uiLog.ok) {
    const progressRel = toPosix(
      path.relative(root, path.join(uiDir, '..', ctx.prototype.progressPage || 'progress.html'))
    );
    process.stdout.write(`  LOG     ${progressRel}（UI 设计记录）\n`);
  }
  syncTaskQueue(root, config, task, [
    toPosix(path.relative(root, path.join(uiDir, 'index.html'))),
    toPosix(path.relative(root, path.join(uiDir, 'README.md'))),
  ]);

  // 让总览页的「UI」列立即正确
  const synced = syncOverview(root, config);
  if (!synced.ok) {
    process.stderr.write(`  总览页同步失败（UI 稿已写入）：${synced.message}\n`);
    return 2;
  }
  // 生成只是第一步：把「还缺什么」列成清单，交给 /harness-cli-ui 自动发起补全
  const gaps = uiGaps(root, task, config);
  const gapsFile = writeUiGapReport(root, task, config, gaps);
  process.stdout.write(`  UI 设计仍需补全：${gaps.length} 处（清单：${gapsFile}）\n`);
  for (const gap of gaps.slice(0, 5)) {
    process.stdout.write(`    - ${gap.file}${gap.line ? `:${gap.line}` : ''}  ${gap.text.slice(0, 80)}\n`);
  }
  if (gaps.length > 5) process.stdout.write(`    … 其余 ${gaps.length - 5} 处见清单\n`);

  refreshPlans(root, config);
  process.stdout.write(
    `  下一步：补全 ${path.relative(root, uiDir)}/README.md 的「页面目标 / 契约对应」，` +
      `再按 antd 组件实现（不要引入第二套设计体系）\n`
  );
  return 0;
}

/**
 * sql：数据库设计（schema.sql 是唯一真源）。
 * - 第一次运行：补任务页 / 四份文档 / schema.sql 骨架 / database.md 模板；
 * - 之后每次运行：解析 schema.sql、按 Google 数模规范 lint，并重新生成 er.mmd 与 db/index.html。
 */
function cmdSql(root, flags) {
  let pickedConfig;
  try {
    pickedConfig = loadConfig(root).config;
  } catch (error) {
    return fail(error.message);
  }
  const picked = resolveTaskOrRecent(root, flags, pickedConfig, 'sql');
  if (picked.error) return fail(picked.error);
  const task = picked.task;

  const ready = ensureTask(root, flags, task);
  if (ready.error) return ready.error;
  if (ready.dryRun) {
    process.stdout.write(`（dry-run）将创建 ${task} 的数据库设计骨架（schema.sql / database.md / db/index.html）\n`);
    return 0;
  }
  const config = ready.config;
  const ctx = buildContext(config, {task});
  const specDir = path.join(root, config.paths.specs || 'docs/specs', task);
  const dbDir = path.join(root, ctx.prototype.dir, task, 'db');
  const schemaFile = path.join(specDir, 'schema.sql');
  const docFile = path.join(specDir, 'database.md');
  const mmdFile = path.join(specDir, 'er.mmd');
  const pageFile = path.join(dbDir, 'index.html');

  const created = [];
  if (!exists(schemaFile)) {
    writeFileSafe(schemaFile, render(loadTemplate('schemaSql'), ctx));
    created.push(['CREATE', schemaFile]);
  }
  if (!exists(docFile)) {
    writeFileSafe(docFile, render(loadTemplate('databaseDoc'), ctx));
    created.push(['CREATE', docFile]);
  }

  const model = parseSchema(fs.readFileSync(schemaFile, 'utf8'));
  // 先合并所有任务的表名：跨任务外键的目标表在别的 schema.sql 里，
  // 不能把「本任务没有这张表」误报成 DB005。
  const overall = loadOverall(root, config);
  const ownTables = new Set(model.tables.map((item) => item.name));
  const externalTables = new Set(
    overall.tables.filter((item) => !ownTables.has(item.name)).map((item) => item.name)
  );
  // 跨任务外键：本任务 schema 引用另一个任务的表时，单任务图也要把关系说清楚（标记为外部表）。
  const externalRelations = [];
  for (const table of model.tables) {
    for (const column of table.columns) {
      if (!column.fk || ownTables.has(column.fk.table)) continue;
      const target = overall.tables.find((item) => item.name === column.fk.table);
      if (!target) continue;
      let targetColumn = column.fk.column;
      if (!targetColumn && target.primaryKey.length === 1) targetColumn = target.primaryKey[0];
      if (!targetColumn) continue;
      const targetColumnInfo = target.columns.find((item) => item.name === targetColumn);
      externalRelations.push({
        from: table.name,
        fromColumn: column.name,
        to: target.name,
        toColumn: targetColumn,
        oneToOne: Boolean(
          column.unique || (table.primaryKey.length === 1 && table.primaryKey[0] === column.name)
        ),
        external: true,
        targetDescription: target.description || '',
        targetColumnDescription: targetColumnInfo ? targetColumnInfo.description || '' : '',
      });
    }
  }
  const lint = lintModel(model, {externalTables});
  const full = {...model, relations: [...model.relations, ...externalRelations], ...lint};
  // 把 schema.sql 的 COMMENT / 行尾说明反填进 database.md 的受管区块。
  writeFileSafe(docFile, syncDatabaseDoc(readIfExistsFile(docFile) || '', full));
  const meta = {
    task,
    project: config.project.name,
    generatedAt: new Date().toISOString(),
    schemaPath: toPosix(path.relative(root, schemaFile)),
    mermaidPath: toPosix(path.relative(root, mmdFile)),
  };
  writeFileSafe(mmdFile, renderMermaid(full));
  writeFileSafe(pageFile, renderErPage(full, meta));

  // 整体数模图：把所有任务的 schema 合并成一张可拖拽布局的预览页。
  const overviewFile = path.join(root, ctx.prototype.dir, 'db.html');
  writeFileSafe(overviewFile, renderOverviewPage(overall, {generatedAt: meta.generatedAt}));

  const files = {
    schema: toPosix(path.relative(root, schemaFile)),
    doc: toPosix(path.relative(root, docFile)),
    mermaid: toPosix(path.relative(root, mmdFile)),
    page: toPosix(path.relative(root, pageFile)),
    overview: toPosix(path.relative(root, overviewFile)),
  };

  const sqlLog = appendTaskLog(
    root,
    config,
    task,
    `数据库设计已生成：${model.tables.length} 张表 / ${full.relations.length} 条关系（${files.schema}）`
  );
  const queue = syncTaskQueue(root, config, task, [
    files.schema,
    files.doc,
    files.mermaid,
    files.page,
    files.overview,
  ]);
  const overviewSync = syncOverview(root, config);
  if (!overviewSync.ok) process.stderr.write(`  总览页同步失败（数模图已写入）：${overviewSync.message}\n`);
  // plans.html 也要能直接预览数模图 / 数模文档：刷新任务总览。
  refreshPlans(root, config);

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          root,
          task,
          files,
          created: created.map(([, file]) => toPosix(path.relative(root, file))),
          tables: model.tables.length,
          relations: full.relations.length,
          errors: lint.errors,
          warnings: lint.warnings,
          overview: {
            file: files.overview,
            tables: overall.counts.tables,
            relations: overall.counts.relations,
            conflicts: overall.counts.conflicts,
          },
          log: {ok: sqlLog.ok},
          queue: {ok: queue.ok, skipped: queue.skipped || null},
        },
        null,
        2
      )}\n`
    );
    return lint.errors.length === 0 ? 0 : 1;
  }

  process.stdout.write(`dsh-plugin-harness-cli sql → ${task}\n`);
  for (const [action, file] of created) {
    process.stdout.write(`  ${pad(action, 7)} ${toPosix(path.relative(root, file))}\n`);
  }
  const externalCount = full.relations.filter((relation) => relation.external).length;
  process.stdout.write(
    `  ${pad(model.tables.length > 0 ? 'RENDER' : 'WAIT', 7)} ${files.mermaid}（${model.tables.length} 张表 / ` +
      `${full.relations.length} 条关系${externalCount > 0 ? `，其中外部 ${externalCount} 条` : ''}）\n`
  );
  process.stdout.write(`  RENDER  ${files.page}（离线数模图）\n`);
  process.stdout.write(
    `  RENDER  ${files.overview}（整体：${overall.counts.tables} 表 / ${overall.counts.relations} 关系` +
      `${overall.counts.conflicts > 0 ? ` / ${overall.counts.conflicts} 冲突` : ''}）\n`
  );
  if (sqlLog.ok) {
    const progressRel = toPosix(
      path.relative(root, path.join(root, ctx.prototype.dir, task, ctx.prototype.progressPage || 'progress.html'))
    );
    process.stdout.write(`  LOG     ${progressRel}（数模设计记录）\n`);
  }
  if (queue.ok) process.stdout.write(`  QUEUE   ${config.paths.taskQueue}（${task}）\n`);
  process.stdout.write(`  数模检查：错误 ${lint.errors.length}，警告 ${lint.warnings.length}\n`);
  const issues = [...lint.errors, ...lint.warnings];
  for (const issue of issues.slice(0, 12)) {
    process.stdout.write(`    ${pad(issue.level === 'error' ? 'ERR' : 'WARN', 5)} ${issue.id} ${issue.message}\n`);
    if (issue.hint) process.stdout.write(`         ↳ ${issue.hint}\n`);
  }
  if (issues.length > 12) process.stdout.write(`    … 其余 ${issues.length - 12} 处见上方规则\n`);
  process.stdout.write(
    lint.errors.length === 0
      ? `  下一步：把 ${files.page} 发给需要评审的人；schema.sql 再改时重跑本命令刷新数模图。\n`
      : `  下一步：补全 ${files.schema}（或修 lint 错误），再跑 /harness-cli sql ${task}。\n`
  );
  return lint.errors.length === 0 ? 0 : 1;
}

/** 规范文档的顺序固定：指纹与复盘都以这个顺序计算。 */
const SPEC_DOC_FILES = ['flow.md', 'proposal.md', 'spec.md', 'design.md', 'tasks.md'];

/**
 * 计算 docs/specs/<任务>/ 四份文档的指纹（sha1）。
 * 文档被人工改过指纹就变，确认会失效——这是「先定稿、再执行」的机械保证。
 * @returns {string} 形如 sha1:xxxx。
 */
function docsHash(root, task, paths) {
  const dir = path.join(root, paths.specs || 'docs/specs', task);
  const text = SPEC_DOC_FILES.map((name) => {
    const content = readIfExistsFile(path.join(dir, name)) || '';
    return content.replace(/\r\n/g, '\n').trim();
  }).join('\n');
  return `sha1:${crypto.createHash('sha1').update(text).digest('hex')}`;
}

/** 读 review.md 的复盘结论与指纹。 */
function readReview(root, task, paths) {
  const file = path.join(root, paths.specs || 'docs/specs', task, 'review.md');
  const text = readIfExistsFile(file) || '';
  return {
    file,
    text,
    exists: text.length > 0,
    passed: /状态：\s*已通过/.test(text),
    hash: (() => {
      const m = /文档指纹：\s*`?(sha1:[0-9a-f]{40})`?/.exec(text);
      return m ? m[1] : null;
    })(),
  };
}

/** 给 review.md 补/改状态行与确认信息。 */
function stampReview(text, status, by, at) {
  const head = `> 状态：${status}`;
  let next = text.replace(/^> 状态：.*$/m, head);
  if (!/^> 状态：/m.test(next)) next = next.replace(/^(# .*\n)/, `$1\n${head}\n`);
  const extra = `> 确认人：${by} · 确认时间：${at}`;
  next = next.replace(/^> 确认人：.*$/m, extra);
  if (!/^> 确认人：/m.test(next)) next = next.replace(head, `${head}\n\n${extra}`);
  return next;
}

/**
 * 复盘：把 docs/specs 与任务页对齐后，用项目自己的判定跑一遍，写 review.md。
 * 这是「人改文档 → Agent 复盘 → 人确认」里的中间那一步。
 */
function cmdReview(root, flags) {
  let pickedConfig;
  try {
    pickedConfig = loadConfig(root).config;
  } catch (error) {
    return fail(error.message);
  }
  const picked = resolveTaskOrRecent(root, flags, pickedConfig, 'review');
  if (picked.error) return fail(picked.error);
  const task = picked.task;

  const ready = ensureTask(root, flags, task);
  if (ready.error) return ready.error;
  if (ready.dryRun) return 0;
  const config = ready.config;
  const paths = ready.config.paths;
  const specDir = path.join(root, paths.specs || 'docs/specs', task);

  // 用项目自己的判定跑一遍：文档完整性、页面与文档一致性都在这里
  const check = spawnSync(process.execPath, [path.join(root, paths.prototypeCheck), '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  let parsed = null;
  try {
    parsed = JSON.parse(check.stdout || '{}');
  } catch (err) {
    parsed = null;
  }
  const failures = parsed && Array.isArray(parsed.checks)
    ? parsed.checks.filter(
        // 复盘只看「文档与页面是否一致」；P21/P22 是「是否可开工」的门禁，由确认步骤负责
        (item) => item.level === 'error' && !['P12', 'P21', 'P22'].includes(item.id)
      )
    : [];
  const hash = docsHash(root, task, paths);
  const agent = String(flags.agent || 'agent').trim();

  const lines = [
    `# ${task} · 复盘（Review）`,
    '',
    '> 状态：待确认',
    '',
    `- 复盘时间：${new Date().toISOString()}`,
    `- 执行 Agent：${agent}`,
    `- 文档指纹：${hash}`,
    `- 规范文档：docs/specs/${task}/${SPEC_DOC_FILES.join(' / ')}`,
    '',
    '## 1. 检查结果',
    '',
  ];
  if (failures.length === 0 && parsed !== null) {
    lines.push('- ✅ 文档与任务页一致，判定全绿');
  } else if (parsed === null) {
    lines.push(`- ❌ 无法运行页面校验：${(check.stderr || check.stdout || '').trim().slice(0, 300)}`);
  } else {
    for (const item of failures) lines.push(`- ❌ [${item.id}] ${item.message}`);
  }
  lines.push('', '## 2. 复盘结论', '', '- 待补：Agent 复盘后写清「方案是否可执行、风险与未决问题」', '');
  lines.push('## 3. 人工确认', '', '- 待确认：确认后执行 `plan <任务> --confirm --by "确认人"`', '');

  if (!flags.dryRun) writeFileSafe(path.join(specDir, 'review.md'), `${lines.join('\n')}\n`);
  process.stdout.write(`dsh-plugin-harness-cli review → ${path.relative(root, path.join(specDir, 'review.md'))}\n`);
  if (failures.length > 0 || parsed === null) {
    process.stderr.write(`复盘未通过：${failures.length} 项待处理（见 review.md 的检查结果）\n`);
    return 1;
  }
  process.stdout.write('复盘通过：等人工确认后执行 plan --confirm --by "确认人"\n');
  return 0;
}

/**
 * 确保任务目录齐备：预设、任务页、四份文档、方案页。

 * 「任务一开始」就调用它，所以 prototype/ 不会再出现「任务跑起来了但目录是空的」。
 * @returns {{config: object, ctx: object} | {error: number} | {dryRun: true}}
 */
function ensureTask(root, flags, task) {
  const boot = ensurePreset(root, flags);
  if (boot.error) return {error: boot.error};
  if (boot.dryRun) return {dryRun: true};
  const ctx = buildContext(boot.config, {task, userWords: flags.userWords || ''});
  const pageFile = path.join(root, ctx.prototype.dir, task, ctx.prototype.progressPage);
  const pageExisted = exists(pageFile);
  const planFile = path.join(root, ctx.prototype.dir, task, 'plan.html');
  const planExisted = exists(planFile);
  if (!pageExisted) {
    const code = cmdPage(root, {
      args: [task],
      userWords: flags.userWords,
      force: false,
      dryRun: false,
      json: false,
    });
    if (code !== 0) return {error: code};
  }
  if (!exists(planFile)) {
    writeFileSafe(planFile, render(loadTemplate('prototypePlan'), ctx));
    process.stdout.write(`  CREATE  ${path.relative(root, planFile)}（方案页，确认后才开工）\n`);
  }
  return {config: boot.config, ctx, pageExisted, planExisted};
}

/**
 * 自动找「上一次的任务」：优先进行中 / 待验收，其次按任务页修改时间倒序。
 * 给 `ui` / `plan` / `review` 省略任务名时用，避免每次都要记任务叫什么。
 * @returns {{task: string, status: string, reason: string} | {error: string}}
 */
function findRecentTask(root, config) {
  const proto = (config.presets && config.presets.prototype) || {};
  const dir = path.join(root, proto.dir || 'prototype');
  const pageName = proto.progressPage || 'progress.html';
  if (!isDir(dir)) {
    return {error: '还没有任务：先跑 dsh-plugin-harness-cli page <任务名> 建一个（或 ui <任务名>）'};
  }
  const rows = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const page = path.join(dir, entry.name, pageName);
    const text = readIfExistsFile(page) || '';
    const status = (/data-task-status="([^"]*)"/.exec(text) || [])[1] || '进行中';
    let stamp = 0;
    try {
      stamp = fs.statSync(page).mtimeMs;
    } catch (err) {
      try {
        stamp = fs.statSync(path.join(dir, entry.name)).mtimeMs;
      } catch (err2) {
        stamp = 0;
      }
    }
    rows.push({name: entry.name, status, stamp});
  }
  if (rows.length === 0) {
    return {error: '还没有任务：先跑 dsh-plugin-harness-cli page <任务名> 建一个（或 ui <任务名>）'};
  }
  const active = rows.filter((row) => row.status === '进行中' || row.status === '待验收');
  const pool = (active.length > 0 ? active : rows).slice().sort((a, b) => b.stamp - a.stamp);
  const picked = pool[0];
  const reason = active.length > 0 ? `状态「${picked.status}」里最近更新的` : '最近更新的任务';
  return {task: picked.name, status: picked.status, reason, count: rows.length, activeCount: active.length};
}

/** 解析任务名：显式给了就用，没给就自动挑「上一次的任务」。 */
function resolveTaskOrRecent(root, flags, config, label) {
  const explicit = flags.args && flags.args[0];
  if (isText(explicit)) {
    if (!isTaskName(explicit)) {
      return {error: `任务名只能用字母 / 数字 / 中文 / 中划线 / 下划线（不能有空格或斜杠）：${explicit}`};
    }
    return {task: explicit.trim(), picked: false};
  }
  const recent = findRecentTask(root, config);
  if (recent.error) return {error: recent.error};
  process.stdout.write(`dsh-plugin-harness-cli ${label}：自动选择${recent.reason}任务「${recent.task}」\n`);
  return {task: recent.task, picked: true};
}

/** 从任务页里取所有步骤百分比。 */
function readStepPcts(html) {
  return [...html.matchAll(/class="[^"]*\bstep-pct\b[^"]*"[^>]*data-pct="([^"]*)"/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
}

function totalOf(values) {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
}

/**
 * plan：补全 / 更新任务的 docs/specs。
 * - 只写 `docs/specs/<任务>/`；未开工时顺带补齐任务页 / 方案页骨架；
 * - 已开工（总进度 > 0）或方案已确认后，不再改写 `prototype` 下的页面；
 * - `--confirm --by <人>` 只更新方案页的已确认状态。
 */
function cmdPlan(root, flags) {
  let pickedConfig;
  try {
    pickedConfig = loadConfig(root).config;
  } catch (error) {
    return fail(error.message);
  }
  const picked = resolveTaskOrRecent(root, flags, pickedConfig, 'plan');
  if (picked.error) return fail(picked.error);
  const task = picked.task;

  const ready = ensureTask(root, flags, task);
  if (ready.error) return ready.error;
  if (ready.dryRun) {
    process.stdout.write(`（dry-run）将创建 ${task} 的方案页\n`);
    return 0;
  }

  const planFile = path.join(root, ready.ctx.prototype.dir, task, 'plan.html');
  if (flags.dryRun) {
    process.stdout.write(`（dry-run）方案页与规范文档：${path.relative(root, planFile)}\n`);
    return 0;
  }

  if (!flags.confirm) {
  // 用模型把 docs/specs 的文档补全（人随时可以改）；任务页与方案页不在这里改写
  let model;
  try {
    model = mergeFlags(defaultModel({task, userWords: flags.userWords}), flags);
  } catch (error) {
    return fail(error.message);
  }
  const docs = renderDocs(model);
  const specDir = path.join(root, ready.config.paths.specs || 'docs/specs', task);
  let written = 0;
  let kept = 0;
  const rows = [];
  for (const [name, content] of Object.entries(docs)) {
    const abs = path.join(specDir, name);
    const current = readIfExistsFile(abs);
    const skeleton = current === null || /待填/.test(current);
    if (current !== null && !skeleton && !flags.force) {
      kept += 1;
      rows.push(`  KEEP    ${path.relative(root, abs)}（已填，不覆盖）`);
      continue;
    }
    writeFileSafe(abs, content);
    written += 1;
    rows.push(`  ${current === null ? 'CREATE' : 'WRITE '}   ${path.relative(root, abs)}`);
  }

  // plan 只负责 docs/specs；只有「未开工（总进度 0）且方案未确认」的骨架页才顺带补齐，
  // 一旦有进度或人工确认，prototype 下的页面就不再被 plan 改写。
  const pageFile = path.join(root, ready.ctx.prototype.dir, task, ready.ctx.prototype.progressPage);
  const pageHtml = readIfExistsFile(pageFile) || '';
  const total = totalOf(readStepPcts(pageHtml));
  const planFile = path.join(root, ready.ctx.prototype.dir, task, 'plan.html');
  let planHtml = readIfExistsFile(planFile) || '';
  const confirmed = /data-plan-status="已确认"/.test(planHtml);
  const canSync = total === 0 && !confirmed;

  if (canSync && pageHtml.length > 0) {
    writeFileSafe(pageFile, applyToPage(pageHtml, model));
    rows.push(`  WRITE   ${path.relative(root, pageFile)}（未开工：契约 / 用例 / 规划已同步）`);
  } else {
    rows.push(
      `  KEEP    ${path.relative(root, pageFile)}（${total > 0 ? `已有进度 ${total}%` : '已确认'}，plan 只写 docs/specs）`
    );
  }

  if (canSync && planHtml.length > 0) {
    if (!/id="business-flow"/.test(planHtml)) {
      // 老任务升级：从当前模板取「业务流程图」区块插到目标前，再由 applyToPlan 填内容。
      const fresh = render(loadTemplate('prototypePlan'), ready.ctx);
      const section = /(<section id="business-flow"[\s\S]*?<\/section>)/.exec(fresh);
      if (section) planHtml = planHtml.replace(/(<section id="goal")/, `${section[1]}\n\n  $1`);
    }
    model.hasUi = exists(path.join(root, ready.ctx.prototype.dir, task, 'ui', 'index.html'));
    writeFileSafe(planFile, applyToPlan(planHtml, model));
    rows.push(`  WRITE   ${path.relative(root, planFile)}（未开工：目标 / 方案 / 流程 / 风险 / 验收已同步）`);
  } else if (planHtml.length > 0) {
    rows.push(`  KEEP    ${path.relative(root, planFile)}（已确认，plan 只写 docs/specs）`);
  }

  // 文档写完后再对齐 UI 设计与业务 wiki 的事实（有就同步，没有就跳过）
  const designSync = syncDesignFromUi(root, task, ready.config.paths);
  if (designSync.action === 'updated') rows.push(`  SYNC    docs/specs/${task}/design.md（UI 设计摘要）`);
  const facts = collectFacts(root);
  const proposalSync = syncProposalFromWiki(root, ready.config.paths, () => ({
    project: `${facts.project.name} v${facts.project.version}`,
    domains: facts.domains.map((item) => item.name).join(' / ') || '—',
    counts: `${facts.counts.features} 条功能（进行中 ${facts.counts.inProgress}，完成 ${facts.counts.done}）`,
  }));
  if (proposalSync.action === 'updated') rows.push(`  SYNC    docs/specs/<任务>/proposal.md（业务背景区块）`);

  process.stdout.write(`dsh-plugin-harness-cli plan → ${task}\n`);
  for (const row of rows) process.stdout.write(`${row}\n`);
  process.stdout.write(`  规范文档：写入 ${written} 篇，保留 ${kept} 篇（已开工 / 已确认的任务只动 docs/specs）\n`);
  if (!canSync) {
    process.stdout.write('  NOTE    已开工 / 已确认：只更新 docs/specs，不自动开工\n');
  }
  }

  if (flags.confirm) {
    let by = String(flags.by || '').trim();
    if (by.length === 0 && readTaskMode(root, ready.config, task) === 'auto') {
      // 任务开始前选的是自动 loop：确认方案时自动选择「确认」，不需要再弹窗。
      by = '自动 loop';
    }
    if (by.length === 0) return fail('--confirm 需要 --by "确认人"（谁确认的方案）');

    // 先定稿 docs/specs，再复盘，最后才允许确认
    const paths = ready.config.paths;
    const hash = docsHash(root, task, paths);
    const review = readReview(root, task, paths);
    if (!review.exists) {
      return refuse(`还没有复盘：先跑 dsh-plugin-harness-cli review ${task}（Agent 复盘后由人确认）`);
    }
    if (review.hash !== hash) {
      return refuse(`docs/specs/${task}/ 在复盘后改过：重新跑 review ${task} 再确认`);
    }
    if (/❌/.test(review.text)) {
      return refuse(`复盘未通过（见 ${path.relative(root, review.file)}）：先改文档/页面再复盘`);
    }

    const now = new Date().toISOString();
    writeFileSafe(review.file, stampReview(review.text, '已通过', by, now));
    const safeBy = by.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    let html = fs.readFileSync(planFile, 'utf8');
    if (!/data-docs-hash="/.test(html)) {
      html = html.replace(/<html([^>]*)>/, `<html$1 data-docs-hash="">`);
    }
    html = html
      .replace(/data-plan-status="[^"]*"/, 'data-plan-status="已确认"')
      .replace(/data-flow-status="[^"]*"/, 'data-flow-status="已确认"')
      .replace(/data-confirmed-by="[^"]*"/, `data-confirmed-by="${safeBy}"`)
      .replace(/data-confirmed-at="[^"]*"/, `data-confirmed-at="${now}"`)
      .replace(/data-docs-hash="[^"]*"/, `data-docs-hash="${hash}"`)
      .replace(/data-plan-status-label>待确认</, 'data-plan-status-label>已确认<')
      .replace(/data-flow-status-label>待确认</, 'data-flow-status-label>已确认<')
      .replace(/data-confirmed-by-label>—</, `data-confirmed-by-label>${safeBy}<`)
      .replace(/data-confirmed-at-label>—</, `data-confirmed-at-label>${now}<`);
    writeFileSafe(planFile, html);
    process.stdout.write(`dsh-plugin-harness-cli plan → ${path.relative(root, planFile)}（已确认，确认人 ${by}）\n`);
    process.stdout.write('  下一步：把任务状态置为「进行中」，再用 progress 推进度（每次更新都会写进页面与记录）\n');
    return 0;
  }

  refreshPlans(root, ready.config);
  process.stdout.write('  下一步：人可改 docs/specs 与页面 → 跑 review 复盘 → plan --confirm --by "确认人" 确认\n');
  return 0;
}

/**
 * progress：任务执行期的唯一进度写入口。
 * 每次调用都会：更新步骤百分比 → 追加一条进度记录 → 重算总进度 → 同步总览页。
 * 方案未确认时拒绝写入（先确认再开始）。
 */
/**
 * 总览同步脚本缺失时按模板补回（只写这一个文件，不动其他生成物）。
 * 老项目、或手工删过脚本的项目里，progress 会只更新任务页而不同步总览，
 * 用户看到的就是「任务页有进度、prototype/progress.html 没变」。
 * @returns {string|null} 脚本绝对路径；补不回来返回 null。
 */
function ensurePrototypeCheck(root, config) {
  const target = path.join(root, config.paths.prototypeCheck);
  if (exists(target)) return target;
  try {
    const ctx = {...buildContext(config, {}), today: today()};
    writeFileSafe(target, render(loadTemplate('prototypeCheck'), ctx), 0o755);
    process.stdout.write(`  CREATE  ${config.paths.prototypeCheck}（总览同步脚本缺失，已按模板补回）\n`);
    return target;
  } catch (err) {
    return null;
  }
}

/**
 * 重算总览页（prototype/progress.html）。
 * 同步脚本是生成物：缺失时先按模板补回，失败时只报一行可执行的修法，
 * 不把 Node 的模块缺失堆栈甩给业务人员。
 * @returns {{ok: boolean, message: string}}
 */
function syncOverview(root, config) {
  const check = ensurePrototypeCheck(root, config);
  if (check === null) {
    return {
      ok: false,
      message: `缺少 ${config.paths.prototypeCheck} 且自动补齐失败；跑 dsh-plugin-harness-cli init 重新生成`,
    };
  }
  const sync = spawnSync(process.execPath, [check, '--sync'], {cwd: root, encoding: 'utf8'});
  const out = `${sync.stdout || ''}${sync.stderr || ''}`.trim();
  if (sync.status === 0) return {ok: true, message: '', out};
  const first = (sync.stderr || sync.stdout || '').trim().split('\n')[0] || `退出码 ${sync.status}`;
  return {
    ok: false,
    message: `${first}；跑 dsh-plugin-harness-cli init 重新生成 ${config.paths.prototypeCheck} 后重试`,
    out,
  };
}

/** 读任务页当前状态与总进度（给进度日志 / 任务队列共用）。 */
function taskSnapshot(root, config, task) {
  const preset = (config.presets && config.presets.prototype) || {};
  const page = path.join(root, preset.dir || 'prototype', task, preset.progressPage || 'progress.html');
  const html = readIfExistsFile(page) || '';
  return {
    page,
    html,
    status: (/data-task-status="([^"]*)"/.exec(html) || [])[1] || '进行中',
    total: totalOf(readStepPcts(html)),
  };
}

/**
 * 往任务页的 log-list 追加一条活动记录（不改进度百分比）。
 * ui / sql 这类「生成了设计资产」的动作要留痕，但不能伪造步骤进度。
 */
function appendTaskLog(root, config, task, note) {
  const snapshot = taskSnapshot(root, config, task);
  if (snapshot.html === '') return {ok: false};
  const now = new Date().toISOString();
  const safe = String(note || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const entry = `<li data-at="${now}" data-total="${snapshot.total}">${safe}</li>`;
  let html = snapshot.html.replace(
    /(<ul[^>]*class="[^"]*\blog-list\b[^"]*"[^>]*>)([\s\S]*?)(<\/ul>)/,
    (match, open, body, close) => `${open}${body.replace(/\s+$/, '')}\n      ${entry}\n    ${close}`
  );
  html = html.replace(
    /(<time[^>]*data-updated[^>]*datetime=")[^"]*(">)[^<]*(<\/time>)/,
    `$1${now}$2${now}$3`
  );
  writeFileSafe(snapshot.page, html);
  return {ok: true, status: snapshot.status, total: snapshot.total};
}

/** 把任务状态 / 进度 / 产物写进 task_queue.json（队列失败只告警，不拦主命令）。 */
function syncTaskQueue(root, config, task, artifacts) {
  const snapshot = taskSnapshot(root, config, task);
  const result = updateTaskQueue(root, config, task, {
    status: snapshot.status,
    progress: snapshot.total,
    artifacts,
  });
  if (!result.ok) process.stderr.write(`  任务队列更新失败：${result.error}\n`);
  return result;
}

/**
 * 老任务页升级：补上「步骤流程」区块与脚本。
 * 新模板已经自带；旧页面在下次 progress 命中时补齐，避免每个任务各跑一次 page --force。
 * @param {string} html - 现有任务页 HTML。
 * @param {object} config - 生效配置。
 * @param {string} task - 任务名。
 * @returns {{html: string, upgraded: boolean}} 补齐后的 HTML 与是否发生升级。
 */
function ensureProgressFlow(html, config, task) {
  if (!html || html.includes('data-flow')) return {html, upgraded: false};
  const ctx = buildContext(config, {task});
  const fresh = render(loadTemplate('progressHtml'), {...ctx, today: today()});
  const section = /(<section class="flow">[\s\S]*?<\/section>)/.exec(fresh);
  const script = /(<script data-progress-flow>[\s\S]*?<\/script>)/.exec(fresh);
  if (!section || !script) return {html, upgraded: false};
  const withSection = html.replace(
    /(\s*)(<section class="domain ddd">)/,
    (match, space, tag) => `\n\n  ${section[1]}\n\n${tag}`
  );
  if (withSection === html) return {html, upgraded: false};
  const next = withSection.replace(
    /\s*<\/body>/,
    () => `\n${script[1]}\n</body>`
  );
  return {html: next, upgraded: true};
}

function cmdProgress(root, flags) {
  const task = flags.args && flags.args[0];
  if (!isText(task)) return fail('用法：dsh-plugin-harness-cli progress <任务名> [--step N --pct 0..100] [--status ...]');
  if (!isTaskName(task)) {
    return fail(`任务名只能用字母 / 数字 / 中文 / 中划线 / 下划线（不能有空格或斜杠）：${task}`);
  }

  const ready = ensureTask(root, flags, task);
  if (ready.error) return ready.error;
  if (ready.dryRun) {
    process.stdout.write(`（dry-run）将更新 ${task} 的进度\n`);
    return 0;
  }
  const config = ready.config;
  const ctx = ready.ctx;
  const planFile = path.join(root, ctx.prototype.dir, task, 'plan.html');
  const planText = readIfExistsFile(planFile) || '';

  // 进度是事实记录，不是奖励：方案未确认 / 文档改过 / 复盘未过都不拦写入，
  // 只把这些「门禁还没过」的事实一并打印出来；真正的拦截在 check 里（P21 / P22）。
  const confirmed = /data-plan-status="已确认"/.test(planText);
  const planHash = (/data-docs-hash="([^"]*)"/.exec(planText) || [])[1] || '';
  const currentHash = docsHash(root, task, config.paths);
  const review = readReview(root, task, config.paths);
  const gateNotes = [];
  if (!confirmed) gateNotes.push('方案未确认（check 的 P21 仍是红项）');
  else if (planHash !== currentHash) gateNotes.push('方案确认后文档又被改过，确认已失效（check 的 P22 仍是红项）');
  if (!review.passed) gateNotes.push('复盘未通过（交付前仍需补 review）');

  const pageFile = path.join(root, ctx.prototype.dir, task, ctx.prototype.progressPage);
  let html = fs.readFileSync(pageFile, 'utf8');
  const flowUpgrade = ensureProgressFlow(html, config, task);
  if (flowUpgrade.upgraded) html = flowUpgrade.html;
  const pct = flags.pct === undefined ? undefined : Number(flags.pct);
  const stepNo = flags.step === undefined ? undefined : Number(flags.step);
  const status = flags.status === undefined ? undefined : String(flags.status);

  if (pct === undefined && status === undefined) {
    return fail('至少给一个更新：--step N --pct 0..100，或 --status 进行中|待验收|完成');
  }
  if (pct !== undefined) {
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) return fail('--pct 必须是 0..100 的整数');
    if (!Number.isInteger(stepNo) || stepNo < 1) return fail('--pct 需要配合 --step N（第几步）');
    let found = false;
    html = html.replace(/<li[^>]*class="[^"]*\bstep\b[^"]*"[^>]*>[\s\S]*?<\/li>/g, (block) => {
      const no = /data-step="(\d+)"/.exec(block);
      if (!no || Number(no[1]) !== stepNo) return block;
      found = true;
      return block
        .replace(/data-pct="\d+"/, `data-pct="${pct}"`)
        .replace(/(<span[^>]*class="[^"]*\bstep-pct\b[^"]*"[^>]*>)\s*\d+%\s*(<\/span>)/, `$1${pct}%$2`);
    });
    if (!found) {
      const count = readStepPcts(html).length;
      return fail(`没有第 ${stepNo} 步（任务页共 ${count} 步；先用 page 调整规划）`);
    }
  }

  if (status !== undefined) {
    if (!['进行中', '待验收', '完成'].includes(status)) {
      return fail('--status 只能是 进行中 / 待验收 / 完成');
    }
    if (status === '完成' && readStepPcts(html).some((n) => n !== 100)) {
      return refuse('还有步骤没到 100%，不能标「完成」');
    }
    html = html
      .replace(/data-task-status="[^"]*"/, `data-task-status="${status}"`)
      .replace(/(<span[^>]*data-task-status-label[^>]*>)[^<]*(<\/span>)/, `$1${status}$2`);
  }

  const total = totalOf(readStepPcts(html));
  const now = new Date().toISOString();
  const agent = String(flags.agent || '').trim();
  const note =
    String(flags.note || '').trim() ||
    (pct !== undefined ? `步骤 ${stepNo} → ${pct}%（总进度 ${total}%）` : `状态 → ${status}`);
  const stepAttrs = pct !== undefined ? ` data-step="${stepNo}" data-pct="${pct}"` : '';
  const entry = `<li data-at="${now}" data-total="${total}"${stepAttrs}>${agent ? `[${agent}] ` : ''}${note
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</li>`;

  html = html.replace(
    /(<ul[^>]*class="[^"]*\blog-list\b[^"]*"[^>]*>)([\s\S]*?)(<\/ul>)/,
    (match, open, body, close) => `${open}${body.replace(/\s+$/, '')}\n      ${entry}\n    ${close}`
  );
  html = html.replace(/(<time[^>]*data-updated[^>]*datetime=")[^"]*(">)[^<]*(<\/time>)/, `$1${now}$2${now}$3`);
  writeFileSafe(pageFile, html);

  // 队列里的同一条任务记录跟着进度走（只更新已存在的条目，不凭空建队列）。
  const currentStatus = (/data-task-status="([^"]*)"/.exec(html) || [])[1] || '进行中';
  const queue = updateTaskQueue(root, config, task, {status: currentStatus, progress: total, create: false});
  if (!queue.ok) process.stderr.write(`  任务队列更新失败：${queue.error}\n`);

  // 总览页由项目里的同步脚本重算；脚本缺失时先补回来，否则任务页更新了、总览却不动。
  const synced = syncOverview(root, config);
  if (!synced.ok) {
    process.stderr.write(`  总览页同步失败（任务页已更新）：${synced.message}\n`);
    return 2;
  }

  refreshPlans(root, config);
  process.stdout.write(`dsh-plugin-harness-cli progress → ${path.relative(root, pageFile)}\n`);
  if (pct !== undefined) process.stdout.write(`  第 ${stepNo} 步 → ${pct}%\n`);
  if (status !== undefined) process.stdout.write(`  状态 → ${status}\n`);
  process.stdout.write(`  总进度 ${total}%（已追加记录、已同步总览）\n`);
  if (flowUpgrade.upgraded) {
    process.stdout.write('  已补「步骤流程」区块（老任务页升级）\n');
  }
  if (gateNotes.length > 0) {
    for (const note of gateNotes) process.stdout.write(`  提醒：${note}\n`);
  }
  return 0;
}

/**
 * 删除任务：任务页、设计稿、数据模型、规范文档、复盘；支持一次删多个。
 * 不可逆，所以默认只「预演」并退出 1；确认后带 --yes 才真的删。
 */
function cmdDelete(root, flags) {
  const tasks = [...new Set((flags.args || []).filter((item) => isText(item)).map((item) => item.trim()))];
  if (tasks.length === 0) return fail('用法：dsh-plugin-harness-cli delete <任务名> [<任务名>...] [--yes]');
  const invalid = tasks.find((task) => !isTaskName(task));
  if (invalid !== undefined) {
    return fail(`任务名只能用字母 / 数字 / 中文 / 中划线 / 下划线（不能有空格或斜杠）：${invalid}`);
  }
  const {config} = loadConfig(root);
  const proto = (config.presets && config.presets.prototype) || {};
  const rows = tasks.map((task) => {
    const pageDir = path.join(root, proto.dir || 'prototype', task);
    const specDir = path.join(root, config.paths.specs || 'docs/specs', task);
    return {task, targets: [pageDir, specDir].filter((dir) => isDir(dir))};
  });
  const found = rows.filter((row) => row.targets.length > 0);
  if (found.length === 0) {
    return refuse(`任务不存在：${tasks.map((task) => `「${task}」`).join('、')}`);
  }

  if (!flags.yes) {
    process.stdout.write(`dsh-plugin-harness-cli delete → ${found.map((row) => row.task).join('、')}（预演，未删除）\n`);
    for (const row of rows) {
      if (row.targets.length === 0) {
        process.stdout.write(`  SKIP    ${row.task}（不存在）\n`);
        continue;
      }
      for (const dir of row.targets) process.stdout.write(`  将删除  ${toPosix(path.relative(root, dir))}/\n`);
    }
    process.stderr.write('删除不可逆：确认后加 --yes 重跑，或在对话里用弹窗确认。\n');
    return 1;
  }

  process.stdout.write(`dsh-plugin-harness-cli delete → ${found.map((row) => row.task).join('、')}\n`);
  let code = 0;
  for (const row of rows) {
    if (row.targets.length === 0) {
      process.stdout.write(`  SKIP    ${row.task}（不存在）\n`);
      code = 1;
      continue;
    }
    const result = deleteTask(root, config, row.task, {deferRefresh: true});
    for (const dir of result.removed) process.stdout.write(`  REMOVED ${dir}/\n`);
  }
  const derived = refreshDerived(root, config, {wiki: true});
  process.stdout.write(
    '  已同步：plans.html / prototype/progress.html / prototype/db.html / db-layout.json / docs/wiki\n'
  );
  if (derived.wiki && derived.wiki.status !== 0) {
    process.stderr.write(`  WARN    docs/wiki 同步失败（wiki 退出码 ${derived.wiki.status}）；任务删除已完成\n`);
  }
  return code;
}

function readIfExistsFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

function cmdAgents(root, flags) {
  const {config} = loadConfig(root);
  const {name: configFile} = resolveConfigFile(root);
  const content = renderAgents(config, {configFile});
  const verdict = lineVerdict(content.split('\n').length - 1);

  if (flags.stdout) {
    process.stdout.write(content);
    return verdict.level === 'error' ? 1 : 0;
  }

  const result = generate(root, config, {force: flags.force, dryRun: flags.dryRun, configFile});
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({root, file: config.paths.agents, action: result.action, lines: result.lines, verdict}, null, 2)}\n`
    );
    return verdict.level === 'error' ? 1 : 0;
  }
  process.stdout.write(`dsh-plugin-harness-cli agents → ${root}\n`);
  process.stdout.write(`  ${pad(PLAN_TAG[result.action] || result.action.toUpperCase(), 7)} ${config.paths.agents}  ${verdict.message}\n`);
  if (verdict.level !== 'ok') process.stdout.write(`  ${verdict.message}：把细节拆到 docs/，入口只留链接\n`);
  return verdict.level === 'error' ? 1 : 0;
}

function cmdCheck(root, flags) {
  const {config} = loadConfig(root);
  const result = runChecks(root, config);
  const failed = result.summary.errors > 0 || (flags.strict && result.summary.warnings > 0);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({...result, strict: Boolean(flags.strict), failed}, null, 2)}\n`);
  } else {
    process.stdout.write(`${printChecks('dsh-plugin-harness-cli check', result.root, result)}\n`);
  }
  return failed ? 1 : 0;
}

function cmdDoctor(root, flags) {
  const result = runDoctor(root);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const lines = [`dsh-plugin-harness-cli doctor → ${result.root}`];
    for (const c of result.checks) {
      lines.push(`  ${pad(LEVEL_TAG[c.level] || c.level, 5)} ${pad(c.name, 10)} ${c.detail}`);
    }
    const s = result.summary;
    lines.push('');
    lines.push(`合计 ${s.total} 项：错误 ${s.errors}，警告 ${s.warnings}。`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return result.summary.errors > 0 ? 2 : 0;
}

/**
 * plans：在根目录生成任务总览 plans.html（列表 / 展开编辑 / UI 预览 / 删除 / 重跑）。
 * `--serve` 起一个只监听本机的 HTTP 服务，页面上的按钮才会真正落盘。
 */
/** plans 服务的状态文件：记录端口与 pid，供 --stop / 重复 --serve 使用。 */
function plansStateFile(root, config) {
  return path.join(root, config.paths.harness || '.harness', 'plans-server.json');
}

function readPlansState(root, config) {
  const file = plansStateFile(root, config);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function stopPlansServer(root, config) {
  const state = readPlansState(root, config);
  const file = plansStateFile(root, config);
  if (state === null || !Number.isInteger(state.pid)) {
    if (exists(file)) fs.rmSync(file, {force: true});
    return {ok: false, message: '没有正在运行的 plans 服务'};
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (err) {
    // 进程可能已经退出：清掉状态文件即可
  }
  if (exists(file)) fs.rmSync(file, {force: true});
  return {ok: true, message: `已停止 plans 服务（pid ${state.pid}，端口 ${state.port}）`};
}

/** 找出本机监听某端口的进程 PID（查不到返回空数组）。 */
function portOwnerPids(port) {
  const pids = new Set();
  const add = (value) => {
    const pid = Number(value);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  };
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano'], {encoding: 'utf8'}).stdout || '';
    for (const match of out.matchAll(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'g'))) {
      add(match[1]);
    }
    return [...pids];
  }
  const lsof = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
  if (lsof.status === 0 && lsof.stdout) {
    for (const line of lsof.stdout.split('\n')) if (line.trim()) add(line.trim());
  }
  if (pids.size === 0) {
    const ss = spawnSync('ss', ['-ltnp', `sport = :${port}`], {encoding: 'utf8'});
    for (const match of String(ss.stdout || '').matchAll(/pid=(\d+)/g)) add(match[1]);
  }
  return [...pids];
}

/** 同步小睡：给被结束的进程一点退出时间，避免紧接着 bind 还是 EADDRINUSE。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (err) {
    // 环境不支持就跳过，靠 servePlans 的报错兜底
  }
}

function cmdPlans(root, flags) {
  let config;
  try {
    config = loadConfig(root).config;
  } catch (error) {
    return fail(error.message);
  }

  const args = flags.args || [];
  const subcommand = args[0] === 'serve' || args[0] === 'stop' ? args[0] : undefined;

  if (flags.stop || subcommand === 'stop') {
    const result = stopPlansServer(root, config);
    (result.ok ? process.stdout : process.stderr).write(`${result.message}\n`);
    return result.ok ? 0 : 1;
  }

  if (flags.serve || subcommand === 'serve') {
    // 只认一个参数：端口。省略 = 0，由系统分配一个空闲的安全端口。
    const rawPort = subcommand === 'serve' ? args[1] : flags.port;
    const port = rawPort === undefined ? 0 : Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return fail('端口必须是 0..65535');

    // 先结束上一次的 plans 服务；指定了固定端口时，再把占着它的进程清掉
    const previous = readPlansState(root, config);
    if (previous && Number.isInteger(previous.pid)) {
      const stopped = stopPlansServer(root, config);
      if (stopped.ok) process.stdout.write(`  ${stopped.message}\n`);
    }
    if (port !== 0) {
      const owners = portOwnerPids(port);
      for (const pid of owners) {
        try {
          process.kill(pid, 'SIGKILL');
          process.stdout.write(`  端口 ${port} 被 pid ${pid} 占用，已强制结束\n`);
        } catch (err) {
          process.stderr.write(`  端口 ${port} 的 pid ${pid} 结束失败：${err.message}\n`);
        }
      }
      if (owners.length > 0) sleepSync(200);
    }

    servePlans(root, config, port)
      .then(({port: actual}) => {
        const stateFile = plansStateFile(root, config);
        try {
          writeFileSafe(stateFile, `${JSON.stringify({pid: process.pid, port: actual, startedAt: new Date().toISOString()}, null, 2)}\n`);
        } catch (err) {
          // 状态文件写不进去不影响服务本身
        }
        const cleanup = () => {
          try {
            if (exists(stateFile)) fs.rmSync(stateFile, {force: true});
          } catch (err) {
            // 清理失败不阻塞退出
          }
          process.exit(0);
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        process.stdout.write(`dsh-plugin-harness-cli plans serve → http://127.0.0.1:${actual}/\n`);
        process.stdout.write('  只监听本机、无鉴权；Ctrl+C 停止。删除 / 重跑 / 保存会直接改仓库文件。\n');
      })
      .catch((error) => {
        process.stderr.write(`启动 plans 服务失败：${error.message}\n`);
        process.exitCode = 2;
      });
    return 0;
  }

  if (!refreshPlans(root, config)) return fail('无法写入 plans.html');
  const tasks = collectTasks(root, config);
  process.stdout.write(`dsh-plugin-harness-cli plans → ${path.relative(root, path.join(root, 'plans.html'))}\n`);
  process.stdout.write(`  ${tasks.length} 个任务（展开可编辑文档；plans serve 后按钮可直接删除 / 重跑 / 保存）\n`);
  return 0;
}

/**
 * wiki：生成 / 更新 docs/wiki。
 *
 * - 默认 merge：受管区块与上次生成做三路合并，人工段落保留、事实刷新；
 *   没有受管区块的既有文档补区块并原样保留正文。
 * - auto / --update：整块重写受管区块（人工段落会被覆盖）。
 * - keep / --keep：只创建缺失文件。
 * 只有「受管区块标记不完整」才报冲突并返回 1。
 */
function cmdWiki(root, flags) {
  const {config} = loadConfig(root);
  const dir = flags.dir || config.paths.wiki || 'docs/wiki';
  const rawMode = flags.wikiMode || (config.wiki && config.wiki.mode) || 'merge';
  // ask 是旧默认名，语义等同增量合并（不再逐个询问）
  const mode = rawMode === 'ask' ? 'merge' : rawMode;

  if (mode !== 'merge' && mode !== 'auto' && mode !== 'keep') {
    return fail(`未知的 wiki 模式：${mode}（可用：merge / auto / keep）`);
  }

  if (flags.check) {
    const status = wikiStatus(root, {dir});
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({root, dir, ...status}, null, 2)}\n`);
    } else {
      process.stdout.write(`dsh-plugin-harness-cli wiki --check → ${root}\n`);
      process.stdout.write(`  目录：${dir}${status.exists ? '' : '（不存在）'}\n`);
      if (status.missing.length) process.stdout.write(`  缺少：${status.missing.join(', ')}\n`);
      if (status.stale.length) process.stdout.write(`  过期（重跑会合并事实）：${status.stale.join(', ')}\n`);
      if (status.adoptable.length) {
        process.stdout.write(`  待接管（无受管区块；重跑会补区块并原样保留正文）：${status.adoptable.join(', ')}\n`);
      }
      if (status.conflicts.length) {
        process.stdout.write(`  冲突（受管区块标记不完整，需手工修）：${status.conflicts.join(', ')}\n`);
      }
      if (
        !status.missing.length &&
        !status.stale.length &&
        !status.adoptable.length &&
        !status.conflicts.length
      ) {
        process.stdout.write('  全部为最新 ✓\n');
      }
    }
    return status.missing.length || status.stale.length || status.adoptable.length || status.conflicts.length ? 1 : 0;
  }

  const result = applyWiki(root, {mode, dryRun: flags.dryRun, dir});
  const byAction = (name) => result.entries.filter((entry) => entry.action === name);

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({root, dir, mode, dryRun: Boolean(flags.dryRun), files: result.entries}, null, 2)}\n`
    );
    return result.conflicts.length ? 1 : 0;
  }

  process.stdout.write(`dsh-plugin-harness-cli wiki → ${root}\n`);
  if (result.entries.length === 0) {
    process.stdout.write('  没有可生成的文档（项目里既没有配置也没有代码结构？）\n');
    return 0;
  }
  for (const entry of result.entries) {
    const tag = PLAN_TAG[entry.action] || entry.action.toUpperCase();
    const reason = entry.reason ? `（${entry.reason}）` : '';
    process.stdout.write(`  ${pad(tag, 9)} ${dir}/${entry.name}${reason}\n`);
  }
  const parts = [
    flags.dryRun ? '（dry-run，未落盘）' : `已写入 ${result.changed} 篇`,
    `跳过 ${byAction('keep').length} 篇`,
  ];
  if (result.kept > 0) parts.push(`保留人工段落 ${result.kept} 处`);
  if (result.conflicts.length > 0) parts.push(`冲突 ${result.conflicts.length} 篇`);
  process.stdout.write(`\n${parts.join('；')}\n`);

  // 业务文档变了，任务的 proposal 也要跟着更新（写回受管区块 + 指纹）
  if (flags.dryRun) return result.conflicts.length ? 1 : 0;
  const facts = collectFacts(root);
  const proposalSync = syncProposalFromWiki(root, config.paths, () => ({
    project: `${facts.project.name} v${facts.project.version}`,
    domains: facts.domains.map((item) => item.name).join(' / ') || '—',
    counts: `${facts.counts.features} 条功能（进行中 ${facts.counts.inProgress}，完成 ${facts.counts.done}）`,
  }));
  if (proposalSync.action === 'updated') {
    process.stdout.write(`  已同步 ${proposalSync.tasks.length} 个任务的 docs/specs/<任务>/proposal.md（业务背景区块）\n`);
  }

  // 生成只是第一步：再反推一遍工作区，把仍无法推导的位置列出来
  const gaps = wikiGaps(root, dir);
  const gapsFile = writeGapReport(root, dir, gaps);
  const writtenNow = result.entries.filter(
    (entry) => entry.action === 'create' || entry.action === 'update' || entry.action === 'merge' || entry.action === 'adopt'
  ).length;
  const writeSummary = writtenNow > 0 ? `按当前仓库写入 ${writtenNow} 篇` : '本次没有写入任何文档';
  process.stdout.write(`  反推工作区：${writeSummary}；仍需人工确认：${gaps.length} 处（清单：${gapsFile}）\n`);
  for (const gap of gaps.slice(0, 8)) {
    process.stdout.write(`    - ${gap.file}:${gap.line}  ${gap.text.slice(0, 80)}\n`);
  }
  if (gaps.length > 8) process.stdout.write(`    … 其余 ${gaps.length - 8} 处见文件\n`);

  if (result.conflicts.length) {
    process.stderr.write(
      `有 ${result.conflicts.length} 篇受管区块标记不完整（只有开始或只有结束）：${result.conflicts.map((item) => item.name).join(', ')}。` +
        '先手工补全标记，再重跑 wiki。\n'
    );
    return 1;
  }
  return 0;
}

/**
 * ux：用户体验与需求分析。
 *
 * - 默认：分析全部任务 + 项目需求，生成 prototype/ux.html（整体）+ 每个任务的 ux/index.html；
 * - --user-words：新增需求并入 docs/ux/requirements.md，后续重跑不会丢；
 * - --resolve：逐条关闭待确认项，写 prototype/.ux-resolved.json，重跑仍保持关闭；
 * - --apply：把结论写回选中任务与它们的关联任务（受管区块，可重复执行）。
 */
function cmdUx(root, flags) {
  let config;
  try {
    config = loadConfig(root).config;
  } catch (error) {
    return fail(error.message);
  }

  const tasks = (flags.args || []).filter((arg) => !String(arg).startsWith('-'));
  const userWords = typeof flags.userWords === 'string' ? flags.userWords : '';
  const resolveIds = [
    ...new Set(
      [].concat(flags.resolve || []).flatMap((value) =>
        String(value)
          .split(/[,，\s]+/)
          .filter(Boolean)
      )
    ),
  ];

  let facts;
  try {
    // 整体报告永远覆盖全部任务；tasks 只决定 --apply 回写谁。
    facts = collectUxFacts(root, config, {tasks, userWords});
  } catch (error) {
    // 未知任务 / 没有可分析内容属于业务前置条件，用 1 与 check 的语义对齐
    return refuse(error.message);
  }

  let requirementsSaved = null;
  if (!flags.dryRun) requirementsSaved = saveUxRequirements(root, config, facts);

  if (resolveIds.length > 0) {
    if (flags.dryRun) {
      process.stdout.write(`（dry-run）将关闭待确认项：${resolveIds.join('、')}\n`);
      return 0;
    }
    const resolved = resolveUxGaps(root, config, resolveIds, flags.by || '用户');
    facts = collectUxFacts(root, config, {tasks});
    const files = writeUxReports(root, config, facts);
    refreshPlans(root, config);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({root, files, resolve: resolved, summary: facts.summary}, null, 2)}\n`);
      return resolved.unknown.length > 0 ? 1 : 0;
    }
    process.stdout.write(`dsh-plugin-harness-cli ux --resolve → ${root}\n`);
    for (const gap of resolved.resolved) {
      process.stdout.write(`  CLOSED  ${gap.id} ${gap.task}：${gap.item}\n`);
    }
    for (const id of resolved.already) process.stdout.write(`  ALREADY ${id}（已经是关闭状态）\n`);
    for (const id of resolved.unknown) process.stdout.write(`  UNKNOWN ${id}（当前没有这条待确认项）\n`);
    process.stdout.write(
      `  关闭 ${resolved.resolved.length} 项；记录：${resolved.path}；剩余 ${facts.summary.gaps} 项（阻断 ${facts.summary.blocking} 项）\n`
    );
    return resolved.unknown.length > 0 ? 1 : 0;
  }

  if (flags.apply) {
    if (tasks.length === 0) return fail('--apply 需要任务名：ux --apply <任务名...>');
    if (flags.dryRun) {
      process.stdout.write(`（dry-run）将把 UX 复核区块写入 ${tasks.length} 个任务的 design.md（含直接关联任务）\n`);
      return 0;
    }
    const result = applyUxContext(root, config, facts, tasks);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({root, apply: result}, null, 2)}\n`);
      return result.updated.length + result.unchanged.length > 0 ? 0 : 1;
    }
    process.stdout.write(`dsh-plugin-harness-cli ux --apply → ${root}\n`);
    for (const task of result.updated) {
      process.stdout.write(`  SYNC    ${config.paths.specs || 'docs/specs'}/${task}/design.md（UX 复核区块）\n`);
    }
    for (const task of result.skipped) {
      process.stdout.write(`  SKIP    ${task}（缺少 design.md，先跑 page ${task}）\n`);
    }
    if (result.related.length > 0) {
      process.stdout.write(`  关联任务同步：${result.related.join('、')}\n`);
    }
    process.stdout.write(
      `  已更新 ${result.updated.length} 个任务；未变化 ${result.unchanged.length} 个；跳过 ${result.skipped.length} 个\n`
    );
    return result.updated.length + result.unchanged.length > 0 ? 0 : 1;
  }

  if (flags.dryRun) {
    const protoDir = (config.presets && config.presets.prototype && config.presets.prototype.dir) || 'prototype';
    process.stdout.write(
      `（dry-run）将写入 ${protoDir}/ux.html、${protoDir}/ux.json、${protoDir}/.ux-gaps.json` +
        `，以及 ${facts.tasks.length} 个任务的 ${protoDir}/<任务>/ux/index.html\n`
    );
    if (facts.newRequirements.length > 0) {
      process.stdout.write(`（dry-run）会把 ${facts.newRequirements.length} 条新需求并入 ${facts.requirementsPath}\n`);
    }
    return 0;
  }

  const files = writeUxReports(root, config, facts);
  // 报告写完后刷新总览页：操作栏的「UX / 整体 UX」按钮依赖 hasUx 与 uxPage
  if (!refreshPlans(root, config)) {
    process.stderr.write('  plans.html 同步失败（UX 报告已写入）；重跑 dsh-plugin-harness-cli plans\n');
  }

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {root, files, summary: facts.summary, gaps: facts.gaps, blocking: facts.blockingGaps, resolved: facts.resolvedGaps},
        null,
        2
      )}\n`
    );
    return 0;
  }

  process.stdout.write(`dsh-plugin-harness-cli ux → ${root}\n`);
  process.stdout.write(`  整体报告：${files.global.html}（数据：${files.global.json}）\n`);
  process.stdout.write(`  任务报告：${files.tasks.length} 份（${files.tasks.map((task) => task.name).join('、')}）\n`);
  process.stdout.write(`  范围：${facts.scopeLabel}\n`);
  if (requirementsSaved) process.stdout.write(`  项目需求已并入：${requirementsSaved}\n`);
  process.stdout.write(
    `  需求 ${facts.summary.requirements} 条；维度已分析 ${facts.summary.dimensionsDone}/${facts.summary.dimensionsTotal}；` +
      `可用性检查：通过 ${facts.summary.pass} / 待补 ${facts.summary.todo}\n`
  );
  if (facts.summary.relations > 0) {
    process.stdout.write(`  关联任务：${facts.summary.relations} 组（--apply 会一并刷新关联任务）\n`);
  }
  if (facts.summary.resolved > 0) {
    process.stdout.write(`  已确认关闭：${facts.summary.resolved} 项（记录：${files.global.resolutions}）\n`);
  }
  if (facts.blockingGaps.length > 0) {
    process.stdout.write(
      `  UX 分析仍需补全：${facts.blockingGaps.length} 处阻断（共 ${facts.gaps.length} 处待确认；整体清单：${files.global.gaps}）\n`
    );
    for (const gap of facts.blockingGaps.slice(0, 5)) {
      process.stdout.write(`    - [${gap.level}] ${gap.id} ${gap.task}：${gap.item}（${gap.hint}）\n`);
    }
    if (facts.blockingGaps.length > 5) {
      process.stdout.write(`    … 其余 ${facts.blockingGaps.length - 5} 处见清单\n`);
    }
  } else {
    process.stdout.write(
      `  UX 分析：没有阻断性缺口（共 ${facts.gaps.length} 处建议补全；整体清单：${files.global.gaps}）\n`
    );
  }
  process.stdout.write(
    `  下一步：补完一条重跑 ux 会自动移除；已确认的用 ux --resolve <编号>，` +
      `更新任务用 ux --apply <任务名>（含关联任务）\n`
  );
  return 0;
}

/**
 * 任务页能力没开就自动补上：任务开始执行时，prototype/ 必须真的存在。
 * 复用 init 的生成逻辑（只补缺失文件、状态文件不覆盖），并在配置里回写开关。
 * @returns {{config: object} | {error: number} | {dryRun: true}}
 */
function ensurePreset(root, flags) {
  const {config} = loadConfig(root);
  if (config.presets && config.presets.prototype && config.presets.prototype.enabled) {
    // 能力开着、但同步脚本被删过（老项目或手工清理）：先补回，否则每次同步都只剩堆栈
    if (!flags.dryRun) ensurePrototypeCheck(root, config);
    return {config};
  }
  if (flags.dryRun) {
    process.stdout.write('（dry-run）任务页能力未开启：将先跑 init --preset prototype 补齐 prototype/\n');
    return {dryRun: true};
  }
  process.stdout.write('任务页能力未开启：先自动补齐 prototype/ 与 docs/specs/ 约定\n');
  const code = cmdInit(root, {
    preset: 'prototype',
    dryRun: false,
    force: false,
    forceState: false,
    json: false,
    args: [],
  });
  if (code !== 0) return {error: code};
  return {config: loadConfig(root).config};
}

function cmdPage(root, flags) {
  const task = flags.args[0];
  if (!isText(task)) return fail('用法：dsh-plugin-harness-cli page <任务名>');
  if (!isTaskName(task)) {
    return fail(`任务名只能用字母 / 数字 / 中文 / 中划线 / 下划线（不能有空格或斜杠）：${task}`);
  }

  const boot = ensurePreset(root, flags);
  if (boot.error) return boot.error;
  if (boot.dryRun) {
    process.stdout.write(`（dry-run）将创建 ${task} 的任务页与规范文档\n`);
    return 0;
  }
  const ctx = buildContext(boot.config, {task, userWords: flags.userWords || ''});
  const config = boot.config;

  const file = path.join(root, ctx.prototype.dir, task, ctx.prototype.progressPage);
  const pageExists = exists(file);

  const content = render(loadTemplate('progressHtml'), {...ctx, today: today()});

  // 规范文档跟着任务一起落盘：proposal / spec / design / tasks（已存在的一律不覆盖）。
  const specsDir = path.join(root, ctx.paths.specs || 'docs/specs', task);
  const specFiles = [
    ['flow.md', 'flow'],
    ['proposal.md', 'specProposal'],
    ['spec.md', 'specSpec'],
    ['design.md', 'specDesign'],
    ['tasks.md', 'specTasks'],
  ].map(([name, key]) => ({
    name,
    abs: path.join(specsDir, name),
    content: render(loadTemplate(key), {...ctx, today: today()}),
    exists: exists(path.join(specsDir, name)),
  }));

  const planFile = path.join(root, ctx.prototype.dir, task, 'plan.html');
  if (pageExists && !flags.force) {
    // 页面已经在了：不覆盖，但把缺失的规范文档与方案页补齐（老任务升级 / 补文档的入口）。
    const pending = specFiles.filter((spec) => !spec.exists);
    if (pending.length === 0) {
      process.stdout.write(`dsh-plugin-harness-cli page → ${file}（已存在，未改动）\n`);
      return 0;
    }
    if (flags.dryRun) {
      for (const spec of pending) process.stdout.write(`（dry-run）将写入 ${spec.abs}\n`);
      return 0;
    }
    process.stdout.write(`dsh-plugin-harness-cli page → ${file}（已存在，只补规范文档）\n`);
    for (const spec of pending) {
      writeFileSafe(spec.abs, spec.content);
      process.stdout.write(`  CREATE  ${path.relative(root, spec.abs)}\n`);
    }
    if (!exists(planFile)) {
      writeFileSafe(planFile, render(loadTemplate('prototypePlan'), ctx));
      process.stdout.write(`  CREATE  ${path.relative(root, planFile)}（方案页，确认后才开工）\n`);
    }
    return 0;
  }

  if (flags.dryRun) {
    process.stdout.write(`（dry-run）将写入 ${file}\n`);
    for (const spec of specFiles) {
      if (!spec.exists) process.stdout.write(`（dry-run）将写入 ${spec.abs}\n`);
    }
    return 0;
  }

  writeFileSafe(file, content);
  process.stdout.write(`dsh-plugin-harness-cli page → ${file}\n`);
  for (const spec of specFiles) {
    if (spec.exists) {
      process.stdout.write(`  KEEP    ${path.relative(root, spec.abs)}（已存在，不覆盖）\n`);
      continue;
    }
    writeFileSafe(spec.abs, spec.content);
    process.stdout.write(`  CREATE  ${path.relative(root, spec.abs)}\n`);
  }
  if (!exists(planFile)) {
    writeFileSafe(planFile, render(loadTemplate('prototypePlan'), ctx));
    process.stdout.write(`  CREATE  ${path.relative(root, planFile)}（方案页，确认后才开工）\n`);
  }

  // 新建页会改变「进行中任务」集合，顺手同步总览页；同步失败不回滚页面，但要让调用方知道。
  const synced = syncOverview(root, config);
  if (!synced.ok) {
    process.stderr.write(`  总览页同步失败（任务页已写入）：${synced.message}\n`);
    return 2;
  }
  if (synced.out) process.stdout.write(`  ${synced.out.split('\n').join('\n  ')}\n`);
  refreshPlans(root, config);
  process.stdout.write(
    `  下一步：先完善 ${path.join(ctx.paths.specs, task)}/*.md（人可改），再跑 review ${task} 复盘，` +
      `最后 plan ${task} --confirm --by "确认人" 确认后才能推进度\n`
  );
  return 0;
}

async function main(argv) {
  // style 的参数属于另一个工具，原样透传，不能被本工具的 flag 解析吃掉
  if (argv[0] === 'style') {
    const rest = argv.slice(1);
    if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return rest.length === 0 ? 2 : 0;
    }
    return style.run(rest);
  }

  const {command, args, flags, unknown} = parseArgs(argv);
  const root = resolveRoot(flags);

  if (command === 'help' && args.length > 0 && isProcessTopic(args[0])) {
    process.stdout.write(`${PROCESS_TEXT}\n`);
    return 0;
  }
  if (flags.help || command === 'help' || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined && argv.length > 0 ? 2 : 0;
  }
  if (flags.version || command === 'version') {
    process.stdout.write(`dsh-plugin-harness-cli ${VERSION}\n`);
    return 0;
  }
  if (unknown.length) return fail(unknown.join('；'));
  if (!['init', 'agents', 'page', 'plan', 'review', 'progress', 'ui', 'sql', 'delete', 'check', 'doctor', 'wiki', 'plans', 'ux'].includes(command)) {
    return fail(
      `未知命令：${command}（可用：init / agents / page / plan / review / progress / ui / sql / delete / check / doctor / wiki / plans / ux / style / version）`
    );
  }

  try {
    if (command === 'init') return cmdInit(root, flags);
    if (command === 'agents') return cmdAgents(root, flags);
    if (command === 'page') return cmdPage(root, {...flags, args});
    if (command === 'plan') return cmdPlan(root, {...flags, args});
    if (command === 'review') return cmdReview(root, {...flags, args});
    if (command === 'progress') return cmdProgress(root, {...flags, args});
    if (command === 'ui') return cmdUi(root, {...flags, args});
    if (command === 'sql') return cmdSql(root, {...flags, args});
    if (command === 'delete') return cmdDelete(root, {...flags, args});
    if (command === 'check') return cmdCheck(root, flags);
    if (command === 'wiki') return cmdWiki(root, flags);
    if (command === 'ux') return cmdUx(root, {...flags, args});
    if (command === 'plans') return cmdPlans(root, {...flags, args});
    return cmdDoctor(root, flags);
  } catch (err) {
    process.stderr.write(`dsh-plugin-harness-cli ${command} 失败：${err && err.message ? err.message : err}\n`);
    return 2;
  }
}

module.exports = {main, parseArgs, USAGE, VERSION};
