'use strict';

/**
 * 规格同步：`docs/wiki`（业务视图）与 `prototype/<任务>/ui/index.html`（设计视图）
 * 一变，就把对应的事实写回 `docs/specs/<任务>/`，并在文档里留下指纹。
 *
 * 为什么用「指纹 + 受管区块」：
 * - 文档是人可以改的，不能整篇覆盖；只更新标记块；
 * - 指纹让「改了 UI / 改了 wiki 但没同步 specs」变成可判定的事实（P23 / P24）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {readIfExists, writeFileSafe, toPosix} = require('./util');

const UI_BEGIN = '<!-- ui-design:begin -->';
const UI_END = '<!-- ui-design:end -->';
const WIKI_BEGIN = '<!-- wiki-context:begin -->';
const WIKI_END = '<!-- wiki-context:end -->';

/** 与原型判定同源的 antd 组件清单（只用于摘要，不参与判定）。 */
const UI_COMPONENTS = [
  'Layout', 'Sider', 'Header', 'Breadcrumb', 'Avatar', 'PageHeader', 'Button', 'Statistic',
  'Table', 'Tag', 'Progress', 'Pagination', 'Descriptions', 'Form', 'Input', 'Select',
  'Radio', 'Switch', 'Modal', 'Drawer', 'Empty', 'Skeleton', 'Alert', 'Tabs', 'Card',
];

const UI_STATES = ['加载', '空', '错误', '无权限', '成功'];

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** 读取页面里出现的组件名/状态/段落标题（用于摘要，不做判定）。 */
function summarizeUi(html) {
  const components = UI_COMPONENTS.filter((name) => new RegExp(`\\b${name}\\b`).test(html));
  const states = UI_STATES.filter((name) => html.includes(name));
  const sections = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, '').trim())
    .filter((text) => text.length > 0)
    .slice(0, 8);
  return {components, states, sections};
}

/**
 * 计算 ui/index.html 的指纹。
 * @param {string} root - 仓库根目录。
 * @param {string} task - 任务名。
 * @param {object} paths - config.paths。
 * @returns {{file: string, exists: boolean, hash: string | null, summary: object | null}}
 */
function uiFacts(root, task, paths) {
  const file = path.join(root, paths.prototype || 'prototype', task, 'ui', 'index.html');
  const text = readIfExists(file);
  if (text === null) return {file, exists: false, hash: null, summary: null};
  const normalized = text.replace(/\r\n/g, '\n').trim();
  return {
    file,
    exists: true,
    hash: `sha1:${sha1(normalized)}`,
    summary: summarizeUi(normalized),
  };
}

/**
 * 计算 docs/wiki 的指纹：所有 md 文件（按名字排序）的内容。
 * @param {string} root - 仓库根目录。
 * @param {object} paths - config.paths。
 * @returns {{dir: string, exists: boolean, hash: string | null, files: string[]}}
 */
function wikiFacts(root, paths) {
  const dir = path.join(root, paths.wiki || 'docs/wiki');
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
  } catch (err) {
    return {dir, exists: false, hash: null, files: []};
  }
  if (entries.length === 0) return {dir, exists: false, hash: null, files: []};
  const text = entries
    .map((name) => `${name}\n${(readIfExists(path.join(dir, name)) || '').replace(/\r\n/g, '\n').trim()}`)
    .join('\n');
  return {dir, exists: true, hash: `sha1:${sha1(text)}`, files: entries};
}

/** 用内容替换（或追加）一个受管区块。 */
function upsertBlock(text, begin, end, body) {
  const block = `${begin}\n${body.trim()}\n${end}`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start !== -1 && stop !== -1 && stop > start) {
    return `${text.slice(0, start)}${block}${text.slice(stop + end.length)}`;
  }
  return `${text.trim()}\n\n${block}\n`;
}

/**
 * 把 UI 设计同步进 `docs/specs/<任务>/design.md`。
 * @returns {{action: 'updated' | 'skipped' | 'unchanged', hash?: string}}
 */
function syncDesignFromUi(root, task, paths) {
  const facts = uiFacts(root, task, paths);
  if (!facts.exists) return {action: 'skipped'};
  const file = path.join(root, paths.specs || 'docs/specs', task, 'design.md');
  const text = readIfExists(file);
  if (text === null) return {action: 'skipped'};
  const body = [
    '## 6. UI 设计（与 `prototype/' + task + '/ui/index.html` 同步）',
    '',
    `- 设计稿：\`${toPosix(path.relative(root, facts.file))}\``,
    `- 指纹：\`${facts.hash}\``,
    `- 组件：${facts.summary.components.join('、') || '（未识别到 antd 组件）'}`,
    `- 状态：${facts.summary.states.join(' / ') || '（未识别到状态段落）'}`,
    `- 区块：${facts.summary.sections.join(' / ') || '—'}`,
    '',
    '> 这一段由 `ui` / `plan` / `wiki` 自动维护；改设计稿后重新跑 `ui` 即可同步。',
  ].join('\n');
  const next = upsertBlock(text, UI_BEGIN, UI_END, body);
  if (next === text) return {action: 'unchanged', hash: facts.hash};
  writeFileSafe(file, next);
  return {action: 'updated', hash: facts.hash};
}

/**
 * 把业务 wiki 的背景同步进每个任务的 `docs/specs/<任务>/proposal.md`。
 * @param {string} root - 仓库根目录。
 * @param {object} paths - config.paths。
 * @param {(task: string) => object} factsOf - 返回该任务的业务事实（可选）。
 * @returns {{action: 'updated' | 'skipped' | 'unchanged', tasks: string[]}}
 */
function syncProposalFromWiki(root, paths, factsOf) {
  const facts = wikiFacts(root, paths);
  if (!facts.exists) return {action: 'skipped', tasks: []};
  const specsDir = path.join(root, paths.specs || 'docs/specs');
  let tasks = [];
  try {
    tasks = fs.readdirSync(specsDir, {withFileTypes: true})
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    return {action: 'skipped', tasks: []};
  }

  let touched = 0;
  for (const task of tasks) {
    const file = path.join(specsDir, task, 'proposal.md');
    const text = readIfExists(file);
    if (text === null) continue;
    const info = typeof factsOf === 'function' ? factsOf(task) : {};
    const body = [
      '## 5. 业务背景（与 `docs/wiki/` 同步）',
      '',
      `- 来源：\`${toPosix(path.relative(root, facts.dir))}/\``,
      `- 指纹：\`${facts.hash}\``,
      `- 项目：${info.project || '（见 docs/wiki）'}`,
      `- 业务域：${info.domains || '（见 docs/wiki）'}`,
      `- 功能规模：${info.counts || '（见 docs/wiki）'}`,
      '',
      '> 这一段由 `wiki` / `plan` 自动维护；业务文档更新后重新跑 `wiki` 即可同步。',
    ].join('\n');
    const next = upsertBlock(text, WIKI_BEGIN, WIKI_END, body);
    if (next !== text) {
      writeFileSafe(file, next);
      touched += 1;
    }
  }
  return {action: touched > 0 ? 'updated' : 'unchanged', tasks};
}

module.exports = {
  UI_BEGIN,
  UI_END,
  WIKI_BEGIN,
  WIKI_END,
  uiFacts,
  wikiFacts,
  syncDesignFromUi,
  syncProposalFromWiki,
};
