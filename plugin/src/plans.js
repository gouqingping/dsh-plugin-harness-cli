'use strict';

/**
 * plans.html：项目根目录的任务总览面板。
 *
 * - `init` 会生成一份；`plans` 命令重新生成；`page` / `plan` / `ui` / `progress` 之后自动刷新。
 * - 以文件方式打开（file://）时只读：删除 / 重跑 / 保存会提示复制命令。
 * - 运行 `plans --serve` 后，页面通过本机 HTTP 服务调用 /api/delete、/api/rerun、/api/save、
 *   /api/db-layout，按钮才真正落盘（只绑定 127.0.0.1，无鉴权，仅供本机使用）。
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const {spawnSync} = require('child_process');
const {loadTemplate} = require('./templates');
const {render} = require('./render');
const {exists, isDir, readIfExists, readJsonIfExists, writeFileSafe, toPosix, today} = require('./util');
const {
  DB_LAYOUT_FILE,
  readDbLayout,
  writeDbLayout,
  loadOverall,
  renderOverviewPage,
} = require('./db');

const PLANS_FILE = 'plans.html';
const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
const DOC_NAMES = ['flow.md', 'proposal.md', 'spec.md', 'design.md', 'tasks.md'];
const DOC_KEYS = {
  flow: 'flow.md',
  proposal: 'proposal.md',
  spec: 'spec.md',
  design: 'design.md',
  tasks: 'tasks.md',
  database: 'database.md',
  schema: 'schema.sql',
};

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
      // 任务名 → 详细进度页的相对路径；服务端与 file:// 都直接可用（中文按需编码）。
      page: toPosix(path.relative(root, page)),
      status: parsed.status,
      total: parsed.total,
      updated: parsed.updated,
      hasUi: exists(path.join(dir, entry.name, 'ui', 'index.html')),
      hasDb: exists(path.join(dir, entry.name, 'db', 'index.html')),
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
  const dbFile = path.join(root, protoConfig(config).dir || 'prototype', 'db.html');
  const dbPage = exists(dbFile) ? toPosix(path.relative(root, dbFile)) : '';
  const data = JSON.stringify({project: config.project.name, tasks, dbPage}).replace(/</g, '\\u003c');
  return render(loadTemplate('plans'), {
    project: {name: config.project.name},
    taskCount: tasks.length,
    dbPage,
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
function deleteTask(root, config, task, options) {
  const opts = options || {};
  const removed = [];
  const dirs = [taskDir(root, config, task), specDir(root, config, task)];
  for (const dir of dirs) {
    if (exists(dir)) {
      fs.rmSync(dir, {recursive: true, force: true});
      removed.push(toPosix(path.relative(root, dir)));
    }
  }
  // 任务队列里的对应条目也属于「相关数据」，与任务一起删除。
  try {
    const queueFile = path.join(root, config.paths.taskQueue);
    const queue = readJsonIfExists(queueFile, null);
    if (queue && Array.isArray(queue.items)) {
      const nextItems = queue.items.filter((item) => !item || item.task !== task);
      if (nextItems.length !== queue.items.length) {
        queue.items = nextItems;
        queue.updatedAt = new Date().toISOString();
        writeFileSafe(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
      }
    }
  } catch (err) {
    // 队列坏了不阻塞删除；check / 手工修队列会把问题暴露出来。
  }

  // 「重跑」会先把 UI 设计稿备份到 .harness/.rerun-<task>-ui；删除任务时这份相关数据也不该留下。
  // 但 rerunTask 正靠这份备份恢复设计稿，调用时传 keepBackup 跳过清理。
  const backup = path.join(root, config.paths.harness || '.harness', `.rerun-${task}-ui`);
  if (opts.keepBackup !== true && exists(backup)) {
    fs.rmSync(backup, {recursive: true, force: true});
    removed.push(toPosix(path.relative(root, backup)));
  }
  if (opts.deferRefresh !== true) refreshDerived(root, config, {wiki: opts.wiki === true});
  return {ok: true, removed};
}

/**
 * 删除后统一刷新派生页面：
 * - prototype/progress.html（任务总览）
 * - plans.html（任务操作台）
 * - prototype/db.html（整体数模图，按剩余 schema 重生成）
 * - prototype/db-layout.json（清掉已删除表的布局坐标）
 * - 可选 docs/wiki（wiki --update，保留人工正文，只更新受管区块）
 * @returns {{db: boolean, wiki: {status: number, out: string} | null}}
 */
