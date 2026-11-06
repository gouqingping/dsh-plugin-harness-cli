'use strict';

/**
 * plans.html：项目根目录的任务总览面板。
 *
 * - `init` 会生成一份；`plans` 命令重新生成；`page` / `plan` / `ui` / `progress` 之后自动刷新。
 * - 以文件方式打开（file://）时只读：删除 / 重跑 / 保存会提示复制命令。
 * - 运行 `plans --serve` 后，页面通过本机 HTTP 服务调用 /api/delete、/api/rerun、/api/save，
 *   按钮才真正落盘（只绑定 127.0.0.1，无鉴权，仅供本机使用）。
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const {spawnSync} = require('child_process');
const {loadTemplate} = require('./templates');
const {render} = require('./render');
const {exists, isDir, readIfExists, writeFileSafe, toPosix} = require('./util');

const PLANS_FILE = 'plans.html';
const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
const DOC_NAMES = ['proposal.md', 'spec.md', 'design.md', 'tasks.md'];
const DOC_KEYS = {proposal: 'proposal.md', spec: 'spec.md', design: 'design.md', tasks: 'tasks.md'};

function protoConfig(config) {
  return (config.presets && config.presets.prototype) || {};
}

function taskDir(root, config, task) {
  return path.join(root, protoConfig(config).dir || 'prototype', task);
}

function specDir(root, config, task) {
  return path.join(root, config.paths.specs || 'docs/specs', task);
}

function parsePage(text) {
  const values = [...String(text).matchAll(/class="[^"]*\bstep-pct\b[^"]*"[^>]*data-pct="([^"]*)"/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  const total = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  const status = (/data-task-status="([^"]*)"/.exec(text) || [])[1] || '进行中';
  const updated = (/<time[^>]*data-updated[^>]*datetime="([^"]*)"/.exec(text) || [])[1] || null;
  return {total, status, updated};
}

/**
 * 收集任务行（给页面与 API 用）。
 * @param {string} root - 仓库根目录。
 * @param {object} config - 生效配置。
 * @returns {Array<object>} 任务列表。
 */
function collectTasks(root, config) {
  const dir = path.join(root, protoConfig(config).dir || 'prototype');
  if (!isDir(dir)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const page = path.join(dir, entry.name, protoConfig(config).progressPage || 'progress.html');
    const text = readIfExists(page);
    const parsed = text === null ? {total: 0, status: '进行中', updated: null} : parsePage(text);
    const docs = {};
    for (const [key, name] of Object.entries(DOC_KEYS)) {
      docs[key] = readIfExists(path.join(specDir(root, config, entry.name), name)) || '';
    }
    rows.push({
      name: entry.name,
      status: parsed.status,
      total: parsed.total,
      updated: parsed.updated,
      hasUi: exists(path.join(dir, entry.name, 'ui', 'index.html')),
      docs,
    });
  }
  rows.sort((a, b) => {
    const order = {进行中: 0, 待验收: 1, 完成: 2};
    return (order[a.status] === undefined ? 9 : order[a.status]) - (order[b.status] === undefined ? 9 : order[b.status]) ||
      a.name.localeCompare(b.name);
  });
  return rows;
}

/**
 * 渲染 plans.html。
 * @param {string} root - 仓库根目录。
 * @param {object} config - 生效配置。
 * @returns {string} HTML。
 */
function renderPlans(root, config) {
  const tasks = collectTasks(root, config);
  const data = JSON.stringify({project: config.project.name, tasks}).replace(/</g, '\\u003c');
  return render(loadTemplate('plans'), {
    project: {name: config.project.name},
    taskCount: tasks.length,
    plansJson: data,
    nowIso: new Date().toISOString(),
  });
}

/** 重新生成 plans.html（失败不抛出，避免影响主流程）。 */
function refreshPlans(root, config) {
  try {
    writeFileSafe(path.join(root, PLANS_FILE), renderPlans(root, config));
    return true;
  } catch (err) {
    return false;
  }
}

