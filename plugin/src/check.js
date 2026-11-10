'use strict';

/**
 * check：把讲义里的约定变成"做不到就会失败"的判定。
 *
 * 每个 check 给出 id / level / message，level=error 决定退出码 1。
 * 判定只读文件，不改任何东西（自动修复交给 init / agents）。
 */

const path = require('path');
const {execFileSync} = require('child_process');
const {exists, readIfExists, readJsonIfExists, isDir, toPosix} = require('./util');
const {loadTemplate} = require('./templates');
const {render} = require('./render');
const {buildContext} = require('./context');
const {validateConfig, CONFIG_FILE, LEGACY_CONFIG_FILES, resolveConfigFile} = require('./config');
const {wikiStatus} = require('./wiki');

const AGENTS_SECTIONS = [
  '项目定位',
  '目录地图',
  '常用命令',
  '编码约定',
  '工作流',
  '禁止事项',
  '完成定义',
  '深入阅读',
];

const VALID_STATUS = ['pending', 'in_progress', 'done', 'blocked'];
const REQUIRED_GITIGNORE = [
  'node_modules/',
  'dist/',
  'build/',
  'logs/',
  '*.log',
  '.env',
  '.deepseek/',
  '*.tmp-*',
];

const FEATURE_REQUIRED = ['id', 'name', 'description', 'status', 'acceptance', 'evidence'];

function makeCollector() {
  const results = [];
  const add = (id, level, message, hint) => results.push({id, level, message, hint});
  const pass = (id, message) => results.push({id, level: 'ok', message});
  return {results, add, pass};
}

function isExecutable(file) {
  try {
    const fs = require('fs');
    return (fs.statSync(file).mode & 0o111) !== 0;
  } catch (err) {
    return false;
  }
}

