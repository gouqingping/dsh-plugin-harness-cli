'use strict';

/**
 * cordis 适配层单测：工具注册形状、目标目录解析、以及「判定真的会失败」的反向用例。
 *
 * 这里是 CJS 测试文件，被测模块是 ESM（`plugin/cordis.mjs`），用动态 import 加载。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');

/** 造一个临时仓库目录。 */
function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hcli-cordis-'));
}

/** 造一个假的 exec：只提供 cwd 与 signal。 */
function fakeExec(cwd) {
  return {agent: {session: {header: {cwd}}}, signal: undefined};
}

/** 冒烟用的假 ctx：记录注册项，并模拟 `ctx.inject`。 */
function fakeCtx(options) {
  const opts = options || {};
  const tools = [];
  const commands = [];
  const events = [];
  const ctx = {
    get(name) {
      return name === 'userQuestions' ? opts.userQuestions : undefined;
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    commands: {
      register(definition) {
        commands.push(definition);
        return () => {};
      },
    },
    inject(deps, callback) {
      assert.deepStrictEqual(deps, ['commands']);
      callback(ctx);
      return () => {};
    },
    on(name, handler) {
      events.push({name, handler});
      return () => {};
    },
  };
  return {ctx, tools, commands, events};
}

test('模块导出 cordis 插件契约', async () => {
  const mod = await import('../cordis.mjs');
  assert.strictEqual(mod.name, 'harness-cli');
  assert.deepStrictEqual(mod.inject, ['tools']);
  assert.strictEqual(typeof mod.apply, 'function');
  assert.strictEqual(mod.TOOL_SPECS.length, 12);
});

/** 取聚合指令并按子指令前缀调用（等价于 /harness-cli <sub> ...）。 */
function commandFor(commands, sub) {
  const aggregated = commands.find((command) => command.name === 'harness-cli');
  assert.ok(aggregated, '应注册聚合指令 /harness-cli');
  return {
    handler: (invocation) => {
      const rest = String(invocation && invocation.rawInput ? invocation.rawInput : '').trim();
      return aggregated.handler({...invocation, rawInput: rest ? `${sub} ${rest}` : sub});
    },
  };
}

/** 一个会记录提问并按标签作答的假 userQuestions。 */
function fakeQuestions(answer) {
  const asked = [];
  return {
    asked,
    async ask(request) {
      asked.push(request);
      return {answers: [{id: 'harness-cli', selected: [answer], custom: undefined}]};
    },
  };
}

test('harness_cli_delete：弹窗选「删除」才真的删', async () => {
  const mod = await import('../cordis.mjs');
  const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'init', '--preset', 'prototype', '--root', dir], {cwd: dir});
  execFileSync(process.execPath, [BIN, 'page', 'task-demo', '--root', dir], {cwd: dir});

  const questions = fakeQuestions('删除');
  const {ctx, tools} = fakeCtx({userQuestions: questions});
  mod.apply(ctx);
  const tool = tools.find((item) => item.name === 'harness_cli_delete');
  assert.ok(tool, '应注册 harness_cli_delete');

  const result = await tool.execute({task: 'task-demo'}, fakeExec(dir));
  assert.strictEqual(result.exitCode, 0, result.report);
  assert.strictEqual(questions.asked.length, 1, '删除前必须弹窗');
  assert.ok(!fs.existsSync(path.join(dir, 'prototype/task-demo')));
});

test('harness_cli_delete：弹窗选「取消」时不动任何文件', async () => {
  const mod = await import('../cordis.mjs');
  const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'init', '--preset', 'prototype', '--root', dir], {cwd: dir});
  execFileSync(process.execPath, [BIN, 'page', 'task-demo', '--root', dir], {cwd: dir});

  const {ctx, tools} = fakeCtx({userQuestions: fakeQuestions('取消')});
  mod.apply(ctx);
  const tool = tools.find((item) => item.name === 'harness_cli_delete');
  const result = await tool.execute({task: 'task-demo'}, fakeExec(dir));
  assert.strictEqual(result.ok, false);
  assert.match(result.report, /已取消删除/);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/task-demo')));
});

