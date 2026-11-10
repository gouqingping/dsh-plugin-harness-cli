'use strict';

/**
 * DSH `todo/write` → `prototype/<任务>/progress.html` 桥接。
 *
 * DSH 的 todo 工具每次把整张清单写进会话日志：
 *   event.type = 'todo/write'
 *   event.data.todos = [{content, status}]  // status: pending | in_progress | completed
 *
 * 这里不重写进度逻辑，只做三件事：
 * - 从 `session.header.cwd` 找到仓库，并按配置确认启用了 prototype preset；
 * - 把 todo 标题和任务页步骤标题做匹配，选出唯一任务；
 * - 对变化了的步骤调用 CLI 的 `progress`，让 P21/P22 的确认链继续生效。
 */

const path = require('path');
const {spawn} = require('child_process');
const {loadConfig} = require('./config');
const {collectTasks} = require('./plans');
const {exists, isDir, readIfExists} = require('./util');

const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
const CONFIG_FILES = ['harness-cli.json', 'harness-pro.json', 'common-agent.json'];
const STATUS_PCT = {pending: 0, in_progress: 50, completed: 100};

/** 只保留文字，去掉标点、空白和 HTML，便于中文标题做包含匹配。 */
function normalize(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function matchScore(todo, title) {
  const a = normalize(todo);
  const b = normalize(title);
  if (!a || !b) return 0;
  if (a === b) return 4;
  if (a.includes(b) || b.includes(a)) return 2;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  return prefix >= 4 ? 1 : 0;
}

/** 从任务页里读步骤编号、标题与当前百分比。 */
function parseSteps(html) {
  return [...String(html).matchAll(/<li[^>]*class="[^"]*\bstep\b[^"]*"[^>]*>([\s\S]*?)<\/li>/g)].map((m, index) => {
    const no = /data-step="(\d+)"/.exec(m[0]);
    const pct = /data-pct="(\d+)"/.exec(m[0]);
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(m[1]);
    const title = h3
      ? h3[1]
          .replace(/<span[^>]*class="[^"]*step-no[^"]*"[^>]*>[\s\S]*?<\/span>/, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/^[.．、\s]+/, '')
      : '';
    return {no: no ? Number(no[1]) : index + 1, title, pct: pct ? Number(pct[1]) : 0};
  });
}

function taskScore(todos, steps) {
  let score = 0;
  for (const todo of todos) {
    let best = 0;
    for (const step of steps) best = Math.max(best, matchScore(todo.content, step.title));
    score += best;
  }
  return score;
}

/**
 * 选出 todo 清单对应的任务。
 * 只有一个进行中任务时直接用它；多个任务时要求标题匹配分明显胜出，避免写错页。
 */
function pickTask(root, config, todos) {
  let tasks;
  try {
    tasks = collectTasks(root, config).filter((task) => task.status === '进行中' || task.status === '待验收');
  } catch (err) {
    return {error: `读取任务页失败：${err.message}`};
  }
  if (tasks.length === 0) return {error: '没有进行中的任务'};

  const candidates = tasks.map((task) => {
    const html = readIfExists(path.join(root, task.page)) || '';
    const steps = parseSteps(html);
    return {...task, steps, score: taskScore(todos, steps)};
  });
  candidates.sort((a, b) => b.score - a.score || String(b.updated).localeCompare(String(a.updated)));
  if (candidates.length === 1) return {task: candidates[0]};
  if (candidates[0].score > 0 && candidates[0].score > candidates[1].score) return {task: candidates[0]};
  return {error: `有 ${candidates.length} 个进行中任务，todo 无法唯一匹配`};
}

/** 把 todo 的 completed / in_progress / pending 映射成 100 / 50 / 0。 */
function mapTodosToSteps(todos, steps) {
  const used = new Set();
  const updates = [];
  const indexFallback = todos.length === steps.length;

  todos.forEach((todo, index) => {
    const desired = STATUS_PCT[todo.status];
    if (desired === undefined) return;
    let best = null;
    let bestScore = 0;
    for (const step of steps) {
      if (used.has(step.no)) continue;
      const score = matchScore(todo.content, step.title);
      if (score > bestScore) {
        best = step;
        bestScore = score;
      }
    }
    if (best === null && indexFallback && !used.has(steps[index].no)) best = steps[index];
    if (best === null) return;
    used.add(best.no);
    if (best.pct !== desired) {
      updates.push({step: best.no, pct: desired, title: best.title, content: todo.content});
    }
  });
  return updates;
}

/** 调 CLI 的 progress，让记录、总览同步和门禁确认都走同一条路径。 */
function runProgress(root, task, update, options = {}) {
  return new Promise((resolve) => {
    const env = {...process.env, NO_COLOR: '1', FORCE_COLOR: '0'};
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const args = [
      BIN,
      'progress',
      task,
      '--step',
      String(update.step),
      '--pct',
      String(update.pct),
      '--note',
      `DSH todo：${update.content}`,
      '--agent',
      'dsh-todo',
    ];
    const child = spawn(process.execPath, args, {cwd: root, env});
    let out = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs || 15000);
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ok: false, error: err.message});
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ok: code === 0, code, error: code === 0 ? '' : out.trim(), out});
    });
  });
}

