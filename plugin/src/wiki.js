'use strict';

/**
 * wiki：把仓库里已有的事实汇总成一套业务向文档（`docs/wiki/`）。
 *
 * 设计约束（与工具其他部分一致）：
 * - 只读扫描 + 生成：不推断、不编造。拿不到的写「待补」，并说明去哪儿补。
 * - 每篇文档只有一个**受管区块**（`<!-- harness-wiki:begin/end -->`）；
 *   区块外的人工内容永远不动，区块内被人工改过就报冲突，由调用方决定更新还是保留。
 * - 冲突不静默：默认 `ask`；非交互环境返回 1 并列出冲突，由 Agent 询问用户后带 `--update` / `--keep` 重跑。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {exists, isDir, readIfExists, readJsonIfExists, writeFileSafe, toPosix} = require('./util');
const {loadConfig, resolveConfigFile} = require('./config');
const {render} = require('./render');
const {loadTemplate} = require('./templates');

const BEGIN = '<!-- harness-wiki:begin -->';
const END = '<!-- harness-wiki:end -->';
const STATE_FILE = '.harness-wiki.json';
const DEFAULT_DIR = 'docs/wiki';

/** 13 篇文档：文件名 → 模板键 + 标题。 */
const FILES = [
  {name: '一页纸速览.md', title: '一页纸速览', template: 'wikiOverview'},
  {name: '系统全景与部署形态.md', title: '系统全景与部署形态', template: 'wikiDeployment'},
  {name: '角色与场景.md', title: '角色与场景', template: 'wikiRoles'},
  {name: '业务流程.md', title: '业务流程', template: 'wikiFlows'},
  {name: '功能清单.md', title: '功能清单', template: 'wikiFeatures'},
  {name: '业务规则与状态.md', title: '业务规则与状态', template: 'wikiRules'},
  {name: '业务规范与口径.md', title: '业务规范与口径', template: 'wikiConventions'},
  {name: '质量与交付卡点.md', title: '质量与交付卡点', template: 'wikiQuality'},
  {name: '验收与测试要点.md', title: '验收与测试要点', template: 'wikiAcceptance'},
  {name: '业务风险与现场现象.md', title: '业务风险与现场现象', template: 'wikiRisks'},
  {name: '术语表.md', title: '术语表', template: 'wikiGlossary'},
  {name: '业务操作手册.md', title: '业务操作手册', template: 'wikiManual'},
  {name: 'README.md', title: '项目知识库（docs/wiki）', template: 'wikiReadme'},
];

/** 扫描时跳过的大目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.harness-wiki']);

function existsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (err) {
    return false;
  }
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** 递归统计文件（限量，避免把大仓库读穿）。 */
function walk(dir, limit = 400, skips = []) {
  const out = [];
  const queue = [dir];
  const skipped = (target) => skips.some((root) => target === root || target.startsWith(`${root}${path.sep}`));
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current, {withFileTypes: true});
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (skipped(full)) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * harness-cli 生成的文件/目录：反推项目事实时也要排除，否则工具自带的脚本会被当成项目代码。
 * @param {string} root - 仓库根目录。
 * @param {object} config - 生效配置。
 * @returns {string[]} 需要排除的绝对路径。
 */
function artifactSkips(root, config) {
  const paths = config.paths || {};
  const items = [
    paths.prototype,
    paths.harness,
    paths.claims,
    paths.claimScript,
    paths.prototypeCheck,
    paths.gate,
    paths.init,
    paths.agents,
    paths.taskQueue,
    paths.progress,
    paths.wiki,
    'plans.html',
    '_VERSIONS',
    'harness-cli.json',
    '.gitignore',
  ];
  return items.filter(Boolean).map((item) => path.resolve(root, item));
}

/**
 * 找出仓库里「harness-cli 工具自身」的目录，反推事实时要排除它们。
 * 识别方式：包名是 dsh-plugin-harness-cli、含 bin/dsh-plugin-harness-cli.js、或目录名就是它。
 * @param {string} root - 仓库根目录。
 * @returns {string[]} 需要排除的绝对路径（不含仓库根本身）。
 */