test('harness_cli_wiki：冲突时弹窗，选「接管」后补区块并保留正文', async () => {
  const mod = await import('../cordis.mjs');
  const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'init', '--root', dir], {cwd: dir});
  execFileSync(process.execPath, [BIN, 'wiki', '--root', dir], {cwd: dir});

  const file = path.join(dir, 'docs/wiki/术语表.md');
  const stripped = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/harness-wiki:(begin|end)/.test(line))
    .join('\n');
  fs.writeFileSync(file, stripped);

  const {ctx, tools} = fakeCtx({userQuestions: fakeQuestions('接管既有文档')});
  mod.apply(ctx);
  const tool = tools.find((item) => item.name === 'harness_cli_wiki');
  const result = await tool.execute({}, fakeExec(dir));

  assert.strictEqual(result.exitCode, 0, result.report);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('<!-- harness-wiki:begin -->'), '应补上受管区块');
  assert.ok(text.includes('## 1. 体系与文件'), '人工正文应原样保留');
});

test('harness_cli_plan：确认时弹窗，选「确认」后自动补确认人', async () => {
  const mod = await import('../cordis.mjs');
  const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'init', '--preset', 'prototype', '--root', dir], {cwd: dir});
  execFileSync(process.execPath, [BIN, 'page', 'task-demo', '--root', dir], {cwd: dir});
  const model = {
    goal: '用手机号+密码完成登录闭环',
    scope: '登录表单、校验、错误提示与会话发放',
    nonGoals: ['第三方登录', '找回密码'],
    context: '身份与访问控制',
    terms: [
      {term: '账号', definition: '可被认证的主体'},
      {term: '会话', definition: '认证后的凭证集合'},
      {term: '锁定', definition: '连续失败后禁止认证'},
    ],
    aggregates: ['聚合根 Account：守住凭据与锁定状态'],
    invariants: ['锁定账号不接受任何密码校验'],
    contracts: [
      {id: 'S-01', title: '用手机号+密码换取会话', input: '手机号、密码', output: '返回 token', error: '密码错 401；锁定 423', accept: 'node --test 覆盖 401/423'},
      {id: 'S-02', title: '连续失败 5 次锁定账号', input: '同一账号 5 次错误密码', output: '账号进入锁定', error: '第 6 次仍返回 423', accept: '测试覆盖第 5、6 次'},
    ],
    steps: [
      {title: '写契约与失败用例', spec: 'S-01'},
      {title: '实现账号与会话', spec: 'S-02'},
      {title: '回归与文档', spec: 'S-02'},
    ],
    acceptance: ['S-01、S-02 的验收标准全部可执行', '门禁全绿'],
  };
  execFileSync(
    process.execPath,
    [BIN, 'plan', 'task-demo', '--input-json', JSON.stringify(model), '--force', '--root', dir],
    {cwd: dir}
  );
  execFileSync(process.execPath, [BIN, 'review', 'task-demo', '--root', dir], {cwd: dir});

  const questions = fakeQuestions('确认');
  const {ctx, tools} = fakeCtx({userQuestions: questions});
  mod.apply(ctx);
  const tool = tools.find((item) => item.name === 'harness_cli_plan');
  const result = await tool.execute({task: 'task-demo', confirm: true}, fakeExec(dir));

  assert.strictEqual(result.exitCode, 0, result.report);
  assert.strictEqual(questions.asked.length, 1);
  const planText = fs.readFileSync(path.join(dir, 'prototype/task-demo/plan.html'), 'utf8');
  assert.match(planText, /data-plan-status="已确认"/);
  assert.match(planText, /用户（弹窗确认）/);
});