/**
 * 同步一次 todo 清单。
 * @param {{root: string, todos: Array<object>, runner?: Function}} options - 仓库、todo 清单、可注入的进度写入器。
 * @returns {Promise<object>} 结果；skipped 表示按设计跳过，不是故障。
 */
async function syncTodoWrite(options = {}) {
  const {root, todos, runner = runProgress} = options;
  if (!isDir(root)) return {ok: false, skipped: 'invalid-root'};
  if (!CONFIG_FILES.some((name) => exists(path.join(root, name)))) return {ok: true, skipped: 'no-harness-config'};

  let config;
  try {
    ({config} = loadConfig(root));
  } catch (err) {
    return {ok: false, error: err.message};
  }
  const proto = config.presets && config.presets.prototype;
  if (!proto || proto.enabled !== true) return {ok: true, skipped: 'prototype-disabled'};
  if (!Array.isArray(todos) || todos.length === 0) return {ok: true, skipped: 'empty-todos'};

  const picked = pickTask(root, config, todos);
  if (picked.error) {
    // 「没有进行中的任务」是常态，不打扰；多个任务匹配不上才需要人介入
    const ambiguous = /无法唯一匹配/.test(picked.error);
    return {
      ok: false,
      skipped: picked.error,
      warn: ambiguous
        ? `DSH todo 无法唯一匹配到任务（${picked.error}）：进度没有写入，先确认当前只推进一个任务或让步骤标题对得上。`
        : '',
    };
  }
  const task = picked.task;

  // 方案确认不再是写进度的前置条件：发起任务就能看到进度，
  // 「方案未确认」由 check 的 P21 在交付前拦，不在记录环节拦。

  const updates = mapTodosToSteps(todos, task.steps);
  const applied = [];
  for (const update of updates) {
    let result;
    try {
      result = await runner(root, task.name, update);
    } catch (err) {
      result = {ok: false, error: err.message};
    }
    if (!result || result.ok === false) {
      return {ok: false, task: task.name, error: (result && result.error) || 'progress failed', updates: applied};
    }
    applied.push(update);
  }
  return {ok: true, task: task.name, updates: applied};
}

/** 事件入口：只处理顶层会话的 todo/write。 */
async function handleSessionEvent(session, event, options = {}) {
  if (!event || event.type !== 'todo/write') return {ok: true, skipped: 'not-todo'};
  const header = session && session.header;
  if (!header || typeof header.cwd !== 'string' || header.cwd.length === 0) return {ok: true, skipped: 'no-cwd'};
  if (Number(header.delegationDepth) > 0) return {ok: true, skipped: 'subagent'};
  const todos = event.data && event.data.todos;
  if (!Array.isArray(todos)) return {ok: true, skipped: 'bad-payload'};
  return syncTodoWrite({...options, root: header.cwd, todos});
}

/** 同一会话串行处理，避免连续 todo/write 并发跑 progress 互相覆盖。 */
function createTodoBridge(options = {}) {
  const chains = new Map();
  return {
    handle(session, event) {
      if (!event || event.type !== 'todo/write') return Promise.resolve({ok: true, skipped: 'not-todo'});
      const key = (session && session.id) || 'default';
      const previous = chains.get(key) || Promise.resolve();
      const next = previous
        .then(() => handleSessionEvent(session, event, options))
        .catch((err) => ({ok: false, error: err.message || String(err)}));
      chains.set(key, next);
      next.then(
        () => { if (chains.get(key) === next) chains.delete(key); },
        () => { if (chains.get(key) === next) chains.delete(key); }
      );
      return next;
    },
  };
}

module.exports = {
  STATUS_PCT,
  normalize,
  parseSteps,
  matchScore,
  pickTask,
  mapTodosToSteps,
  runProgress,
  syncTodoWrite,
  handleSessionEvent,
  createTodoBridge,
};