function refreshDerived(root, config, options) {
  const opts = options || {};
  const proto = protoConfig(config);
  const dbFile = path.join(root, proto.dir || 'prototype', 'db.html');
  let dbUpdated = false;
  try {
    const layout = readDbLayout(root, config);
    const overall = loadOverall(root, config);
    // 先清理已删除表的布局坐标，再渲染整体图；否则新页面会继续内嵌旧坐标。
    const tableNames = new Set(overall.tables.map((table) => table.name));
    const positions = {...(layout.positions || {})};
    let layoutChanged = false;
    for (const name of Object.keys(positions)) {
      if (tableNames.has(name)) continue;
      delete positions[name];
      layoutChanged = true;
    }
    if (layoutChanged) {
      writeDbLayout(root, config, {
        version: 1,
        positions,
        updatedAt: new Date().toISOString(),
      });
      // loadOverall 已经读过旧 layout；渲染前替换成清理后的坐标。
      overall.layout = {version: 1, positions};
      dbUpdated = true;
    }
    if (exists(dbFile)) {
      writeFileSafe(dbFile, renderOverviewPage(overall, {generatedAt: new Date().toISOString()}));
      dbUpdated = true;
    }
  } catch (err) {
    // 数模页刷新失败不阻塞删除；下一次 sql 会重建。
  }
  syncIndex(root, config);
  refreshPlans(root, config);
  let wiki = null;
  if (opts.wiki === true) {
    const run = runCli(['wiki', '--update'], root);
    wiki = {status: run.status, out: run.out};
  }
  return {db: dbUpdated, wiki};
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

  deleteTask(root, config, task, {keepBackup: true});
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
    // 文件本来就不存在、用户也没填内容：交给 sql 生成骨架，不写空文件。
    if (content.trim() === '' && !exists(path.join(dir, name))) continue;
    writeFileSafe(path.join(dir, name), content.endsWith('\n') ? content : `${content}\n`);
    written.push(name);
  }
  resetTask(root, config, task);
  refreshPlans(root, config);
  return {ok: true, written};
}

/** 任务开工模式的文件名（任务目录内，随任务一起删除）。 */
const MODE_FILE = '.harness-mode.json';

/** 任务开工模式文件绝对路径。 */
function taskModeFile(root, config, task) {
  return path.join(root, protoConfig(config).dir || 'prototype', task, MODE_FILE);
}

/**
 * 读任务开工模式：auto（自动 loop）/ manual（手动）/ null（未选择）。
 * @returns {'auto' | 'manual' | null}
 */
function readTaskMode(root, config, task) {
  const data = readJsonIfExists(taskModeFile(root, config, task), null);
  return data && (data.mode === 'auto' || data.mode === 'manual') ? data.mode : null;
}

/** 写入任务开工模式；后续方案确认据此决定是否自动选择「确认」。 */
function writeTaskMode(root, config, task, mode) {
  if (mode !== 'auto' && mode !== 'manual') {
    return {ok: false, error: 'mode 只能是 auto / manual'};
  }
  writeFileSafe(
    taskModeFile(root, config, task),
    `${JSON.stringify({mode, selectedAt: new Date().toISOString()}, null, 2)}\n`
  );
  return {ok: true};
}

/**
 * 更新任务队列 task_queue.json 里的一条任务记录。
 * - ui / sql 生成产物后调用：写入 status / progress / artifacts / updatedAt；
 * - progress 只更新已有记录（create:false），不会凭空给每个任务建条目；
 * - 队列文件缺失时按 init 的结构补一个最小队列（create 默认 true）。
 * @returns {{ok: boolean, item?: object, skipped?: string, error?: string}}
 */
