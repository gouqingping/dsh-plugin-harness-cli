'use strict';

/**
 * doctor：先确认工具自己是好的，再谈判定项目。
 * 退出码 2 表示工具坏了——这时不要去改项目文件。
 */

const fs = require('fs');
const path = require('path');
const {NAMES, TEMPLATE_DIR, loadTemplate} = require('./templates');
const {render} = require('./render');
const {defaultConfig, validateConfig, loadConfig, CONFIG_FILE} = require('./config');
const {exists, isDir, toPosix} = require('./util');
const style = require('./style');

const MIN_NODE_MAJOR = 18;

function runDoctor(root) {
  const checks = [];
  const add = (name, level, detail) => checks.push({name, level, detail});

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) {
    add('node', 'ok', `v${process.versions.node}`);
  } else {
    add('node', 'error', `v${process.versions.node} 低于 ${MIN_NODE_MAJOR}`);
  }

  const missing = [];
  for (const [key, file] of Object.entries(NAMES)) {
    const p = path.join(TEMPLATE_DIR, file);
    if (!exists(p)) missing.push(`${key} → ${file}`);
  }
  if (missing.length === 0) {
    add('templates', 'ok', `${Object.keys(NAMES).length} 个模板齐备`);
  } else {
    add('templates', 'error', `模板缺失：${missing.join(', ')}`);
  }

  if (missing.length === 0) {
    try {
      const ctxAll = defaultConfig(root);
      for (const key of Object.keys(NAMES)) render(loadTemplate(key), ctxAll);
      add('render', 'ok', '全部模板可渲染');
    } catch (err) {
      add('render', 'error', err.message);
    }
  }

  try {
    const {config} = loadConfig(root);
    const issues = validateConfig(config);
    if (issues.length === 0) {
      add('config', 'ok', exists(path.join(root, CONFIG_FILE)) ? CONFIG_FILE : `${CONFIG_FILE}（未生成，用默认值）`);
    } else {
      add('config', 'error', issues.join('；'));
    }
  } catch (err) {
    add('config', 'error', err.message);
  }

  try {
    fs.accessSync(root, fs.constants.W_OK);
    add('writable', 'ok', toPosix(root));
  } catch (err) {
    add('writable', 'error', `${toPosix(root)} 不可写：${err.code}`);
  }

  if (style.isBundled()) {
    const py = style.pythonVersion();
    if (py === null) {
      add('style', 'warn', '随包 harness-style 需要 python3，当前未找到（style 子命令不可用，其余功能不受影响）');
    } else {
      add('style', 'ok', `随包 harness-style（${py.version}）`);
    }
  } else {
    add('style', 'warn', '未随包携带 harness-style（style 子命令不可用）');
  }

  const isRepo = isDir(path.join(root, '.git'));
  add(
    'git',
    isRepo ? 'ok' : 'warn',
    isRepo ? '是 git 仓库（可挂 hooks）' : '不是 git 仓库：门禁只能在 Agent 收尾流程里跑'
  );

  const errors = checks.filter((c) => c.level === 'error');
  const warnings = checks.filter((c) => c.level === 'warn');
  return {
    root: toPosix(root),
    checks,
    summary: {errors: errors.length, warnings: warnings.length, total: checks.length},
  };
}

module.exports = {runDoctor, MIN_NODE_MAJOR};
