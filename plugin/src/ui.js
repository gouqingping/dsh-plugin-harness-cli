'use strict';

/**
 * UI 设计的「反推补全」缺口扫描。
 *
 * 生成 `prototype/<任务>/ui/` 只是第一步：设计说明里的页面目标、契约对应通常是占位，
 * 需要 Agent 读 `docs/specs/<任务>/` 后补全。这里只负责把「还缺什么」变成清单，
 * 由 `/harness-cli-ui` 自动发起对话去补（和 wiki 的做法一致）。
 */

const fs = require('fs');
const path = require('path');
const {readIfExists, writeFileSafe, toPosix} = require('./util');

const REQUIRED_SECTIONS = ['页面目标', '信息架构', '组件清单', '状态', '契约', '响应式'];
const PLACEHOLDER = /待补|待填|TODO/;

/**
 * 扫描一个任务的 UI 设计缺口。
 * @param {string} root - 仓库根目录。
 * @param {string} task - 任务名。
 * @param {object} config - 生效配置。
 * @returns {Array<{file: string, line: number, text: string}>} 缺口清单。
 */
function uiGaps(root, task, config) {
  const proto = ((config.presets || {}).prototype) || {};
  const base = path.join(root, proto.dir || 'prototype', task, 'ui');
  const readme = path.join(base, 'README.md');
  const text = readIfExists(readme);
  if (text === null) {
    return [{file: toPosix(path.relative(root, readme)), line: 0, text: '缺少 ui/README.md（设计说明）'}];
  }

  const gaps = [];
  const relative = toPosix(path.relative(root, readme));
  text.split('\n').forEach((line, index) => {
    if (PLACEHOLDER.test(line)) gaps.push({file: relative, line: index + 1, text: line.trim()});
  });

  const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);
  for (const section of REQUIRED_SECTIONS) {
    if (!headings.some((heading) => heading.includes(section))) {
      gaps.push({file: relative, line: 0, text: `缺少「${section}」章节`});
    }
  }

  // 页面契约表里的契约，必须能在 UI 说明里找到对应
  const pageFile = path.join(root, proto.dir || 'prototype', task, proto.progressPage || 'progress.html');
  const page = readIfExists(pageFile) || '';
  const contracts = [...new Set([...page.matchAll(/data-spec="(S-\d{2,})"/g)].map((m) => m[1]))];
  for (const id of contracts) {
    if (!text.includes(id)) gaps.push({file: relative, line: 0, text: `契约 ${id} 未在 UI 说明中对应`});
  }

  return gaps;
}

/**
 * 把 UI 缺口写成 JSON，返回相对路径。
 * @param {string} root - 仓库根目录。
 * @param {string} task - 任务名。
 * @param {object} config - 生效配置。
 * @param {Array<object>} gaps - uiGaps() 结果。
 * @returns {string} 相对仓库的清单路径。
 */
function writeUiGapReport(root, task, config, gaps) {
  const proto = ((config.presets || {}).prototype) || {};
  const file = path.join(root, proto.dir || 'prototype', task, 'ui', '.ui-gaps.json');
  writeFileSafe(file, `${JSON.stringify({generatedAt: new Date().toISOString(), task, count: gaps.length, gaps}, null, 2)}\n`);
  return toPosix(path.relative(root, file));
}

module.exports = {REQUIRED_SECTIONS, uiGaps, writeUiGapReport};