test('apply 注册全部工具与斜杠命令', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, tools, commands} = fakeCtx();
  mod.apply(ctx);

  assert.deepStrictEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'harness_cli_agents',
      'harness_cli_check',
      'harness_cli_delete',
      'harness_cli_doctor',
      'harness_cli_init',
      'harness_cli_page',
      'harness_cli_plan',
      'harness_cli_progress',
      'harness_cli_review',
      'harness_cli_style',
      'harness_cli_ui',
      'harness_cli_wiki',
    ]
  );
  assert.deepStrictEqual(
    commands.map((command) => command.name).sort(),
    ['harness-cli'],
    '指令菜单只保留一条聚合入口，子指令走弹窗或 /harness-cli <子指令>'
  );
});

test('apply 订阅 session/event，todo/write 没有仓库配置时安全跳过', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, events} = fakeCtx();
  mod.apply(ctx);

  const registration = events.find((item) => item.name === 'session/event');
  assert.ok(registration, '应订阅 session/event');
  const result = await registration.handler(
    {id: 'session-1', header: {cwd: tmpRepo()}},
    {type: 'todo/write', data: {todos: [{content: '一步', status: 'completed'}]}}
  );
  assert.deepStrictEqual(result, {ok: true, skipped: 'no-harness-config'});
});

test('每个工具都是 object 根 schema + 可渲染的输出', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, tools} = fakeCtx();
  mod.apply(ctx);

  for (const tool of tools) {
    assert.strictEqual(tool.parameters.type, 'object', `${tool.name} 的 parameters 必须是 object 根`);
    assert.strictEqual(tool.parameters.additionalProperties, false);
    assert.ok(Array.isArray(tool.parameters.required), `${tool.name} 必须显式声明 required`);
    assert.ok(tool.output && typeof tool.output.render === 'function', `${tool.name} 缺少 output.render`);
    const rendered = tool.output.render({}, {
      root: '/tmp/x',
      command: 'check',
      args: ['check'],
      exitCode: 1,
      ok: false,
      report: '报告正文\n',
    });
    assert.deepStrictEqual(rendered, [{type: 'text', text: '报告正文\n'}]);
  }
});

test('空仓库 check 失败（退出码 1），init 之后 check 通过', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, tools} = fakeCtx();
  mod.apply(ctx);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const dir = tmpRepo();
  const init = byName.get('harness_cli_init');
  const check = byName.get('harness_cli_check');

  const before = await check.execute({}, fakeExec(dir));
  assert.strictEqual(before.exitCode, 1, '空仓库应当判失败');
  assert.strictEqual(before.ok, false);
  assert.match(before.report, /退出码 1/);

  const scaffold = await init.execute({preset: 'prototype', dry_run: true}, fakeExec(dir));
  assert.strictEqual(scaffold.exitCode, 0, scaffold.report);
  assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')), 'dry_run 不能落盘');

  const real = await init.execute({preset: 'prototype'}, fakeExec(dir));
  assert.strictEqual(real.exitCode, 0, real.report);
  assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(dir, 'scripts', 'gate.sh')));

  const after = await check.execute({}, fakeExec(dir));
  assert.strictEqual(after.exitCode, 0, after.report);
  assert.strictEqual(after.ok, true);
  assert.strictEqual(after.command, 'check');
  assert.deepStrictEqual(after.args, ['check']);
});

test('doctor 在真实插件目录里自检通过', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, tools} = fakeCtx();
  mod.apply(ctx);
  const doctor = tools.find((tool) => tool.name === 'harness_cli_doctor');
  const pluginDir = path.resolve(__dirname, '..');
  const value = await doctor.execute({}, fakeExec(pluginDir));
  assert.strictEqual(value.exitCode, 0, value.report);
  assert.match(value.report, /模板/);
});

test('目标目录不存在时给出人话错误，而不是 ENOENT', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, tools} = fakeCtx();
  mod.apply(ctx);
  const check = tools.find((tool) => tool.name === 'harness_cli_check');
  await assert.rejects(
    () => check.execute({root: path.join(os.tmpdir(), 'hcli-does-not-exist-xyz')}, fakeExec(os.tmpdir())),
    /目标目录不存在/
  );
});

