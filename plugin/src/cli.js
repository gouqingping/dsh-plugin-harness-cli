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
const {refreshPlans, collectTasks, servePlans} = require('./plans');
const {defaultModel, mergeFlags, renderDocs, applyToPage, applyToPlan} = require('./specs');
const {loadTemplate} = require('./templates');
const {render} = require('./render');
const {exists, isDir, isText, isTaskName, writeFileSafe, today} = require('./util');

const VERSION = require('../package.json').version;

const USAGE = `dsh-plugin-harness-cli ${VERSION} —— 公共项目配置工具（Harness 规范）

用法：
  dsh-plugin-harness-cli init [--preset prototype] [--force] [--force-state] [--dry-run]
  dsh-plugin-harness-cli agents [--stdout] [--force] [--dry-run]
  dsh-plugin-harness-cli page <任务名> [--user-words "原话"]
  dsh-plugin-harness-cli review [任务名] [--agent <标识>]        # 复盘 docs/specs 与任务页（省略任务名=最近的任务）
  dsh-plugin-harness-cli plan [任务名] [--confirm --by "确认人"] [--user-words "原话"]
  dsh-plugin-harness-cli progress <任务名> [--step N --pct 0..100] [--status 进行中|待验收|完成] [--note "说明"]
  dsh-plugin-harness-cli ui [任务名] [--user-words "原话"] [--force]   （省略任务名=最近的任务）
  dsh-plugin-harness-cli check [--strict] [--json]
  dsh-plugin-harness-cli doctor [--json]
  dsh-plugin-harness-cli plans [--serve] [--port 7788] [--stop]   # 根目录 plans.html：任务总览与操作台
  dsh-plugin-harness-cli wiki [--update|--keep|--ask] [--check] [--dry-run] [--json]
  dsh-plugin-harness-cli style <harness-style 参数...>
  dsh-plugin-harness-cli version | help

style 子命令把参数原样转给随包的 harness-style（代码风格 / 提交信息判定）：
  style doctor | style check --staged | style fix --staged | style commit-msg <file>
  style init --lang py,ts | style install-hooks

ui 生成 / 更新任务页的 UI 设计稿（Ant Design v5 风格，落在 prototype/<task>/ui/）：
  --force       覆盖已存在的设计稿（默认不覆盖）
  --dry-run     只打印将写入的文件

wiki 生成 / 更新 docs/wiki（13 篇业务文档）：
  --update      受管区块一律更新（--auto 同义）
  --keep        只创建缺失文件，冲突文件保留不写
  --ask         冲突时逐个询问（默认；非交互环境视为保留并以退出码 1 报告）
  --check       只报告：缺失 / 过期 / 冲突，不写盘

通用参数：
  --root <dir>   目标仓库根目录（默认 cwd）
  --json         机器可读输出
  --dry-run      只打印将发生的动作，不落盘
  --force        覆盖已存在的非空结构文件（默认永不覆盖）
  --force-state  连同状态文件一起覆盖（进度日志 / 功能清单 / 任务队列，慎用）

退出码：0 通过 / 1 有违规 / 2 工具或用法有错`;