function findToolRoots(root) {
  const found = new Set();
  const isToolPkg = (pkg) =>
    pkg && ['dsh-plugin-harness-cli', '@deepseek-ai/dsh-plugin-harness-cli'].includes(pkg.name);

  const mark = (dir) => {
    // plugin/ 是工具的内层目录：外层（含 install.sh / README-INSTALL.md）才是工具根
    const parent = path.dirname(dir);
    if (path.basename(dir) === 'plugin' &&
        (exists(path.join(parent, 'install.sh')) || exists(path.join(parent, 'README-INSTALL.md')) || exists(path.join(parent, 'harness-cli.json')))) {
      found.add(parent);
    } else {
      found.add(dir);
    }
  };

  const queue = [{dir: root, depth: 0}];
  while (queue.length > 0) {
    const {dir, depth} = queue.shift();
    if (depth > 3) continue;
    if (isToolPkg(readJsonSafe(path.join(dir, 'package.json')))) mark(dir);
    if (exists(path.join(dir, 'bin', 'dsh-plugin-harness-cli.js'))) mark(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'dsh-plugin-harness-cli') mark(full);
      if (depth < 3) queue.push({dir: full, depth: depth + 1});
    }
  }

  found.delete(path.resolve(root));
  return [...found];
}

/** 数测试文件：文件名带 test/spec，或用 tests/ 目录。 */
function countTests(root, skips = []) {
  const candidates = new Set();
  for (const dir of ['tests', 'test', 'scripts', 'src', 'plugin/tests']) {
    const abs = path.join(root, dir);
    if (!isDir(abs)) continue;
    for (const file of walk(abs, 200, skips)) {
      if (/\.(test|spec)\.[a-z]+$/i.test(file) || /(^|\/)(test|spec)[_-]/i.test(file)) candidates.add(file);
    }
  }
  return candidates.size;
}

function readJsonSafe(file) {
  return readJsonIfExists(file, null);
}

/** 从仓库文件反推技术栈。 */
function detectStack(root, pkg, skips = []) {
  const stack = [];
  const has = (name) => exists(path.join(root, name));
  if (pkg !== null) stack.push(has('tsconfig.json') ? 'TypeScript' : 'JavaScript');
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) stack.push('Python');
  if (has('go.mod')) stack.push('Go');
  if (has('Cargo.toml')) stack.push('Rust');
  if (has('pom.xml') || has('build.gradle')) stack.push('Java');
  if (stack.length === 0) {
    const files = walk(root, 200, skips);
    const counted = {JavaScript: 0, TypeScript: 0, Python: 0, Shell: 0, Go: 0};
    for (const file of files) {
      if (/\.(test|spec)\.[a-z]+$/i.test(file) || file.includes('node_modules')) continue;
      if (/\.tsx?$/i.test(file)) counted.TypeScript += 1;
      else if (/\.(jsx?|cjs|mjs)$/i.test(file)) counted.JavaScript += 1;
      else if (/\.py$/i.test(file)) counted.Python += 1;
      else if (/\.(sh|bash)$/i.test(file)) counted.Shell += 1;
      else if (/\.go$/i.test(file)) counted.Go += 1;
    }
    for (const [name, count] of Object.entries(counted)) if (count > 0) stack.push(name);
  }
  return stack;
}

/** 反推运行环境。 */
function detectRuntime(root, pkg, skips = []) {
  const engines = pkg && pkg.engines && pkg.engines.node;
  if (engines) return `Node.js ${engines}`;
  if (pkg !== null) return 'Node.js >= 18（按 package.json 约定）';
  if (exists(path.join(root, 'pyproject.toml'))) return 'Python 3';
  if (exists(path.join(root, 'go.mod'))) return 'Go';
  if (walk(root, 80, skips).some((file) => /\.(sh|bash)$/.test(file))) return 'bash（脚本仓库）';
  return '未声明';
}