test('style 缺参数时不启动子进程', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, tools} = fakeCtx();
  mod.apply(ctx);
  const style = tools.find((tool) => tool.name === 'harness_cli_style');
  await assert.rejects(() => style.execute({args: []}, fakeExec(process.cwd())), /args/);
});

test('resolveRoot：显式路径按 cwd 解析，无 cwd 且无 root 时拒绝', async () => {
  const mod = await import('../cordis.mjs');
  assert.deepStrictEqual(mod.resolveRoot('sub/dir', '/work'), {root: path.resolve('/work', 'sub/dir')});
  assert.deepStrictEqual(mod.resolveRoot(undefined, '/work'), {root: '/work'});
  assert.deepStrictEqual(mod.resolveRoot('/abs/path', undefined), {root: '/abs/path'});
  assert.match(mod.resolveRoot(undefined, undefined).error, /root/);
  assert.match(mod.resolveRoot(undefined, '/').error, /root/);
  assert.match(mod.resolveRoot(42, '/work').error, /root/);
});

test('parseCommandInput：位置参数与 flag', async () => {
  const mod = await import('../cordis.mjs');
  assert.deepStrictEqual(mod.parseCommandInput(''), {});
  assert.deepStrictEqual(mod.parseCommandInput('/repo --strict'), {root: '/repo', strict: true});
  assert.deepStrictEqual(mod.parseCommandInput('--preset prototype --force'), {preset: 'prototype', force: true});
  assert.match(mod.parseCommandInput('--root').error, /--root/);
  assert.match(mod.parseCommandInput('--bogus').error, /无法识别/);
});

test('parseTaskInput：任务名在前，root 用 --root 或第二个位置参数', async () => {
  const mod = await import('../cordis.mjs');
  assert.deepStrictEqual(mod.parseTaskInput('登录页面'), {task: '登录页面'});
  assert.deepStrictEqual(mod.parseTaskInput('登录页面 --force'), {task: '登录页面', force: true});
  assert.deepStrictEqual(mod.parseTaskInput('login-flow --root /tmp/x'), {task: 'login-flow', root: '/tmp/x'});
  assert.deepStrictEqual(mod.parseTaskInput('login-flow /tmp/x'), {task: 'login-flow', root: '/tmp/x'});
  assert.deepStrictEqual(mod.parseTaskInput('登录页面 --user-words "先把登录做了"'), {
    task: '登录页面',
    userWords: '先把登录做了',
  });
  assert.match(mod.parseTaskInput('--root').error, /--root/);
  assert.match(mod.parseTaskInput('t --bogus').error, /无法识别/);
});

test('/harness-cli ui：中文任务名也能生成（目录自动创建）', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const ui = commands.find((command) => command.name === 'harness-cli');
  assert.ok(ui, '应注册聚合指令 /harness-cli');

  const dir = tmpRepo();
  const result = await ui.handler({
    rawInput: 'ui 登录页面',
    agent: {session: {header: {cwd: dir}}},
  });
  assert.strictEqual(result.kind, 'success', result.text);
  assert.ok(fs.existsSync(path.join(dir, 'prototype', '登录页面', 'ui', 'index.html')));
  assert.ok(fs.existsSync(path.join(dir, 'prototype', '登录页面', 'ui', 'README.md')));
});

test('/harness-cli ui：显式 --root 指向不存在的目录时主动创建', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const ui = commands.find((command) => command.name === 'harness-cli');

  const base = tmpRepo();
  const target = path.join(base, 'new-project');
  const result = await ui.handler({
    rawInput: `ui 登录页面 --root "${target}"`,
    agent: {session: {header: {cwd: base}}},
  });
  assert.strictEqual(result.kind, 'success', result.text);
  assert.ok(fs.existsSync(path.join(target, 'prototype', '登录页面', 'ui', 'index.html')));
});