const PLAN_TAG = {create: 'CREATE', overwrite: 'WRITE', keep: 'KEEP', append: 'APPEND', update: 'UPDATE', conflict: 'CONFLICT'};
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
  const repeatable = new Set(['term', 'aggregate', 'invariant', 'contract', 'accept', 'step', 'non-goal']);
  const valueFlags = new Set([
    'root', 'preset', 'user-words', 'dir', 'step', 'pct', 'status', 'note', 'agent', 'by',
    'goal', 'scope', 'context', 'term', 'aggregate', 'invariant', 'contract', 'accept', 'non-goal', 'input-json',
    'port',
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
    else if (key === 'update' || key === 'auto') flags.wikiMode = 'auto';
    else if (key === 'keep') flags.wikiMode = 'keep';
    else if (key === 'ask') flags.wikiMode = 'ask';
    else if (key === 'check') flags.check = true;
    else if (key === 'confirm') flags.confirm = true;
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

  // 让总览页的「UI」列立即正确
  const sync = spawnSync(process.execPath, [path.join(root, config.paths.prototypeCheck), '--sync'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (sync.status !== 0) {
    process.stderr.write(`  总览页同步失败（UI 稿已写入）：${(sync.stderr || sync.stdout || '').trim()}\n`);
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

/** 规范文档的顺序固定：指纹与复盘都以这个顺序计算。 */
const SPEC_DOC_FILES = ['proposal.md', 'spec.md', 'design.md', 'tasks.md'];

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
  if (!exists(pageFile)) {
    const code = cmdPage(root, {
      args: [task],
      userWords: flags.userWords,
      force: false,
      dryRun: false,
      json: false,
    });
    if (code !== 0) return {error: code};
  }
  const planFile = path.join(root, ctx.prototype.dir, task, 'plan.html');
  if (!exists(planFile)) {
    writeFileSafe(planFile, render(loadTemplate('prototypePlan'), ctx));
    process.stdout.write(`  CREATE  ${path.relative(root, planFile)}（方案页，确认后才开工）\n`);
  }
  return {config: boot.config, ctx};
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
 * plan：任务方案页（先定方案，再开工）。
 * 生成 `prototype/<任务>/plan.html`；`--confirm --by <人>` 把状态改为「已确认」。
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
  // 用模型把 docs/specs 四份文档、任务页与方案页一次补全（人随时可以改）
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

  const pageFile = path.join(root, ready.ctx.prototype.dir, task, ready.ctx.prototype.progressPage);
  const pageHtml = readIfExistsFile(pageFile) || '';
  const total = totalOf(readStepPcts(pageHtml));
  let pageAction = 'KEEP';
  if (pageHtml.length > 0 && (total === 0 || flags.force)) {
    writeFileSafe(pageFile, applyToPage(pageHtml, model));
    pageAction = 'WRITE';
    rows.push(`  ${pageAction}   ${path.relative(root, pageFile)}（契约 / 用例 / 规划已同步）`);
  } else if (pageHtml.length === 0) {
    pageAction = 'MISSING';
  } else {
    rows.push(`  KEEP    ${path.relative(root, pageFile)}（已有进度 ${total}%，不覆盖；要重写加 --force）`);
  }

  const planHtml = readIfExistsFile(planFile) || '';
  if (planHtml.length > 0 && (!/data-plan-status="已确认"/.test(planHtml) || flags.force)) {
    model.hasUi = exists(path.join(root, ready.ctx.prototype.dir, task, 'ui', 'index.html'));
    writeFileSafe(planFile, applyToPlan(planHtml, model));
    rows.push(`  WRITE   ${path.relative(root, planFile)}（目标 / 方案 / 流程 / 风险 / 验收已同步）`);
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
  process.stdout.write(`  规范文档：写入 ${written} 篇，保留 ${kept} 篇\n`);
  }

  if (flags.confirm) {
    const by = String(flags.by || '').trim();
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
      .replace(/data-confirmed-by="[^"]*"/, `data-confirmed-by="${safeBy}"`)
      .replace(/data-confirmed-at="[^"]*"/, `data-confirmed-at="${now}"`)
      .replace(/data-docs-hash="[^"]*"/, `data-docs-hash="${hash}"`)
      .replace(/data-plan-status-label>待确认</, 'data-plan-status-label>已确认<')
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
  if (!/data-plan-status="已确认"/.test(planText)) {
    return refuse(`方案未确认：先跑 dsh-plugin-harness-cli plan ${task} --confirm --by "确认人" 再推进度`);
  }

  // 确认只对「当时的文档」有效：文档改过就必须重新复盘 + 重新确认
  const planHash = (/data-docs-hash="([^"]*)"/.exec(planText) || [])[1] || '';
  const currentHash = docsHash(root, task, config.paths);
  if (planHash !== currentHash) {
    return refuse(
      `docs/specs/${task}/ 在方案确认后被改过：重新跑 review ${task} 与 plan ${task} --confirm --by "确认人" 再推进度`
    );
  }
  const review = readReview(root, task, config.paths);
  if (!review.passed) {
    return refuse(`复盘未通过：先跑 review ${task} 并完成人工确认`);
  }

  const pageFile = path.join(root, ctx.prototype.dir, task, ctx.prototype.progressPage);
  let html = fs.readFileSync(pageFile, 'utf8');
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
  const entry = `<li data-at="${now}" data-total="${total}">${agent ? `[${agent}] ` : ''}${note
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</li>`;

  html = html.replace(
    /(<ul[^>]*class="[^"]*\blog-list\b[^"]*"[^>]*>)([\s\S]*?)(<\/ul>)/,
    (match, open, body, close) => `${open}${body.replace(/\s+$/, '')}\n      ${entry}\n    ${close}`
  );
  html = html.replace(/(<time[^>]*data-updated[^>]*datetime=")[^"]*(">)[^<]*(<\/time>)/, `$1${now}$2${now}$3`);
  writeFileSafe(pageFile, html);

  const sync = spawnSync(process.execPath, [path.join(root, config.paths.prototypeCheck), '--sync'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (sync.status !== 0) {
    process.stderr.write(`  总览页同步失败（任务页已更新）：${(sync.stderr || sync.stdout || '').trim()}\n`);
    return 2;
  }

  refreshPlans(root, config);
  process.stdout.write(`dsh-plugin-harness-cli progress → ${path.relative(root, pageFile)}\n`);
  if (pct !== undefined) process.stdout.write(`  第 ${stepNo} 步 → ${pct}%\n`);
  if (status !== undefined) process.stdout.write(`  状态 → ${status}\n`);
  process.stdout.write(`  总进度 ${total}%（已追加记录、已同步总览）\n`);
  return 0;
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

/** 同步读一行（仅在 TTY 下用；非 TTY 由调用方按「保留」处理）。 */
function askSync(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(64);
  try {
    const n = fs.readSync(process.stdin.fd, buf, 0, buf.length, null);
    return buf.toString('utf8', 0, n).trim().toLowerCase();
  } catch (err) {
    return 'n';
  }
}

/**
 * wiki：生成 / 更新 docs/wiki。
 *
 * 冲突（受管区块被人工改过）的处理取决于模式：
 * - ask（默认）：TTY 下逐个询问；非 TTY 视为保留，退出码 1 并在 stderr 给出下一步。
 * - auto（--update）：一律覆盖受管区块，区块外内容仍然不动。
 * - keep（--keep）：只创建缺失文件，冲突文件保留。
 */
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

function cmdPlans(root, flags) {
  let config;
  try {
    config = loadConfig(root).config;
  } catch (error) {
    return fail(error.message);
  }

  if (flags.stop) {
    const result = stopPlansServer(root, config);
    (result.ok ? process.stdout : process.stderr).write(`${result.message}\n`);
    return result.ok ? 0 : 1;
  }

  if (flags.serve) {
    const port = flags.port === undefined ? 7788 : Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return fail('--port 必须是 0..65535');
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
        process.stdout.write(`dsh-plugin-harness-cli plans --serve → http://127.0.0.1:${actual}/\n`);
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
  process.stdout.write(`  ${tasks.length} 个任务（展开可编辑文档；--serve 后按钮可直接删除 / 重跑 / 保存）\n`);
  return 0;
}

function cmdWiki(root, flags) {
  const {config} = loadConfig(root);
  const dir = flags.dir || config.paths.wiki || 'docs/wiki';
  const mode = flags.wikiMode || (config.wiki && config.wiki.mode) || 'ask';

  if (mode !== 'ask' && mode !== 'auto' && mode !== 'keep') {
    return fail(`未知的 wiki 模式：${mode}（可用：ask / auto / keep）`);
  }

  if (flags.check) {
    const status = wikiStatus(root, {dir});
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({root, dir, ...status}, null, 2)}\n`);
    } else {
      process.stdout.write(`dsh-plugin-harness-cli wiki --check → ${root}\n`);
      process.stdout.write(`  目录：${dir}${status.exists ? '' : '（不存在）'}\n`);
      if (status.missing.length) process.stdout.write(`  缺少：${status.missing.join(', ')}\n`);
      if (status.stale.length) process.stdout.write(`  过期：${status.stale.join(', ')}\n`);
      if (status.conflicts.length) process.stdout.write(`  冲突：${status.conflicts.join(', ')}\n`);
      if (!status.missing.length && !status.stale.length && !status.conflicts.length) {
        process.stdout.write('  全部为最新 ✓\n');
      }
    }
    return status.missing.length || status.stale.length || status.conflicts.length ? 1 : 0;
  }

  const interactive = mode === 'ask' && !flags.dryRun && process.stdin.isTTY;
  const ask = interactive
    ? (entry) => {
        const answer = askSync(`  ${entry.name}：${entry.reason}。更新？[y] 更新 / [n] 保留 / [a] 本页及后续全部更新：`);
        if (answer === 'a' || answer === 'all') return 'update-all';
        if (answer === 'y' || answer === 'yes' || answer === '') return 'update';
        return 'keep';
      }
    : undefined;

  const result = applyWiki(root, {mode, dryRun: flags.dryRun, dir, ask});
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
  const changed = result.changed;
  process.stdout.write(
    `\n${flags.dryRun ? '（dry-run，未落盘）' : `已写入 ${changed} 篇`}；` +
      `跳过 ${byAction('keep').length} 篇，冲突 ${result.conflicts.length} 篇\n`
  );

  // 业务文档变了，任务的 proposal 也要跟着更新（写回受管区块 + 指纹）
  if (flags.dryRun) return result.conflicts.length && mode !== 'keep' ? 1 : 0;
  const facts = collectFacts(root);
  const proposalSync = syncProposalFromWiki(root, config.paths, () => ({
    project: `${facts.project.name} v${facts.project.version}`,
    domains: facts.domains.map((item) => item.name).join(' / ') || '—',
    counts: `${facts.counts.features} 条功能（进行中 ${facts.counts.inProgress}，完成 ${facts.counts.done}）`,
  }));
  if (proposalSync.action === 'updated') {
    process.stdout.write(`  已同步 ${proposalSync.tasks.length} 个任务的 docs/specs/<任务>/proposal.md（业务背景区块）\n`);
  }

  // 生成只是第一步：再反推一遍工作区，把仍无法推导的位置列出来（不再用「待补」占位）
  const gaps = wikiGaps(root, dir);
  const gapsFile = writeGapReport(root, dir, gaps);
  process.stdout.write(`  反推工作区：13 篇已按当前仓库补全；仍需人工确认：${gaps.length} 处（清单：${gapsFile}）\n`);
  for (const gap of gaps.slice(0, 8)) {
    process.stdout.write(`    - ${gap.file}:${gap.line}  ${gap.text.slice(0, 80)}\n`);
  }
  if (gaps.length > 8) process.stdout.write(`    … 其余 ${gaps.length - 8} 处见文件\n`);

  if (result.conflicts.length) {
    // --keep 是「我确认保留」这个决定，不是失败；--ask 在非交互环境里才需要人来拍板。
    if (mode === 'keep') {
      process.stdout.write(`已按 --keep 保留 ${result.conflicts.length} 篇冲突文件（人工内容未改动）\n`);
      return 0;
    }
    process.stderr.write(
      '冲突未解决：受管区块被人工改过。确认要覆盖后重跑 `--update`，' +
        '或保留人工内容跑 `--keep` 只补缺失文件。\n'
    );
    return 1;
  }
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
  const sync = spawnSync(process.execPath, [path.join(root, config.paths.prototypeCheck), '--sync'], {
    cwd: root,
    encoding: 'utf8',
  });
  const syncOut = `${sync.stdout || ''}${sync.stderr || ''}`.trim();
  if (sync.status !== 0) {
    process.stderr.write(`  总览页同步失败（任务页已写入）：${syncOut || `退出码 ${sync.status}`}\n`);
    return 2;
  }
  if (syncOut) process.stdout.write(`  ${syncOut.split('\n').join('\n  ')}\n`);
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

  if (flags.help || command === 'help' || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined && argv.length > 0 ? 2 : 0;
  }
  if (flags.version || command === 'version') {
    process.stdout.write(`dsh-plugin-harness-cli ${VERSION}\n`);
    return 0;
  }
  if (unknown.length) return fail(unknown.join('；'));
  if (!['init', 'agents', 'page', 'plan', 'review', 'progress', 'ui', 'check', 'doctor', 'wiki', 'plans'].includes(command)) {
    return fail(
      `未知命令：${command}（可用：init / agents / page / plan / review / progress / ui / check / doctor / wiki / plans / style / version）`
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
    if (command === 'check') return cmdCheck(root, flags);
    if (command === 'wiki') return cmdWiki(root, flags);
    if (command === 'plans') return cmdPlans(root, flags);
    return cmdDoctor(root, flags);
  } catch (err) {
    process.stderr.write(`dsh-plugin-harness-cli ${command} 失败：${err && err.message ? err.message : err}\n`);
    return 2;
  }
}

module.exports = {main, parseArgs, USAGE, VERSION};