/** 反推顶层目录（未在配置里声明时用），带文件数。 */
function topDirs(root, config, skips = []) {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.harness', '.dsh', 'docs', 'prototype', 'coverage', '.github', '__pycache__']);
  const out = [];
  try {
    for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
      if (!entry.isDirectory() || skip.has(entry.name) || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const files = walk(path.join(root, entry.name), 400, skips);
      if (files.length === 0) continue;
      const declared = (config.dirs || []).find((item) => String(item.path).replace(/\/+$/, '') === entry.name);
      out.push({path: `${entry.name}/`, desc: (declared && (declared.desc || declared.description)) || `${files.length} 个文件`});
    }
  } catch (err) {
    return [];
  }
  return out;
}

/** 用 README 的第一段正文作项目定位（跳过标题、表格、图片与徽章，去掉引用符号）。 */
function readmeSummary(root) {
  const text = readIfExists(path.join(root, 'README.md')) || '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || /^#{1,6}\s/.test(line)) continue; // 标题不是定位
    if (/^[|!]/.test(line) || line.startsWith('[![')) continue; // 表格 / 图片 / 徽章
    const trimmed = line.replace(/^[>\-*\s]+/, '').trim();
    if (/dsh-plugin-harness-cli|占位|请按实际情况/.test(trimmed)) continue; // 生成器脚手架不是定位
    if (trimmed.length >= 8 && !/^[|!]/.test(trimmed)) return trimmed;
  }
  return '';
}