test('/harness-cli help：列出全部命令与工具，并支持按名字查看', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);

  // 帮助手册与真实注册项必须同名（防止加了命令忘了写说明）
  assert.deepStrictEqual(
    commands.map((command) => command.name).sort(),
    mod.COMMAND_MANUAL.map((item) => item.name).sort()
  );

  const help = commands.find((command) => command.name === 'harness-cli');
  const full = await help.handler({rawInput: 'help'});
  assert.strictEqual(full.kind, 'success');
  for (const item of mod.COMMAND_MANUAL) assert.ok(full.text.includes('/' + item.name), `缺少 ${item.name}`);
  for (const spec of mod.TOOL_SPECS) assert.ok(full.text.includes(spec.toolName), `缺少 ${spec.toolName}`);
  assert.match(full.text, /任务标准流程/);
  assert.match(full.text, /自动 loop/);
  assert.match(full.text, /退出码/);

  const one = await help.handler({rawInput: 'help ui'});
  assert.match(one.text, /harness_cli_ui/);
  assert.doesNotMatch(one.text, /harness_cli_wiki/);

  const tool = await help.handler({rawInput: 'help harness_cli_progress'});
  assert.match(tool.text, /harness_cli_progress/);

  const missing = await help.handler({rawInput: 'help nope'});
  assert.match(missing.text, /没有找到/);
});

test('/harness-cli：不带子指令时弹窗选中文项并执行', async () => {
  const mod = await import('../cordis.mjs');
  const asked = [];
  const {ctx, commands} = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return {answers: [{id: 'harness-cli', selected: ['帮助']}]};
      },
    },
  });
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');
  const res = await cli.handler({rawInput: '', agent: {session: {header: {cwd: tmpRepo()}}}});

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 1, '应弹一次选择框');
  const question = asked[0].questions[0];
  assert.strictEqual(question.header, 'Harness 指令');
  assert.strictEqual(question.question, '选择要执行的 Harness 指令：');
  assert.deepStrictEqual(
    question.options.map((option) => option.label),
    ['初始化', '校验', '自检', '建任务', '方案', '复盘', '推进度', 'UI 设计', '删除任务', '业务 wiki', '任务总览', '入口地图', '帮助']
  );
  // 选「帮助」→ 走 help 子指令
  assert.match(res.text, /harness_cli_progress/);
});

test('/harness-cli：没有选择框时给出原因与子指令写法，不泄漏内部提示', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');
  const res = await cli.handler({rawInput: '', agent: {session: {header: {cwd: tmpRepo()}}}});
  assert.strictEqual(res.kind, 'error');
  assert.match(res.text, /选择框没有弹出来/);
  assert.match(res.text, /\/harness-cli check/);
});

test('/harness-cli：选到需要参数的子指令时，再弹一次输入框拿任务名', async () => {
  const mod = await import('../cordis.mjs');
  const asked = [];
  const answers = [
    {answers: [{id: 'harness-cli', selected: ['建任务']}]},
    {answers: [{id: 'harness-cli', selected: [], custom: '登录页面'}]},
    {answers: [{id: 'harness-cli', selected: ['先不用']}]},
  ];
  const {ctx, commands} = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return answers.shift();
      },
    },
  });
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');
  const dir = tmpRepo();
  const res = await cli.handler({rawInput: '', agent: {session: {header: {cwd: dir}}}});

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 3, '选指令 → 填任务名 → 问 UI');
  const second = asked[1].questions[0];
  assert.strictEqual(second.header, '任务名');
  assert.ok(!second.options || second.options.length === 0, '任务名是纯文本输入');
  assert.match(second.question, /登录页面/);
  assert.ok(fs.existsSync(path.join(dir, 'prototype', '登录页面', 'progress.html')), '应按输入的任务名建页');
});

test('/harness-cli：rawInput 带命令本名也能识别子指令', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');
  const res = await cli.handler({rawInput: 'harness-cli help', agent: {session: {header: {cwd: tmpRepo()}}}});
  assert.strictEqual(res.kind, 'success', res.text);
  assert.match(res.text, /任务标准流程/);
});

