'use strict';

/**
 * 项目探测：只读取事实，不做判断。
 * 探测结果有两种用途：写进 AGENTS.md 的「目录地图 / 常用命令」，以及作为配置的默认值。
 * 探测不到就留空——空值会由 check 报成待补项，而不是编一个看似合理的值。
 */

const path = require('path');
const {exists, isDir, readJsonIfExists, basenameOf} = require('./util');

/** 目录语义表：只收录含义稳定的目录名，避免猜错。 */
const DIR_TABLE = [
  ['src/', '源码'],
  ['lib/', '可复用库代码'],
  ['app/', '应用主入口'],
  ['bin/', '可执行入口脚本'],
  ['scripts/', '构建、初始化、门禁脚本'],
  ['tests/', '单元与集成测试'],
  ['test/', '单元与集成测试'],
  ['docs/', '文档：任务日志、决策记录、规格'],
  ['templates/', '模板文件'],
  ['_VERSIONS/', '版本变更说明（业务白话）'],
  ['.harness/', 'CI 流水线与 Harness 元数据'],
];

const PKG_MANAGER = [
  ['pnpm-lock.yaml', 'pnpm', 'pnpm install'],
  ['yarn.lock', 'yarn', 'yarn install'],
  ['package-lock.json', 'npm', 'npm install'],
];

const LANG_MARKERS = [
  ['package.json', 'JavaScript'],
  ['tsconfig.json', 'TypeScript'],
  ['pyproject.toml', 'Python'],
  ['setup.py', 'Python'],
  ['requirements.txt', 'Python'],
  ['go.mod', 'Go'],
  ['pom.xml', 'Java'],
  ['build.gradle', 'Java'],
];

function detectPackageManager(root) {
  for (const [file, name, install] of PKG_MANAGER) {
    if (exists(path.join(root, file))) return {name, install};
  }
  if (exists(path.join(root, 'package.json'))) return {name: 'npm', install: 'npm install'};
  return {name: '', install: ''};
}

function detectLanguages(root) {
  const langs = new Set();
  for (const [file, lang] of LANG_MARKERS) {
    if (exists(path.join(root, file))) langs.add(lang);
  }
  if (exists(path.join(root, 'requirements.txt')) || exists(path.join(root, 'pyproject.toml'))) {
    langs.add('Python');
  }
  return [...langs];
}

function detectDirs(root) {
  return DIR_TABLE.filter(([dir]) => isDir(path.join(root, dir))).map(([dir, desc]) => ({
    path: dir,
    desc,
  }));
}

function scriptCommand(pm, name) {
  if (!name) return '';
  if (pm === 'npm' || pm === 'pnpm' || pm === 'yarn') return `${pm} run ${name}`;
  return '';
}

/** 探测仓库事实。root 不存在时返回最小结构，由调用方报错。 */
function detect(root) {
  const pkg = readJsonIfExists(path.join(root, 'package.json'), null) || {};
  const scripts = pkg.scripts || {};
  const pm = detectPackageManager(root);
  const languages = detectLanguages(root);
  const isNode = exists(path.join(root, 'package.json'));
  const isPython = languages.includes('Python');

  const commands = {
    install: pm.install || (isPython ? 'pip install -r requirements.txt' : ''),
    dev: scriptCommand(pm.name, scripts.dev ? 'dev' : '') || scriptCommand(pm.name, scripts.start ? 'start' : ''),
    test: scriptCommand(pm.name, scripts.test ? 'test' : '') || (isPython ? 'pytest' : ''),
    lint: scriptCommand(pm.name, scripts.lint ? 'lint' : '') || (isPython ? 'ruff check .' : ''),
    typecheck:
      scriptCommand(pm.name, scripts.typecheck ? 'typecheck' : '') ||
      (isPython ? 'mypy .' : '') ||
      (exists(path.join(root, 'tsconfig.json')) ? 'tsc --noEmit' : ''),
  };

  return {
    name: pkg.name || basenameOf(root),
    version: pkg.version || '0.1.0',
    description: pkg.description || '',
    packageManager: pm.name,
    languages,
    scripts: Object.keys(scripts),
    commands,
    dirs: detectDirs(root),
    runtime: isNode ? `Node.js ${process.version}` : '',
  };
}

module.exports = {detect, DIR_TABLE, detectPackageManager};