function parseProgressPage(text) {
  const values = [...String(text).matchAll(/class="[^"]*\bstep-pct\b[^"]*"[^>]*data-pct="([^"]*)"/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  const total = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  const status = (/data-task-status="([^"]*)"/.exec(text) || [])[1] || null;
  return {total, steps: values.length, status};
}

/**
 * 收集事实。所有字段都来自仓库文件；读不到的用 null，由模板写成「待补」。
 * @param {string} root - 目标仓库根目录。
 * @returns {object} 模板作用域。
 */
function collectFacts(root) {
  const {config} = loadConfig(root);
  const configFile = resolveConfigFile(root).name;
  const paths = config.paths;
  const skips = [...findToolRoots(root), ...artifactSkips(root, config)];
  const hasPkg = exists(path.join(root, 'package.json'));
  const pkg = readJsonSafe(path.join(root, 'package.json')) || {};

  const featureData = readJsonSafe(path.join(root, paths.featureList));
  const features = (featureData && Array.isArray(featureData.features) ? featureData.features : []).map((f) => ({
    id: f.id || '',
    name: f.name || '',
    status: f.status || '',
    acceptance: Array.isArray(f.acceptance) ? f.acceptance.length : 0,
    evidence: Array.isArray(f.evidence) ? f.evidence.length : 0,
    dependsOn: Array.isArray(f.depends_on) ? f.depends_on.length : 0,
  }));

  const queue = readJsonSafe(path.join(root, paths.taskQueue)) || {};
  const wipLimit = Number.isInteger(queue.wipLimit) ? queue.wipLimit : 1;

  const taskRoot = path.join(root, paths.prototype || 'prototype');
  const tasks = [];
  if (isDir(taskRoot)) {
    for (const entry of fs.readdirSync(taskRoot, {withFileTypes: true})) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const page = path.join(taskRoot, entry.name, 'progress.html');
      const text = readIfExists(page);
      const parsed = text === null ? {total: 0, steps: 0, status: null} : parseProgressPage(text);
      tasks.push({name: entry.name, ...parsed, hasPage: text !== null});
    }
  }
  tasks.sort((a, b) => a.name.localeCompare(b.name));

  const claimsDir = path.join(root, paths.claims || 'docs/claims');
  const claims = [];
  if (isDir(claimsDir)) {
    for (const file of fs.readdirSync(claimsDir)) {
      if (!file.endsWith('.json')) continue;
      const data = readJsonSafe(path.join(claimsDir, file));
      if (data === null) continue;
      claims.push({
        feature: data.feature || file.replace(/\.json$/, ''),
        owner: data.owner || '',
        scope: Array.isArray(data.scope) ? data.scope.join(', ') : '',
      });
    }
  }

  const specsDir = path.join(root, paths.specs || 'docs/specs');
  const specs = [];
  if (isDir(specsDir)) {
    for (const entry of fs.readdirSync(specsDir, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const files = fs.readdirSync(path.join(specsDir, entry.name)).filter((f) => f.endsWith('.md'));
      specs.push({task: entry.name, files: files.length});
    }
  }

  const gateFile = path.join(root, paths.gate);
  const gateText = readIfExists(gateFile) || '';
  const report = readIfExists(path.join(root, paths.progress)) || '';
  const currentText = readIfExists(path.join(root, path.join(paths.docs, 'current.md'))) || '';

  const wikiDir = path.join(root, paths.wiki || DEFAULT_DIR);
  const wikiFiles = isDir(wikiDir) ? fs.readdirSync(wikiDir).filter((f) => f.endsWith('.md')) : [];

  const derivedDirs = (config.dirs || []).length > 0
    ? (config.dirs || []).map((d) => ({path: d.path, name: d.name || '', desc: d.desc || d.description || ''}))
    : topDirs(root, config, skips);
  const derivedStack = (config.project.stack || []).length > 0 ? config.project.stack : detectStack(root, hasPkg ? pkg : null, skips);
  const derivedRuntime = config.project.runtime || detectRuntime(root, hasPkg ? pkg : null, skips);
  const derivedPositioning =
    (config.project.positioning || '').trim() ||
    readmeSummary(root) ||
    `${config.project.name}：当前包含 ${derivedDirs.length} 个目录、${features.length} 条功能、${tasks.length} 个任务。`;
  const testCmd = config.commands.test || (pkg && pkg.scripts && pkg.scripts.test) || (countTests(root, skips) > 0 ? 'node --test' : '');
  const lintCmd = config.commands.lint || (pkg && pkg.scripts && pkg.scripts.lint) || '';
  const installCmd =
    config.commands.install ||
    (hasPkg ? 'npm install' : '') ||
    (exists(path.join(root, paths.init || 'init.sh')) ? `bash ${paths.init || 'init.sh'}` : '');
  const gateCmd = config.commands.gate || (exists(path.join(root, paths.gate)) ? `bash ${paths.gate}` : '');

  const STATUS_TEXT = {pending: '未开始', in_progress: '进行中', done: '已完成', blocked: '被阻塞'};
  for (const feature of features) feature.statusText = STATUS_TEXT[feature.status] || feature.status || '待补';
  // 功能清单为空时，用任务页反推（一个任务 = 一条在做的功能）
  if (features.length === 0 && tasks.length > 0) {
    for (const task of tasks) {
      features.push({
        id: `T-${String(features.length + 1).padStart(3, '0')}`,
        name: task.name,
        status: task.status === '完成' ? 'done' : task.status === '进行中' ? 'in_progress' : 'pending',
        statusText: task.status || '进行中',
        acceptance: 0,
        evidence: 0,
        dependsOn: 0,
      });
    }
  }

  const statusCount = (s) => features.filter((f) => f.status === s).length;
  const scripts = pkg.scripts || {};

  return {
    project: {
      name: config.project.name || pkg.name || path.basename(root),
      version: config.project.version || pkg.version || '0.0.0',
      positioning: derivedPositioning,
      stack: derivedStack,
      runtime: derivedRuntime,
    },
    configFile,
    paths,
    commands: {
      install: installCmd,
      dev: config.commands.dev || scripts.dev || scripts.start || '',
      test: testCmd,
      lint: lintCmd,
      gate: gateCmd,
      build: scripts.build || '',
    },
    dirs: derivedDirs,
    features,
    tasks,
    claims,
    specs,
    counts: {
      features: features.length,
      done: statusCount('done'),
      inProgress: statusCount('in_progress'),
      pending: statusCount('pending'),
      blocked: statusCount('blocked'),
      tasks: tasks.length,
      activeTasks: tasks.filter((t) => t.status === '进行中' || t.status === '待验收').length,
      claims: claims.length,
      specs: specs.length,
      tests: countTests(root, skips),
      dirs: (config.dirs || []).length,
      files: walk(root, 400, skips).length,
    },
    flags: {
      hasAgents: existsFile(path.join(root, paths.agents)),
      hasInit: existsFile(path.join(root, paths.init)),
      hasGate: existsFile(gateFile),
      gateSetE: /set -e/.test(gateText),
      hasFeatureList: featureData !== null,
      hasQueue: Object.keys(queue).length > 0,
      hasProgress: report.trim().length > 0,
      hasCurrent: currentText.trim().length > 0,
      hasCi: isDir(path.join(root, paths.harness || '.harness')),
      hasGit: exists(path.join(root, '.git')),
      hasClaimScript: existsFile(path.join(root, paths.claimScript || 'scripts/claim.js')),
      hasPrototypeCheck: existsFile(path.join(root, paths.prototypeCheck || 'scripts/prototype-check.js')),
      hasSpecs: isDir(specsDir),
      hasClaims: isDir(claimsDir),
      hasAdr: isDir(path.join(root, paths.decisions || 'docs/adr')),
      hasVersions: isDir(path.join(root, paths.versionInfo || '_VERSIONS')),
      hasWiki: wikiFiles.length > 0,
      claimsEnabled: (config.claims || {}).enabled !== false,
    },
    wipLimit,
    wiki: {
      dir: toPosix(paths.wiki || DEFAULT_DIR),
      files: wikiFiles,
      extras: wikiFiles.filter((f) => !FILES.some((item) => item.name === f)),
      index: FILES.map((item) => ({name: item.name, title: item.title})),
    },
    domains: derivedDirs
      // 只给「声明了业务名」的目录生成下钻页：目录名（bin / src）是代码结构，不是业务域
      .filter((d) => d.path && d.name)
      .map((d) => ({name: d.name, path: d.path, desc: d.desc || ''})),
    today: new Date().toISOString().slice(0, 10),
    nowIso: new Date().toISOString(),
  };
}

/** 取受管区块内容；没有标记返回 null。 */
function extractBlock(text) {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) return null;
  return text.slice(begin + BEGIN.length, end).trim();
}