test('/harness-cli-ui：省略任务名时自动选最近的任务', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const ui = commandFor(commands, 'ui');
  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'), 'page', '自动任务', '--root', dir],
    {cwd: dir, encoding: 'utf8'}
  );

  const res = await ui.handler({rawInput: '', agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(res.kind, 'success', res.text);
  assert.ok(fs.existsSync(path.join(dir, 'prototype', '自动任务', 'ui', 'index.html')));
});

test('/harness-cli：菜单选「任务总览」自动带 serve，端口可跳过（随机）', async () => {
  const mod = await import('../cordis.mjs');
  const asked = [];
  const answers = [
    {answers: [{id: 'harness-cli', selected: ['任务总览']}]},
    {answers: [{id: 'harness-cli', selected: []}]}, // 跳过端口
  ];
  const {ctx, commands} = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return answers.shift();
      },
    },
  });
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'), 'page', '自动任务', '--root', dir],
    {cwd: dir, encoding: 'utf8'}
  );

  const res = await cli.handler({rawInput: '', agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 2, '先选指令，再问端口');
  assert.match(asked[1].questions[0].header, /端口/);
  const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(res.text);
  assert.ok(match, `应回显地址：${res.text}`);

  await commandFor(commands, 'plans').handler({rawInput: 'stop', agent: {session: {header: {cwd: dir}}}});
});

test('/harness-cli：菜单选「任务总览」时也可以填固定端口', async () => {
  const mod = await import('../cordis.mjs');
  const port = 8100 + Math.floor(Math.random() * 80);
  const answers = [
    {answers: [{id: 'harness-cli', selected: ['任务总览']}]},
    {answers: [{id: 'harness-cli', selected: [], custom: String(port)}]},
  ];
  const {ctx, commands} = fakeCtx({
    userQuestions: {async ask() { return answers.shift(); }},
  });
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'), 'page', '自动任务', '--root', dir],
    {cwd: dir, encoding: 'utf8'}
  );

  const res = await cli.handler({rawInput: '', agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(res.kind, 'success', res.text);
  assert.match(res.text, new RegExp(`127\\.0\\.0\\.1:${port}/`));

  await commandFor(commands, 'plans').handler({rawInput: 'stop', agent: {session: {header: {cwd: dir}}}});
});

test('/harness-cli：建任务后询问是否出 UI，选「是」就同步执行 ui', async () => {
  const mod = await import('../cordis.mjs');
  const asked = [];
  const answers = [
    {answers: [{id: 'harness-cli', selected: ['建任务']}]},
    {answers: [{id: 'harness-cli', selected: [], custom: '登录页面'}]},
    {answers: [{id: 'harness-cli', selected: ['生成 UI 设计稿']}]},
  ];
  const {ctx, commands} = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return answers.shift() || {answers: [{id: 'harness-cli', selected: []}]};
      },
    },
  });
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'), 'init', '--preset', 'prototype', '--root', dir],
    {cwd: dir, encoding: 'utf8'}
  );

  const res = await cli.handler({rawInput: '', agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 3, '选指令 → 填任务名 → 问 UI');
  assert.match(asked[2].questions[0].header, /UI/);
  assert.match(asked[2].questions[0].question, /登录页面/);
  assert.ok(fs.existsSync(path.join(dir, 'prototype', '登录页面', 'progress.html')), '应先建任务页');
  assert.ok(fs.existsSync(path.join(dir, 'prototype', '登录页面', 'ui', 'index.html')), '选「是」应同步生成 UI');
  assert.match(res.text, /已执行 \/harness-cli ui 登录页面/);
});