/** 同步总览页（prototype/progress.html）；没有任务页能力时跳过。 */
function syncIndex(root, config) {
  const check = path.join(root, config.paths.prototypeCheck || 'scripts/prototype-check.js');
  if (!exists(check)) return;
  spawnSync(process.execPath, [check, '--sync'], {cwd: root, encoding: 'utf8'});
}

/** 跑一次 CLI（内部动作复用同一套逻辑，避免在服务里重写）。 */
function runCli(args, root) {
  const result = spawnSync(process.execPath, [BIN, ...args], {cwd: root, encoding: 'utf8'});
  return {
    status: result.status === null ? 1 : result.status,
    out: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

/**
 * 删除任务：任务页、设计稿、规范文档、复盘。
 * @returns {{ok: boolean, removed: string[]}}
 */
function deleteTask(root, config, task) {
  const removed = [];
  const dirs = [taskDir(root, config, task), specDir(root, config, task)];
  for (const dir of dirs) {
    if (exists(dir)) {
      fs.rmSync(dir, {recursive: true, force: true});
      removed.push(toPosix(path.relative(root, dir)));
    }
  }
  syncIndex(root, config);
  refreshPlans(root, config);
  return {ok: true, removed};
}

/**
 * 重跑任务：删掉旧产物，按默认内容重建任务页 + 文档 + 方案页。
 * UI 设计稿属于设计资产，重跑时先备份再恢复（不会因为「重跑」丢掉设计）。
 */
function rerunTask(root, config, task) {
  const uiDir = path.join(taskDir(root, config, task), 'ui');
  const backup = path.join(root, config.paths.harness || '.harness', `.rerun-${task}-ui`);
  const hadUi = exists(uiDir);
  if (hadUi) {
    fs.rmSync(backup, {recursive: true, force: true});
    fs.mkdirSync(path.dirname(backup), {recursive: true});
    fs.cpSync(uiDir, backup, {recursive: true});
  }

  deleteTask(root, config, task);
  const page = runCli(['page', task], root);
  if (page.status !== 0) return {ok: false, error: page.out || '重建任务页失败'};
  const plan = runCli(['plan', task], root);
  if (plan.status !== 0) return {ok: false, error: plan.out || '补全文档失败'};

  if (hadUi) {
    fs.cpSync(backup, uiDir, {recursive: true});
    fs.rmSync(backup, {recursive: true, force: true});
    // 恢复设计稿后同步 design.md 摘要与总览的 UI 标记
    runCli(['ui', task], root);
  }

  refreshPlans(root, config);
  syncIndex(root, config);
  return {ok: true, out: `${page.out}\n${plan.out}`.trim()};
}

/** 把页面进度归零、状态回到「进行中」，并让方案回到「待确认」。 */
function resetTask(root, config, task) {
  const page = path.join(taskDir(root, config, task), protoConfig(config).progressPage || 'progress.html');
  const text = readIfExists(page);
  if (text !== null) {
    const now = new Date().toISOString();
    let next = text
      .replace(/class="pct step-pct"([^>]*)data-pct="\d+"([^>]*)>\s*\d+%/g, 'class="pct step-pct"$1data-pct="0"$2>0%')
      .replace(/data-task-status="[^"]*"/, 'data-task-status="进行中"')
      .replace(/(<span[^>]*data-task-status-label[^>]*>)[^<]*(<\/span>)/, '$1进行中$2');
    next = next.replace(
      /(<ul[^>]*class="[^"]*\blog-list\b[^"]*"[^>]*>)([\s\S]*?)(<\/ul>)/,
      `$1\n      <li data-at="${now}" data-total="0">重启任务：进度归零，等待重新复盘与确认</li>\n    $3`
    );
    next = next.replace(/(<time[^>]*data-updated[^>]*datetime=")[^"]*(">)[^<]*(<\/time>)/, `$1${now}$2${now}$3`);
    writeFileSafe(page, next);
  }

  const plan = path.join(taskDir(root, config, task), 'plan.html');
  const planText = readIfExists(plan);
  if (planText !== null) {
    const next = planText
      .replace(/data-plan-status="[^"]*"/, 'data-plan-status="待确认"')
      .replace(/data-confirmed-by="[^"]*"/, 'data-confirmed-by=""')
      .replace(/data-confirmed-at="[^"]*"/, 'data-confirmed-at=""')
      .replace(/data-docs-hash="[^"]*"/, 'data-docs-hash=""')
      .replace(/data-plan-status-label>已确认</, 'data-plan-status-label>待确认<')
      .replace(/data-confirmed-by-label>[^<]*</, 'data-confirmed-by-label>—<')
      .replace(/data-confirmed-at-label>[^<]*</, 'data-confirmed-at-label>—<');
    writeFileSafe(plan, next);
  }

  const review = path.join(specDir(root, config, task), 'review.md');
  if (exists(review)) fs.rmSync(review, {force: true});
  syncIndex(root, config);
}

/**
 * 保存人工编辑的文档，然后重启任务（进度归零 + 方案待确认）。
 * @returns {{ok: boolean, written: string[]}}
 */
function saveTaskDocs(root, config, task, docs) {
  const dir = specDir(root, config, task);
  const written = [];
  for (const [key, name] of Object.entries(DOC_KEYS)) {
    const content = docs && typeof docs[key] === 'string' ? docs[key] : null;
    if (content === null) continue;
    writeFileSafe(path.join(dir, name), content.endsWith('\n') ? content : `${content}\n`);
    written.push(name);
  }
  resetTask(root, config, task);
  refreshPlans(root, config);
  return {ok: true, written};
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体超过 4MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 启动本地服务：页面 + 三个动作 API + 静态文件（用于 UI 预览）。
 * @param {string} root - 仓库根目录。
 * @param {object} config - 生效配置。
 * @param {number} port - 端口；0 表示随机端口。
 * @returns {Promise<{port: number, close: Function, server: object}>}
 */
function servePlans(root, config, port) {
  const rootAbs = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        return sendJson(res, 400, {error: `请求不是合法 JSON：${err.message}`});
      }
      const task = String(payload.task || '').trim();
      if (!task || !/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(task)) {
        return sendJson(res, 400, {error: '任务名不合法'});
      }
      const action = pathname.slice('/api/'.length);
      try {
        if (action === 'delete') {
          const removed = deleteTask(rootAbs, config, task);
          if (removed.removed.length === 0) return sendJson(res, 404, {error: `任务「${task}」不存在或已删除`});
          return sendJson(res, 200, removed);
        }
        if (action === 'rerun') return sendJson(res, 200, rerunTask(rootAbs, config, task));
        if (action === 'save') return sendJson(res, 200, saveTaskDocs(rootAbs, config, task, payload.docs || {}));
        return sendJson(res, 404, {error: '未知操作'});
      } catch (err) {
        return sendJson(res, 500, {error: err.message});
      }
    }

    // 页面与静态文件（用于 iframe 预览 UI 设计稿）
    const rel = pathname === '/' ? PLANS_FILE : pathname.replace(/^\/+/, '');
    const target = path.resolve(rootAbs, rel);
    if (target !== rootAbs && !target.startsWith(`${rootAbs}${path.sep}`)) {
      return sendJson(res, 403, {error: '越界访问'});
    }
    let content;
    try {
      content = fs.readFileSync(target);
    } catch (err) {
      return sendJson(res, 404, {error: `找不到 ${rel}`});
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        server,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = {
  PLANS_FILE,
  collectTasks,
  renderPlans,
  refreshPlans,
  deleteTask,
  rerunTask,
  saveTaskDocs,
  resetTask,
  servePlans,
};