function checkAgents(root, config, ctx, c) {
  const file = path.join(root, config.paths.agents);
  const text = readIfExists(file);
  if (text === null || text.trim() === '') {
    c.add('A101', 'error', `缺少入口文件 ${config.paths.agents}`, '跑 dsh-plugin-harness-cli agents 生成');
    return;
  }
  const headings = [...text.matchAll(/^##\s+(?:\d+\.\s*)?(.+)$/gm)].map((m) => m[1].trim());
  const missing = AGENTS_SECTIONS.filter((name) => !headings.some((h) => h.includes(name)));
  if (missing.length) {
    c.add('A102', 'error', `AGENTS.md 缺少章节：${missing.join(' / ')}`, '讲义 W3 D2 的八节结构');
  } else {
    c.pass('A102', 'AGENTS.md 八节齐全');
  }

  const lines = text.split('\n').length;
  if (lines > 120) {
    c.add('A103', 'error', `AGENTS.md ${lines} 行，超过 120 行上限（写成了手册）`, '超出部分拆到 docs/');
  } else if (lines > 100) {
    c.add('A103', 'warn', `AGENTS.md ${lines} 行，已超过建议的 100 行`);
  } else {
    c.pass('A103', `AGENTS.md ${lines} 行（≤100）`);
  }

  const refs = [...text.matchAll(/`([A-Za-z0-9_./-]+\.(?:md|json|sh|html|ya?ml|ts|js|py))`/g)].map((m) => m[1]);
  const uniq = [...new Set(refs)];
  const broken = uniq.filter((ref) => !exists(path.join(root, ref)));
  if (broken.length) {
    c.add('A104', 'error', `AGENTS.md 里有失效链接：${broken.join(', ')}`, '要么建文件，要么删链接');
  } else {
    c.pass('A104', `${uniq.length} 个引用路径全部存在`);
  }

  if (/待补：一句话说清/.test(text)) {
    c.add('A105', 'warn', 'AGENTS.md 的「项目定位」仍是占位内容', '填 harness-cli.json 的 project.positioning');
  }

  const rendered = render(loadTemplate('agents'), ctx);
  if (rendered.trim() !== text.trim()) {
    c.add('A106', 'warn', 'AGENTS.md 与 harness-cli.json 的生成结果不一致（被手改过？）', '改配置后跑 dsh-plugin-harness-cli agents');
  } else {
    c.pass('A106', 'AGENTS.md 与配置同源');
  }
}

function checkFeatureList(root, config, c) {
  const rel = config.paths.featureList;
  const data = readJsonIfExists(path.join(root, rel), null);
  if (data === null) {
    c.add('F101', 'error', `缺少 ${rel}`, '跑 dsh-plugin-harness-cli init 生成');
    return;
  }
  const features = Array.isArray(data.features) ? data.features : null;
  if (features === null) {
    c.add('F102', 'error', `${rel} 缺少 features 数组`);
    return;
  }
  if (features.length === 0) {
    c.add('F102', 'warn', `${rel} 还没有 feature：Agent 不知道该做什么`, '至少盘出 6 条（讲义 W3 D4 练习）');
    return;
  }
  c.pass('F102', `${features.length} 个 feature`);

  const ids = new Set();
  let wip = 0;
  let problems = 0;

  for (const [i, f] of features.entries()) {
    const label = f && f.id ? f.id : `#${i}`;
    for (const key of FEATURE_REQUIRED) {
      const value = f ? f[key] : undefined;
      const empty = value === undefined || value === null || (Array.isArray(value) && value.length === 0);
      if (empty && key !== 'evidence') {
        c.add('F103', 'error', `feature ${label} 缺字段 ${key}`);
        problems++;
      }
    }
    if (f && f.id) {
      if (!/^F-\d{3,}$/.test(f.id)) {
        c.add('F104', 'error', `feature id 格式不合法：${f.id}（应形如 F-001）`);
        problems++;
      }
      if (ids.has(f.id)) {
        c.add('F104', 'error', `feature id 重复：${f.id}`);
        problems++;
      }
      ids.add(f.id);
    }
    if (f && f.status && !VALID_STATUS.includes(f.status)) {
      c.add('F105', 'error', `feature ${label} 状态非法：${f.status}`, `可用：${VALID_STATUS.join(' / ')}`);
      problems++;
    }
    if (f && f.status === 'in_progress') wip++;
    if (f && f.status === 'done') {
      const evidence = Array.isArray(f.evidence) ? f.evidence.filter((x) => String(x).trim()) : [];
      if (evidence.length === 0) {
        c.add('F106', 'error', `feature ${label} 已标 done 但没有 evidence`, '没有证据的完成只是感觉');
        problems++;
      }
    }
  }

  // 并行度上限来自 task_queue.json 的 wipLimit（默认 1 = 原来的单 WIP）
  const queue = readJsonIfExists(path.join(root, config.paths.taskQueue), null);
  const wipLimit = queue && Number.isInteger(queue.wipLimit) && queue.wipLimit >= 1 ? queue.wipLimit : 1;
  if (wip > wipLimit) {
    c.add(
      'F107',
      'error',
      `同时有 ${wip} 个 in_progress，超过 wipLimit = ${wipLimit}`,
      wipLimit === 1 ? '一次只推进一个 feature；确实要并行就调大 task_queue.json 的 wipLimit 并走认领' : '先 release 一个认领再开工'
    );
  } else {
    c.pass('F107', `WIP 正常（in_progress = ${wip} / 上限 ${wipLimit}）`);
  }

  for (const f of features) {
    for (const dep of Array.isArray(f.depends_on) ? f.depends_on : []) {
      if (!ids.has(dep)) {
        c.add('F108', 'error', `feature ${f.id} 的 depends_on 指向不存在的 ${dep}`);
        problems++;
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(features.filter((f) => f && f.id).map((f) => [f.id, f]));
  const hasCycle = (id, stack) => {
    if (visiting.has(id)) return [...stack, id];
    if (visited.has(id)) return null;
    visiting.add(id);
    for (const dep of (byId.get(id) || {}).depends_on || []) {
      const found = hasCycle(dep, [...stack, id]);
      if (found) return found;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of byId.keys()) {
    const cycle = hasCycle(id, []);
    if (cycle) {
      c.add('F109', 'error', `depends_on 存在循环：${cycle.join(' → ')}`);
      problems++;
      break;
    }
  }

  if (problems === 0) c.pass('F103-F109', 'feature 字段、状态、证据、依赖全部合法');
}

function checkRuntimeFiles(root, config, c) {
  const initFile = path.join(root, config.paths.init);
  if (!exists(initFile)) {
    c.add('H101', 'error', `缺少 ${config.paths.init}`, '环境问题不该靠记忆解决');
  } else if (!isExecutable(initFile)) {
    c.add('H101', 'warn', `${config.paths.init} 没有可执行位`, `chmod +x ${config.paths.init}`);
  } else {
    c.pass('H101', `${config.paths.init} 存在且可执行`);
  }

  const gateFile = path.join(root, config.paths.gate);
  if (!exists(gateFile)) {
    c.add('H102', 'error', `缺少门禁 ${config.paths.gate}`, '跑 dsh-plugin-harness-cli init 生成');
  } else {
    const gate = readIfExists(gateFile) || '';
    if (!/set -e/.test(gate)) {
      c.add('H102', 'error', `${config.paths.gate} 没有 set -e：失败会继续往下跑`);
    } else if (!isExecutable(gateFile)) {
      c.add('H102', 'warn', `${config.paths.gate} 没有可执行位`, `chmod +x ${config.paths.gate}`);
    } else {
      c.pass('H102', `${config.paths.gate} 含 set -e 且可执行`);
    }
  }

  const progressText = readIfExists(path.join(root, config.paths.progress));
  if (progressText === null) {
    c.add('H103', 'error', `缺少 ${config.paths.progress}`, '跨会话状态没地方落盘');
  } else if (!/下一步行动/.test(progressText)) {
    c.add('H103', 'error', `${config.paths.progress} 缺少「下一步行动」段`, '没有它下个会话接不上');
  } else {
    c.pass('H103', `${config.paths.progress} 含下一步行动`);
  }

  const queue = readJsonIfExists(path.join(root, config.paths.taskQueue), null);
  if (queue === null) {
    c.add('H104', 'warn', `缺少 ${config.paths.taskQueue}（任务队列可选，但并行任务需要 WIP 上限）`);
  } else if (!Number.isInteger(queue.wipLimit) || queue.wipLimit < 1) {
    c.add('H104', 'error', `${config.paths.taskQueue} 的 wipLimit 必须是正整数`);
  } else {
    c.pass('H104', `任务队列 wipLimit = ${queue.wipLimit}`);
  }

  // 业务 wiki：只在项目已经有 docs/wiki 时提醒，避免没用到的人被噪音打扰
  const wikiCfg = config.wiki || {};
  const wikiDir = path.join(root, config.paths.wiki || 'docs/wiki');
  if (isDir(wikiDir)) {
    const status = wikiStatus(root, {dir: config.paths.wiki || 'docs/wiki'});
    if (status.conflicts.length > 0) {
      const adoptable = (status.adoptable || []).length;
      const edited = status.conflicts.length - adoptable;
      const detail = [
        adoptable > 0 ? `${adoptable} 篇没有受管区块（--update 补区块、正文保留）` : '',
        edited > 0 ? `${edited} 篇受管区块被人工改过` : '',
      ].filter(Boolean).join('，');
      c.add(
        'H109',
        'warn',
        `${config.paths.wiki} 有 ${status.conflicts.length} 篇与事实冲突：${detail}`,
        '跑 dsh-plugin-harness-cli wiki --update 接管 / --keep 保留现状'
      );
    } else if (status.missing.length + status.stale.length > 0) {
      c.add(
        'H109',
        'warn',
        `${config.paths.wiki} 已过期：缺 ${status.missing.length} 篇、旧 ${status.stale.length} 篇`,
        '跑 dsh-plugin-harness-cli wiki 更新（或 --check 只看差异）'
      );
    } else {
      c.pass('H109', `${config.paths.wiki} 与事实一致`);
    }
  }

  const claimsCfg = config.claims || {};
  if (claimsCfg.enabled !== false) {
    const script = path.join(root, config.paths.claimScript);
    if (!exists(script)) {
      c.add('H107', 'error', `缺少 ${config.paths.claimScript}（并行 loop 的认领工具）`, '跑 dsh-plugin-harness-cli init 生成');
    } else if (!isExecutable(script)) {
      c.add('H107', 'warn', `${config.paths.claimScript} 没有可执行位`, `chmod +x ${config.paths.claimScript}`);
    } else {
      c.pass('H107', `${config.paths.claimScript} 存在且可执行`);
    }
    if (!isDir(path.join(root, config.paths.claims))) {
      c.add('H108', 'warn', `缺少 ${config.paths.claims}/（约定文档没落盘）`, '跑 dsh-plugin-harness-cli init 生成');
    } else {
      c.pass('H108', `${config.paths.claims}/ 存在`);
    }
  }

  const skeleton = [
    path.join(config.paths.docs, 'current.md'),
    path.join(config.paths.docs, 'summary.json'),
    path.join(config.paths.docs, 'graph.json'),
    config.paths.versionInfo ? path.join(config.paths.versionInfo, `v${config.project.version}.md`) : null,
    config.paths.adr,
  ];
  const missing = skeleton.filter((rel) => rel && !exists(path.join(root, rel)));
  if (missing.length) {
    c.add('H105', 'error', `Harness 骨架缺文件：${missing.join(', ')}`, '跑 dsh-plugin-harness-cli init');
  } else {
    c.pass('H105', 'Harness 骨架文件齐备');
  }

  const harnessDir = path.join(root, config.paths.harness);
  const hasCi =
    isDir(harnessDir) &&
    require('fs')
      .readdirSync(harnessDir)
      .some((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  if (!hasCi) {
    c.add('H106', 'warn', `${config.paths.harness}/ 下没有 CI 配置`, '跑 dsh-plugin-harness-cli init 生成流水线骨架');
  } else {
    c.pass('H106', `CI 配置存在（${config.paths.harness}/）`);
  }
}

function checkGitignore(root, c) {
  const text = readIfExists(path.join(root, '.gitignore'));
  if (text === null) {
    c.add('G101', 'error', '缺少 .gitignore：运行期产物会进版本库', '跑 dsh-plugin-harness-cli init');
    return;
  }
  const lines = text.split('\n').map((l) => l.trim());
  const missing = REQUIRED_GITIGNORE.filter((rule) => !lines.includes(rule));
  if (missing.length) {
    c.add('G101', 'error', `.gitignore 缺少规则：${missing.join(', ')}`, '跑 dsh-plugin-harness-cli init 追加');
  } else {
    c.pass('G101', '.gitignore 规则齐备');
  }
}

/**
 * 版本说明的判定：结构机械可查，内容是否白话只能由人看，所以这里只查"有没有缺块"。
 * 白话文的要求体现在模板里（面向产品/运营/测试可读），不靠判定猜语气。
 */
function checkVersionNote(root, config, c) {
  if (!config.paths.versionInfo) return; // 该仓库不做版本说明，跳过而不是报错
  const rel = path.posix.join(config.paths.versionInfo, `v${config.project.version}.md`);
  const text = readIfExists(path.join(root, rel));
  if (text === null) {
    c.add('V101', 'error', `缺少 ${rel}`, '跑 dsh-plugin-harness-cli init 生成');
    return;
  }

  const need = ['## 1. 更新内容', '## 2. 实现方式', '## 3. 逻辑图', '## 4. 验证标准'];
  const missing = need.filter((h) => !text.includes(h));
  if (missing.length) {
    c.add('V102', 'error', `${rel} 缺少板块：${missing.join(' / ')}`, '更新内容 + 实现方式 + 逻辑图 + 验证标准');
  } else {
    c.pass('V102', `${rel} 四个板块齐全`);
  }

  const body = text.split('## 2. 实现方式')[0] || '';
  const items = [...body.matchAll(/^\d+\.\s+\S+/gm)];
  if (items.length === 0) {
    c.add('V103', 'error', `${rel} 的「更新内容」没有编号条目`, '1. 2. 3. 逐条写清这版改了什么');
  } else {
    c.pass('V103', `更新内容 ${items.length} 条`);
  }

  if (/（待补）|TODO|TBD/.test(text)) {
    c.add('V104', 'error', `${rel} 还留着待补占位`, '占位的内容等于没写');
  }

  const verifyPart = text.split('## 4. 验证标准')[1] || '';
  if (!/^- \[ \]/m.test(verifyPart)) {
    c.add('V105', 'warn', `${rel} 的「验证标准」没有可勾选清单`, '写成 - [ ] 条目，让非开发同学也能确认');
  }
}

/**
 * 认领判定：规则写在生成物 `scripts/claim.js` 里（与 prototype-check 同一模式），
 * 这里只负责调用与映射，避免同一套判定在工具和项目里各写一遍。
 */
function checkClaims(root, config, c) {
  const cfg = config.claims || {};
  if (cfg.enabled === false) return;
  const script = path.join(root, config.paths.claimScript);
  if (!exists(script)) return; // H107 已经报过

  let out;
  try {
    out = execFileSync(process.execPath, [script, 'verify', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    out = err.stdout || '';
    if (!String(out).trim()) {
      c.add('C200', 'error', `claim verify 无法运行：${(err.stderr || err.message || '').trim()}`);
      return;
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    c.add('C200', 'error', 'claim verify 输出的不是合法 JSON');
    return;
  }
  if (parsed.skipped === true) return;
  for (const r of Array.isArray(parsed.checks) ? parsed.checks : []) {
    if (r.level === 'error') c.add(r.id, 'error', r.message);
    else if (r.level === 'warn') c.add(r.id, 'warn', r.message);
    else c.pass(r.id, r.message);
  }
}

function checkPrototype(root, config, ctx, c) {
  const proto = ctx.prototype;
  if (!proto.enabled) return;
  const script = path.join(root, config.paths.prototypeCheck);
  if (!exists(script)) {
    c.add('P101', 'error', `preset prototype 已开启但缺少 ${config.paths.prototypeCheck}`, '跑 dsh-plugin-harness-cli init 生成');
    return;
  }
  let out;
  try {
    out = execFileSync(process.execPath, [script, '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    out = err.stdout || '';
    if (!out.trim()) {
      c.add('P102', 'error', `prototype-check 无法运行：${(err.stderr || err.message || '').trim()}`);
      return;
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    c.add('P102', 'error', 'prototype-check 输出的不是合法 JSON');
    return;
  }
  const inner = Array.isArray(parsed.checks) ? parsed.checks : [];
  const errors = inner.filter((r) => r.level === 'error');
  for (const r of errors) c.add(r.id, 'error', r.message);
  for (const r of inner.filter((r) => r.level !== 'error')) c.add(r.id, 'warn', r.message);
  if (errors.length === 0) c.pass('P103', '任务进度页校验通过');
}

/** 执行全部检查。 */
function runChecks(root, config) {
  const c = makeCollector();
  const ctx = buildContext(config, {configFile: resolveConfigFile(root).name});

  if (!exists(path.join(root, CONFIG_FILE))) {
    const legacyInUse = LEGACY_CONFIG_FILES.find((name) => exists(path.join(root, name)));
    if (legacyInUse) {
      c.add('C101', 'warn', `仍在用旧文件名 ${legacyInUse}`, `改名为 ${CONFIG_FILE} 后重跑`);
    } else {
      c.add('C101', 'warn', `缺少 ${CONFIG_FILE}：规则没有可调整的入口`, '跑 dsh-plugin-harness-cli init');
    }
  }
  for (const issue of validateConfig(config)) c.add('C102', 'error', issue);

  checkAgents(root, config, ctx, c);
  checkRuntimeFiles(root, config, c);
  checkFeatureList(root, config, c);
  checkGitignore(root, c);
  checkVersionNote(root, config, c);
  checkClaims(root, config, c);
  checkPrototype(root, config, ctx, c);

  const errors = c.results.filter((r) => r.level === 'error');
  const warnings = c.results.filter((r) => r.level === 'warn');
  return {
    root: toPosix(root),
    checks: c.results,
    summary: {errors: errors.length, warnings: warnings.length, total: c.results.length},
  };
}

module.exports = {runChecks, AGENTS_SECTIONS, REQUIRED_GITIGNORE, VALID_STATUS};