test('/harness-cli plan：任务名后面的说明自动进 --user-words', async () => {
  const mod = await import('../cordis.mjs');
  process.env.HARNESS_CLI_NO_AUTO_PLANS = '1';
  try {
    const {ctx, commands} = fakeCtx();
    mod.apply(ctx);
    const plan = commandFor(commands, 'plan');

    const dir = tmpRepo();
    const bin = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
    execFileSync(process.execPath, [bin, 'init', '--preset', 'prototype', '--root', dir], {cwd: dir, encoding: 'utf8'});
    execFileSync(process.execPath, [bin, 'page', '登录页面', '--root', dir], {cwd: dir, encoding: 'utf8'});

    const res = await plan.handler({
      rawInput: '登录页面 添加限制用户最小输入6位，最大输入8位',
      agent: {session: {header: {cwd: dir}}},
    });
    assert.strictEqual(res.kind, 'success', res.text);
    const proposal = fs.readFileSync(path.join(dir, 'docs/specs/登录页面/proposal.md'), 'utf8');
    assert.match(proposal, /最小输入6位，最大输入8位/, '需求原话应进文档');
  } finally {
    delete process.env.HARNESS_CLI_NO_AUTO_PLANS;
  }
});

test('/harness-cli plan：整句被当成任务名时，弹窗另要一个短名字', async () => {
  const mod = await import('../cordis.mjs');
  process.env.HARNESS_CLI_NO_AUTO_PLANS = '1';
  try {
    const asked = [];
    const {ctx, commands} = fakeCtx({
      userQuestions: {
        async ask(request) {
          asked.push(request);
          // 先答「任务名」，再答「要不要 UI」=先不用
          if (asked.length === 1) return {answers: [{id: 'harness-cli', selected: [], custom: '登录页面'}]};
          return {answers: [{id: 'harness-cli', selected: ['先不用']}]};
        },
      },
    });
    mod.apply(ctx);
    const plan = commandFor(commands, 'plan');

    const dir = tmpRepo();
    const bin = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
    execFileSync(process.execPath, [bin, 'init', '--preset', 'prototype', '--root', dir], {cwd: dir, encoding: 'utf8'});
    execFileSync(process.execPath, [bin, 'page', '登录页面', '--root', dir], {cwd: dir, encoding: 'utf8'});

    const res = await plan.handler({
      rawInput: '登录页面添加限制用户最小输入6位，最大输入8位',
      agent: {session: {header: {cwd: dir}}},
    });
    assert.strictEqual(res.kind, 'success', res.text);
    assert.strictEqual(asked.length, 2, '先弹任务名，再问要不要 UI');
    assert.strictEqual(asked[0].questions[0].header, '任务名');
    assert.match(asked[1].questions[0].header, /UI/);
    const proposal = fs.readFileSync(path.join(dir, 'docs/specs/登录页面/proposal.md'), 'utf8');
    assert.match(proposal, /最小输入6位，最大输入8位/);
  } finally {
    delete process.env.HARNESS_CLI_NO_AUTO_PLANS;
  }
});

test('/harness-cli plans serve：省略端口时随机分配，并把真实地址回给对话', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const plans = commandFor(commands, 'plans');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'), 'page', '自动任务', '--root', dir],
    {cwd: dir, encoding: 'utf8'}
  );

  const serve = await plans.handler({rawInput: 'serve', agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(serve.kind, 'success', serve.text);
  const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(serve.text);
  assert.ok(match, `应回显真实端口：${serve.text}`);
  const port = Number(match[1]);
  assert.ok(port > 0 && port !== 7788, '默认应是随机端口，不是 7788');

  const state = JSON.parse(fs.readFileSync(path.join(dir, '.harness/plans-server.json'), 'utf8'));
  assert.strictEqual(state.port, port, '状态文件端口应与回显一致');

  const stop = await plans.handler({rawInput: 'stop', agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(stop.kind, 'success', stop.text);
});

test('/harness-cli plan：成功后自动发起开工回合，并提示操作台', async () => {
  const mod = await import('../cordis.mjs');
  process.env.HARNESS_CLI_NO_AUTO_PLANS = '1';
  try {
    const {ctx, commands} = fakeCtx();
    mod.apply(ctx);
    const plan = commandFor(commands, 'plan');

    const dir = tmpRepo();
    execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'), 'init', '--preset', 'prototype', '--root', dir],
      {cwd: dir, encoding: 'utf8'}
    );
    execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'), 'page', '登录页面', '--root', dir],
      {cwd: dir, encoding: 'utf8'}
    );

    const sent = [];
    const agent = {session: {header: {cwd: dir}}, followup: (message) => sent.push(message)};
    const res = await plan.handler({rawInput: '登录页面', agent});

    assert.strictEqual(res.kind, 'success', res.text);
    assert.match(res.text, /自动开工/);
    assert.strictEqual(sent.length, 1, '应自动发起执行回合');
    assert.match(sent[0].content[0].text, /开始执行任务「登录页面」/);
    assert.match(sent[0].content[0].text, /harness_cli_progress/);
  } finally {
    delete process.env.HARNESS_CLI_NO_AUTO_PLANS;
  }
});