/** 拼一篇完整文档：标题 + 受管区块 + 人工补充区。 */
function compose(title, body) {
  return `# ${title}\n\n${BEGIN}\n${body.trim()}\n${END}\n\n## 人工补充（本区不会被自动覆盖）\n\n- 生成器给不出的人话写在这里；重新生成只重写上面的受管区块，本区永远保留。\n`;
}

function replaceBlock(text, body) {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  return `${text.slice(0, begin + BEGIN.length)}\n${body.trim()}\n${text.slice(end)}`;
}

/**
 * 接管一篇「没有受管区块」的既有文档：只在标题后插入受管区块，原文一个字都不改。
 * 这是 `--update` 在旧文档上的安全动作：不覆盖人工内容，只让文件从今以后可被增量更新。
 * @param {string} title - 文档标题（文件没有一级标题时补上）。
 * @param {string} body - 受管区块内容。
 * @param {string} text - 既有文件原文。
 * @returns {string} 接管后的完整文件内容。
 */
function adoptBlock(title, body, text) {
  const block = `${BEGIN}\n${body.trim()}\n${END}`;
  const heading = /^#\s[^\n]*\n?/.exec(text);
  if (heading === null) return `# ${title}\n\n${block}\n\n${text}`;
  const head = heading[0].endsWith('\n') ? heading[0] : `${heading[0]}\n`;
  const rest = text.slice(heading[0].length).replace(/^\n+/, '');
  return `${head}\n${block}\n\n${rest}`;
}