function updateTaskQueue(root, config, task, options) {
  const opts = options || {};
  const file = path.join(root, config.paths.taskQueue);
  let queue;
  try {
    queue = readJsonIfExists(file, null);
  } catch (err) {
    return {ok: false, error: err.message};
  }
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) {
    if (opts.create === false) return {ok: true, skipped: 'missing'};
    queue = {
      wipLimit: 1,
      items: [],
      note: '队列 / 优先级 / 依赖 / WIP 四要素；同时 in_progress 的数量不得超过 wipLimit（默认 1 = 单 WIP，多会话并行时调大）。',
      generatedBy: 'dsh-plugin-harness-cli',
      generatedAt: today(),
    };
  }
  if (!Array.isArray(queue.items)) queue.items = [];
  if (!Number.isInteger(queue.wipLimit) || queue.wipLimit < 1) queue.wipLimit = 1;
  const now = new Date().toISOString();
  let item = queue.items.find((entry) => entry && entry.task === task);
  if (!item) {
    if (opts.create === false) return {ok: true, skipped: 'missing'};
    item = {task, artifacts: []};
    queue.items.push(item);
  }
  if (typeof opts.status === 'string' && opts.status.trim().length > 0) item.status = opts.status;
  else if (typeof item.status !== 'string') item.status = '进行中';
  if (Number.isFinite(opts.progress)) item.progress = Math.round(opts.progress);
  const artifacts = new Set(
    [...(Array.isArray(item.artifacts) ? item.artifacts : []), ...(Array.isArray(opts.artifacts) ? opts.artifacts : [])]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
  );
  item.artifacts = [...artifacts];
  item.updatedAt = now;
  queue.updatedAt = now;
  if (typeof queue.generatedAt !== 'string') queue.generatedAt = today();
  if (typeof queue.generatedBy !== 'string') queue.generatedBy = 'dsh-plugin-harness-cli';
  if (typeof queue.note !== 'string') {
    queue.note = '队列 / 优先级 / 依赖 / WIP 四要素；同时 in_progress 的数量不得超过 wipLimit（默认 1 = 单 WIP，多会话并行时调大）。';
  }
  writeFileSafe(file, `${JSON.stringify(queue, null, 2)}\n`);
  return {ok: true, item};
}

/**
 * 保存数模设计文档，然后重跑 sql：刷新 er.mmd、单任务数模图与整体数模图。
 * 与 saveTaskDocs 不同：这里不重启任务（进度 / 方案状态不动），只重建数模产物。
 * @returns {{ok: boolean, written: string[], sql: {status: number, out: string}}}
 */
