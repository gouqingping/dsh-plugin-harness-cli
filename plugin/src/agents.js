'use strict';

/**
 * agents：只生成 / 校验入口文件 AGENTS.md。
 * 与 init 分开的理由：入口文件是日常改得最多的那一个，重新生成不该顺带覆盖别的状态文件。
 */

const path = require('path');
const {loadTemplate} = require('./templates');
const {render} = require('./render');
const {buildContext} = require('./context');
const {exists, readIfExists, writeFileSafe} = require('./util');

const SOFT_LIMIT = 100;
const HARD_LIMIT = 120;

function renderAgents(config, opts = {}) {
  const ctx = buildContext(config, opts);
  return render(loadTemplate('agents'), ctx);
}

/** 生成并落盘。返回动作与行数，供 CLI 打印。 */
function generate(root, config, opts = {}) {
  const content = renderAgents(config, opts);
  const file = path.join(root, config.paths.agents);
  const current = readIfExists(file);
  const lines = content.split('\n').length - 1;

  if (current !== null && current.trim() === content.trim() && !opts.force) {
    return {path: file, action: 'keep', lines, content};
  }
  const action = exists(file) ? 'overwrite' : 'create';
  if (!opts.dryRun) writeFileSafe(file, content);
  return {path: file, action, lines, content};
}

/** 行数门槛：与 check 的 A103 同源，避免两处判定打架。 */
function lineVerdict(lines) {
  if (lines > HARD_LIMIT) return {level: 'error', message: `${lines} 行，超过 ${HARD_LIMIT} 行上限`};
  if (lines > SOFT_LIMIT) return {level: 'warn', message: `${lines} 行，超过建议的 ${SOFT_LIMIT} 行`};
  return {level: 'ok', message: `${lines} 行（≤${SOFT_LIMIT}）`};
}

module.exports = {renderAgents, generate, lineVerdict, SOFT_LIMIT, HARD_LIMIT};