test('/harness-cli plans：生成页面；serve <端口> 起服务、被占用时强制接管、stop 停止', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const plans = commandFor(commands, 'plans');
  assert.ok(plans, '应注册 /harness-cli-plans');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'), 'page', '自动任务', '--root', dir],
    {cwd: dir, encoding: 'utf8'}
  );

  const open = await plans.handler({rawInput: '', agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(open.kind, 'success', open.text);
  assert.ok(fs.existsSync(path.join(dir, 'plans.html')));

  const port = 7800 + Math.floor(Math.random() * 100);
  const serve = await plans.handler({rawInput: `serve ${port}`, agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(serve.kind, 'success', serve.text);
  assert.match(serve.text, new RegExp(String(port)));

  // 同一个端口再起一次：不报「已在运行」，而是强制结束旧的并接管
  const again = await plans.handler({rawInput: `serve ${port}`, agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(again.kind, 'success', again.text);
  assert.match(again.text, /已启动/);
  assert.doesNotMatch(again.text, /已在运行/);

  const stop = await plans.handler({rawInput: 'stop', agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(stop.kind, 'success', stop.text);
});

test('/harness-cli-wiki：生成后自动发起「反推补全」对话', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const wiki = commandFor(commands, 'wiki');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'), 'init', '--preset', 'prototype', '--root', dir],
    {cwd: dir, encoding: 'utf8'}
  );

  const sent = [];
  const agent = {session: {header: {cwd: dir}}, followup: (message) => sent.push(message)};
  const result = await wiki.handler({rawInput: '', agent, signal: undefined});
  assert.strictEqual(result.kind, 'success', result.text);
  assert.strictEqual(sent.length, 1, '应当自动发起一条补全消息');
  assert.strictEqual(sent[0].role, 'user');
  assert.match(sent[0].content[0].text, /反推 docs\/wiki/);
  assert.match(sent[0].content[0].text, /harness-wiki-gaps\.json/);

  const check = await wiki.handler({rawInput: '--check', agent: {session: {header: {cwd: dir}}, followup: () => { throw new Error('不该发起'); }}});
  assert.strictEqual(check.kind, 'success');
});

test('/harness-cli-ui：有缺口时自动发起 UI 补全对话，补完不再发起', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const ui = commandFor(commands, 'ui');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'), 'init', '--preset', 'prototype', '--root', dir],
    {cwd: dir, encoding: 'utf8'}
  );

  const sent = [];
  const agent = {session: {header: {cwd: dir}}, followup: (message) => sent.push(message)};
  const first = await ui.handler({rawInput: 'auto-ui-task', agent});
  assert.strictEqual(first.kind, 'success', first.text);
  assert.strictEqual(sent.length, 1, '有缺口时应自动发起一条消息');
  assert.match(sent[0].content[0].text, /补全 UI 设计/);
  assert.match(sent[0].content[0].text, /ui-gaps\.json/);

  const readme = path.join(dir, 'prototype', 'auto-ui-task', 'ui', 'README.md');
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace(/待补/g, '已补全'));

  const second = await ui.handler({rawInput: 'auto-ui-task', agent});
  assert.strictEqual(second.kind, 'success', second.text);
  assert.strictEqual(sent.length, 1, '缺口清零后不应再发起');
  assert.match(second.text, /UI 设计仍需补全：0 处/);
});