function saveDbDocs(root, config, task, docs) {
  const dir = specDir(root, config, task);
  const written = [];
  for (const [key, name] of [
    ['database', 'database.md'],
    ['schema', 'schema.sql'],
  ]) {
    const content = docs && typeof docs[key] === 'string' ? docs[key] : null;
    if (content === null) continue;
    // 文件本来就不存在、用户也没填内容：交给 sql 生成骨架，不写空文件。
    if (content.trim() === '' && !exists(path.join(dir, name))) continue;
    writeFileSafe(path.join(dir, name), content.endsWith('\n') ? content : `${content}\n`);
    written.push(name);
  }
  const sql = runCli(['sql', task], root);
  refreshPlans(root, config);
  return {ok: true, written, sql};
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
  const events = new Set();
  let lastSignature = '';
  let poller = null;

  const taskSignature = (tasks) =>
    tasks.map((task) => [task.name, task.total, task.status, task.updated, task.hasUi].join('|')).join('\n');
  const eventBody = (tasks) => `data: ${JSON.stringify({tasks, generatedAt: new Date().toISOString()})}\n\n`;
  const broadcast = (force) => {
    const tasks = collectTasks(rootAbs, config);
    const signature = taskSignature(tasks);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    const body = eventBody(tasks);
    for (const client of events) {
      try {
        client.write(body);
      } catch (err) {
        events.delete(client);
      }
    }
  };
  const cleanup = () => {
    if (poller !== null) clearInterval(poller);
    poller = null;
    for (const client of events) {
      try {
        client.end();
      } catch (err) {
        // 连接可能已被客户端关闭，忽略
      }
    }
    events.clear();
  };

  const server = http.createServer(async (req, res) => {
    const actualPort = server.address()?.port;
    const allowedAuthorities = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
    const allowedOrigins = new Set([...allowedAuthorities].map((authority) => `http://${authority}`));
    const requestHost = String(req.headers.host || '').toLowerCase();
    const requestOrigin = String(req.headers.origin || '').toLowerCase();

    // 仅接受从本机回环地址打开的面板。Host 校验同时阻断 DNS 重绑定；
    // POST 再校验 Origin 与 JSON Content-Type，阻断跨站表单或简单请求触发文件操作。
    if (!allowedAuthorities.has(requestHost)) {
      return sendJson(res, 403, {error: '仅允许通过本机回环地址访问'});
    }
    if (req.method === 'POST' && (
      !allowedOrigins.has(requestOrigin) ||
      !/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))
    )) {
      return sendJson(res, 403, {error: '拒绝跨站或非 JSON 写入请求'});
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && pathname === '/api/tasks') {
      return sendJson(res, 200, {tasks: collectTasks(rootAbs, config), generatedAt: new Date().toISOString()});
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const tasks = collectTasks(rootAbs, config);
      lastSignature = taskSignature(tasks);
      res.write(eventBody(tasks));
      events.add(res);
      res.on('close', () => events.delete(res));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/db-layout') {
      return sendJson(res, 200, readDbLayout(rootAbs, config));
    }

    if (req.method === 'POST' && pathname === '/api/db-layout') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        return sendJson(res, 400, {error: `请求不是合法 JSON：${err.message}`});
      }
      try {
        const saved = writeDbLayout(rootAbs, config, payload);
        const file = toPosix(
          path.relative(rootAbs, path.join(rootAbs, protoConfig(config).dir || 'prototype', DB_LAYOUT_FILE))
        );
        return sendJson(res, 200, {ok: true, file, layout: saved});
      } catch (err) {
        return sendJson(res, 500, {error: err.message});
      }
    }

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
          const removed = deleteTask(rootAbs, config, task, {deferRefresh: true});
          if (removed.removed.length === 0) return sendJson(res, 404, {error: `任务「${task}」不存在或已删除`});
          const derived = refreshDerived(rootAbs, config, {wiki: true});
          return sendJson(res, 200, {...removed, derived});
        }
        if (action === 'rerun') return sendJson(res, 200, rerunTask(rootAbs, config, task));
        if (action === 'save') return sendJson(res, 200, saveTaskDocs(rootAbs, config, task, payload.docs || {}));
        if (action === 'save-db') return sendJson(res, 200, saveDbDocs(rootAbs, config, task, payload.docs || {}));
        return sendJson(res, 404, {error: '未知操作'});
      } catch (err) {
        return sendJson(res, 500, {error: err.message});
      }
    }

    // 总览页每次请求都按当前任务页重新渲染：Agent 每一步更新 progress.html 后，
    // 刷新总览就能看到最新状态，不依赖上一次 plans 命令写下的静态快照。
    if (pathname === '/') {
      res.writeHead(200, {'Content-Type': MIME['.html'], 'Cache-Control': 'no-store'});
      res.end(renderPlans(rootAbs, config));
      return;
    }

    // 页面与静态文件（用于 iframe 预览 UI 设计稿 / 任务详细进度）
    const rel = pathname.replace(/^\/+/, '');
    const target = path.resolve(rootAbs, rel);
    if (target !== rootAbs && !target.startsWith(`${rootAbs}${path.sep}`)) {
      return sendJson(res, 403, {error: '越界访问'});
    }
    let content;
    let stat;
    try {
      stat = fs.statSync(target);
      if (!stat.isFile()) return sendJson(res, 404, {error: `找不到 ${rel}`});
      content = fs.readFileSync(target);
    } catch (err) {
      return sendJson(res, 404, {error: `找不到 ${rel}`});
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': stat.size,
      ETag: `"${Math.floor(stat.mtimeMs).toString(16)}-${stat.size.toString(16)}"`,
      'Last-Modified': stat.mtime.toUTCString(),
    });
    res.end(content);
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      cleanup();
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      poller = setInterval(() => {
        if (events.size > 0) broadcast(false);
      }, 1000);
      if (typeof poller.unref === 'function') poller.unref();
      resolve({
        port: actual,
        server,
        close: () =>
          new Promise((done) => {
            cleanup();
            server.close(done);
          }),
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
  refreshDerived,
  rerunTask,
  saveTaskDocs,
  saveDbDocs,
  updateTaskQueue,
  MODE_FILE,
  readTaskMode,
  writeTaskMode,
  resetTask,
  servePlans,
};