/** 文件名里不能出现路径分隔符；业务名可以直接当文件名（中文可读）。 */
function safeName(value) {
  return String(value || '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'domain';
}

function statePath(root, dir) {
  return path.join(root, dir, STATE_FILE);
}

function loadState(root, dir) {
  return readJsonSafe(statePath(root, dir)) || {version: 1, files: {}};
}

/**
 * 计算计划：每篇是 create / update / keep / conflict 之一。
 * @param {string} root - 目标仓库根目录。
 * @param {object} [opts] - {dir} 覆盖 wiki 目录。
 * @returns {{facts: object, dir: string, entries: Array, state: object}}
 */
function planWiki(root, opts = {}) {
  const facts = collectFacts(root);
  const dir = toPosix(opts.dir || facts.paths.wiki || DEFAULT_DIR);
  const state = loadState(root, dir);
  const entries = [];

  const push = (name, title, body) => {
    const abs = path.join(root, dir, name);
    const text = existsFile(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (text === null) {
      entries.push({name, abs, action: 'create', body, content: compose(title, body)});
      return;
    }
    const block = extractBlock(text);
    if (block === null) {
      if (text.includes(BEGIN) || text.includes(END)) {
        // 只有开始或只有结束标记：补区块会造出第二个区块，只能交给人修
        entries.push({
          name,
          abs,
          action: 'conflict',
          body,
          reason: '受管区块标记不完整（只有开始或只有结束），请手工修好再生成',
        });
        return;
      }
      // 既有文档没有受管区块：当成「可接管」而不是「不可写」。
      // --update 会补上区块并保留原文，让这份文件从今以后能被增量更新。
      entries.push({
        name,
        abs,
        action: 'conflict',
        adoptable: true,
        body,
        reason: '文件里没有受管区块（--update 会补区块，原文保留）',
        content: adoptBlock(title, body, text),
      });
      return;
    }
    if (block === body.trim()) {
      entries.push({name, abs, action: 'keep', body});
      return;
    }
    const recorded = state.files && state.files[name] ? state.files[name].autoHash : null;
    if (recorded !== null && recorded === sha1(block)) {
      entries.push({name, abs, action: 'update', body, content: replaceBlock(text, body)});
    } else {
      entries.push({
        name,
        abs,
        action: 'conflict',
        body,
        reason: recorded === null ? '没有上次生成的记录（首次接管既有文件）' : '受管区块被人工改过',
        content: replaceBlock(text, body),
      });
    }
  };

  for (const file of FILES) {
    push(file.name, file.title, render(loadTemplate(file.template), facts));
  }
  for (const domain of facts.domains) {
    const name = `业务域/${safeName(domain.name)}.md`;
    push(name, `业务域：${domain.name}`, render(loadTemplate('wikiDomain'), {...facts, domain}));
  }
  return {facts, dir, entries, state};
}

/** 新状态：只记录本次实际写入的区块。 */
function nextState(prev, entries, applied) {
  const files = {...(prev.files || {})};
  for (const entry of applied) {
    files[entry.name] = {autoHash: sha1(entry.body.trim()), generatedAt: new Date().toISOString()};
  }
  return {version: 1, generatedAt: new Date().toISOString(), files};
}

/**
 * 执行计划。
 * @param {string} root - 目标仓库根目录。
 * @param {{mode?: 'ask'|'auto'|'keep', dryRun?: boolean, ask?: Function, dir?: string}} options - 运行选项。
 * @returns {{entries: Array, conflicts: Array, changed: number, state: object}}
 */
function applyWiki(root, options = {}) {
  const {entries, dir, state} = planWiki(root, options);
  const mode = options.mode || 'ask';
  const dryRun = options.dryRun === true;
  const ask = options.ask;
  const applied = [];
  const results = [];

  for (const entry of entries) {
    let action = entry.action;
    let content = entry.content;
    if (action === 'conflict') {
      if (mode === 'auto') {
        action = 'update';
        content = entry.content;
      } else if (mode === 'ask' && typeof ask === 'function') {
        const answer = ask(entry);
        if (answer === 'update') {
          action = 'update';
          content = entry.content;
        } else if (answer === 'update-all') {
          action = 'update';
          content = entry.content;
          options.mode = 'auto';
        } else {
          action = 'keep';
        }
      } else {
        action = 'conflict';
      }
    }
    // 没有可写内容的冲突（例如区块标记不完整）不能硬写：写盘前先挡一道，
    // 避免把 undefined 交给写文件，也避免「看起来更新了、其实没修」。
    if ((action === 'create' || action === 'update') && typeof content !== 'string') {
      action = 'conflict';
      entry.reason = entry.reason || '没有可写内容，已跳过';
    }
    if ((action === 'create' || action === 'update') && !dryRun) {
      writeFileSafe(entry.abs, content);
    }
    if (action === 'create' || action === 'update') applied.push(entry);
    results.push({name: entry.name, action, reason: entry.reason || '', adoptable: entry.adoptable === true});
  }

  const conflicts = results.filter((r) => r.action === 'conflict');
  // 「内容已一致」的 keep 也要记哈希，否则下一次事实变动会被误判成人工改动
  const stateEntries = [...applied, ...entries.filter((e) => e.action === 'keep')];
  if (!dryRun) {
    const stateFile = statePath(root, dir);
    try {
      if (isDir(path.dirname(stateFile))) {
        writeFileSafe(stateFile, `${JSON.stringify(nextState(state, stateEntries, stateEntries), null, 2)}\n`);
      }
    } catch (err) {
      // 状态写不进去不影响已生成的文档；下次会把它们当冲突处理，属于安全方向
    }
  }
  return {entries: results, conflicts, changed: applied.length, state};
}

/** 供 check / 报告用：有没有既存 wiki、是否落后于事实。 */
function wikiStatus(root, opts = {}) {
  const {entries} = planWiki(root, opts);
  return {
    exists: entries.some((e) => e.action !== 'create'),
    stale: entries.filter((e) => e.action === 'update').map((e) => e.name),
    missing: entries.filter((e) => e.action === 'create').map((e) => e.name),
    conflicts: entries.filter((e) => e.action === 'conflict').map((e) => e.name),
    // 没有受管区块的既有文档：可被 --update 接管（补区块、原文保留），不算「被改坏」
    adoptable: entries.filter((e) => e.action === 'conflict' && e.adoptable).map((e) => e.name),
  };
}

/**
 * 反推完成后仍有「无法从仓库推导」的位置：返回文件与行，供命令提示人工确认。
 * @param {string} root - 仓库根目录。
 * @param {string} dir - wiki 目录（相对仓库）。
 * @returns {Array<{file: string, line: number, text: string}>} 缺口列表。
 */
function wikiGaps(root, dir) {
  const base = path.join(root, dir || DEFAULT_DIR);
  const gaps = [];
  let entries = [];
  try {
    entries = fs.readdirSync(base, {withFileTypes: true});
  } catch (err) {
    return gaps;
  }
  const scan = (file) => {
    const text = readIfExists(file);
    if (text === null) return;
    text.split('\n').forEach((line, index) => {
      if (/待补|待业务确认|（未定义）|未声明/.test(line)) {
        gaps.push({file: toPosix(path.relative(root, file)), line: index + 1, text: line.trim()});
      }
    });
  };
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const child of fs.readdirSync(path.join(base, entry.name))) {
        if (child.endsWith('.md')) scan(path.join(base, entry.name, child));
      }
    } else if (entry.name.endsWith('.md')) {
      scan(path.join(base, entry.name));
    }
  }
  return gaps;
}

/**
 * 把缺口清单写成 JSON（给 Agent 反推补全时读取），返回文件路径。
 * @param {string} root - 仓库根目录。
 * @param {string} dir - wiki 目录（相对仓库）。
 * @param {Array<object>} gaps - wikiGaps() 的结果。
 * @returns {string} 相对仓库的路径。
 */
function writeGapReport(root, dir, gaps) {
  const file = path.join(root, dir || DEFAULT_DIR, '.harness-wiki-gaps.json');
  writeFileSafe(file, `${JSON.stringify({generatedAt: new Date().toISOString(), count: gaps.length, gaps}, null, 2)}\n`);
  return toPosix(path.relative(root, file));
}

module.exports = {
  FILES,
  wikiGaps,
  writeGapReport,
  findToolRoots,
  BEGIN,
  END,
  STATE_FILE,
  DEFAULT_DIR,
  collectFacts,
  planWiki,
  applyWiki,
  wikiStatus,
  compose,
  extractBlock,
};
