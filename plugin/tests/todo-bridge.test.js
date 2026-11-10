'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  mapTodosToSteps,
  pickTask,
  syncTodoWrite,
  handleSessionEvent,
  createTodoBridge,
} = require('../src/todo-bridge.js');
const {loadConfig} = require('../src/config.js');

function makeRepo(tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcli-todo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'todo-demo', version: '1.0.0'}));
  fs.writeFileSync(
    path.join(root, 'harness-cli.json'),
    JSON.stringify({presets: {prototype: {enabled: true}}}, null, 2)
  );
  for (const task of tasks) {
    const dir = path.join(root, 'prototype', task.name);
    fs.mkdirSync(dir, {recursive: true});
    const steps = task.steps
      .map(
        (title, index) =>
          `<li class="step" data-step="${index + 1}" data-spec="S-0${index + 1}">` +
          `<h3><span class="step-no">${index + 1}</span>. ${title}</h3>` +
          `<span class="pct step-pct" data-pct="${task.pcts ? task.pcts[index] : 0}">${task.pcts ? task.pcts[index] : 0}%</span></li>`
      )
      .join('\n');
    fs.writeFileSync(
      path.join(dir, 'progress.html'),
      `<main data-task="${task.name}" data-task-status="进行中"><ol data-plan>${steps}</ol></main>`
    );
    fs.writeFileSync(
      path.join(dir, 'plan.html'),
      `<html data-plan-status="${task.confirmed === false ? '待确认' : '已确认'}"></html>`
    );
  }
  return root;
}

const steps = [
  {no: 1, title: '写契约与失败用例', pct: 0},
  {no: 2, title: '实现账号与会话', pct: 0},
  {no: 3, title: '回归与文档', pct: 0},
];

test('mapTodosToSteps：按标题匹配 completed / in_progress / pending', () => {
  const updates = mapTodosToSteps(
    [
      {content: '写契约与失败用例', status: 'completed'},
      {content: '实现账号与会话', status: 'in_progress'},
      {content: '回归与文档', status: 'pending'},
    ],
    steps
  );
  assert.deepStrictEqual(
    updates.map((item) => [item.step, item.pct]),
    [
      [1, 100],
      [2, 50],
    ]
  );
});

test('mapTodosToSteps：标题完全对不上时按顺序兜底', () => {
  const updates = mapTodosToSteps(
    [
      {content: '甲', status: 'completed'},
      {content: '乙', status: 'pending'},
      {content: '丙', status: 'completed'},
    ],
    steps
  );
  assert.deepStrictEqual(
    updates.map((item) => [item.step, item.pct]),
    [
      [1, 100],
      [3, 100],
    ]
  );
});

test('pickTask：多个进行中任务时用 todo 标题选出唯一任务', () => {
  const root = makeRepo([
    {name: 'login-flow', steps: ['写契约与失败用例', '实现账号与会话']},
    {name: 'search-flow', steps: ['建索引', '写查询接口']},
  ]);
  const {config} = loadConfig(root);
  const picked = pickTask(root, config, [{content: '写契约与失败用例', status: 'completed'}]);
  assert.strictEqual(picked.task.name, 'login-flow');
});

test('syncTodoWrite：只对变化的步骤调 progress，方案未确认也照常写', async () => {
  const root = makeRepo([{name: 'task-demo', steps: ['写契约与失败用例', '实现账号与会话', '回归与文档']}]);
  const calls = [];
  const result = await syncTodoWrite({
    root,
    todos: [
      {content: '写契约与失败用例', status: 'completed'},
      {content: '实现账号与会话', status: 'pending'},
      {content: '回归与文档', status: 'in_progress'},
    ],
    runner: (repo, task, update) => {
      calls.push([repo, task, update.step, update.pct]);
      return Promise.resolve({ok: true});
    },
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    calls.map((item) => [item[1], item[2], item[3]]),
    [
      ['task-demo', 1, 100],
      ['task-demo', 3, 50],
    ]
  );

  // 方案未确认不再拦进度：发起任务就能看到进度，P21 交给 check 在交付前拦
  const unconfirmed = makeRepo([{name: 'task-demo', steps: ['写契约与失败用例'], confirmed: false}]);
  const called = [];
  const stillWrites = await syncTodoWrite({
    root: unconfirmed,
    todos: [{content: '写契约与失败用例', status: 'completed'}],
    runner: (repo, task, update) => {
      called.push([task, update.step, update.pct]);
      return Promise.resolve({ok: true});
    },
  });
  assert.strictEqual(stillWrites.ok, true);
  assert.deepStrictEqual(called, [['task-demo', 1, 100]]);
});

test('handleSessionEvent：非 todo / 子会话 / 缺 cwd 都跳过', async () => {
  const root = makeRepo([{name: 'task-demo', steps: ['写契约与失败用例']}]);
  assert.deepStrictEqual(await handleSessionEvent({header: {cwd: root}}, {type: 'turn/start'}), {
    ok: true,
    skipped: 'not-todo',
  });
  assert.deepStrictEqual(
    await handleSessionEvent({header: {cwd: root, delegationDepth: 1}}, {type: 'todo/write', data: {todos: []}}),
    {ok: true, skipped: 'subagent'}
  );
  assert.deepStrictEqual(await handleSessionEvent({header: {}}, {type: 'todo/write', data: {todos: []}}), {
    ok: true,
    skipped: 'no-cwd',
  });
});

test('createTodoBridge：同一会话的连续事件串行执行', async () => {
  const events = [];
  let active = 0;
  let maxActive = 0;
  const bridge = createTodoBridge({
    runner: (root, task, update) =>
      new Promise((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start-${update.step}`);
        setTimeout(() => {
          events.push(`end-${update.step}`);
          active -= 1;
          resolve({ok: true});
        }, 20);
      }),
  });
  const root = makeRepo([{name: 'task-demo', steps: ['第一步', '第二步']}]);
  const session = {id: 'session-1', header: {cwd: root}};
  const first = bridge.handle(session, {
    type: 'todo/write',
    data: {todos: [{content: '第一步', status: 'completed'}, {content: '第二步', status: 'pending'}]},
  });
  const second = bridge.handle(session, {
    type: 'todo/write',
    data: {todos: [{content: '第一步', status: 'completed'}, {content: '第二步', status: 'completed'}]},
  });
  await Promise.all([first, second]);
  assert.strictEqual(maxActive, 1, `事件没有串行：${events.join(' → ')}`);
});
