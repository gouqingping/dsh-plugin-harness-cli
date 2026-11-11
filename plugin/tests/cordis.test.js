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
const { execFileSync } = require('child_process');

/** 造一个临时仓库目录。 */
function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hcli-cordis-'));
}

/** 造一个假的 exec：只提供 cwd 与 signal。 */
function fakeExec(cwd) {
  return { agent: { session: { header: { cwd } } }, signal: undefined };
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
      events.push({ name, handler });
      return () => {};
    },
  };
  return { ctx, tools, commands, events };
}

test('模块导出 cordis 插件契约', async () => {
  const mod = await import('../cordis.mjs');
  assert.strictEqual(mod.name, 'harness-cli');
  assert.deepStrictEqual(mod.inject, ['tools']);
  assert.strictEqual(typeof mod.apply, 'function');
  assert.strictEqual(mod.TOOL_SPECS.length, 13);
});

/** 取聚合指令并按子指令前缀调用（等价于 /harness-cli <sub> ...）。 */
function commandFor(commands, sub) {
  const aggregated = commands.find((command) => command.name === 'harness-cli');
  assert.ok(aggregated, '应注册聚合指令 /harness-cli');
  return {
    handler: (invocation) => {
      const rest = String(
        invocation && invocation.rawInput ? invocation.rawInput : '',
      ).trim();
      return aggregated.handler({
        ...invocation,
        rawInput: rest ? `${sub} ${rest}` : sub,
      });
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
      return {
        answers: [{ id: 'harness-cli', selected: [answer], custom: undefined }],
      };
    },
  };
}

test('harness_cli_delete：弹窗选「删除」才真的删', async () => {
  const mod = await import('../cordis.mjs');
  const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [BIN, 'init', '--preset', 'prototype', '--root', dir],
    { cwd: dir },
  );
  execFileSync(process.execPath, [BIN, 'page', 'task-demo', '--root', dir], {
    cwd: dir,
  });

  const questions = fakeQuestions('删除');
  const { ctx, tools } = fakeCtx({ userQuestions: questions });
  mod.apply(ctx);
  const tool = tools.find((item) => item.name === 'harness_cli_delete');
  assert.ok(tool, '应注册 harness_cli_delete');

  const result = await tool.execute({ task: 'task-demo' }, fakeExec(dir));
  assert.strictEqual(result.exitCode, 0, result.report);
  assert.strictEqual(questions.asked.length, 1, '删除前必须弹窗');
  assert.ok(!fs.existsSync(path.join(dir, 'prototype/task-demo')));
});

test('harness_cli_delete：弹窗选「取消」时不动任何文件', async () => {
  const mod = await import('../cordis.mjs');
  const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [BIN, 'init', '--preset', 'prototype', '--root', dir],
    { cwd: dir },
  );
  execFileSync(process.execPath, [BIN, 'page', 'task-demo', '--root', dir], {
    cwd: dir,
  });

  const { ctx, tools } = fakeCtx({ userQuestions: fakeQuestions('取消') });
  mod.apply(ctx);
  const tool = tools.find((item) => item.name === 'harness_cli_delete');
  const result = await tool.execute({ task: 'task-demo' }, fakeExec(dir));
  assert.strictEqual(result.ok, false);
  assert.match(result.report, /已取消删除/);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/task-demo')));
});

test('harness_cli_wiki：冲突时弹窗，选「接管」后补区块并保留正文', async () => {
  const mod = await import('../cordis.mjs');
  const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'init', '--root', dir], { cwd: dir });
  execFileSync(process.execPath, [BIN, 'wiki', '--root', dir], { cwd: dir });

  const file = path.join(dir, 'docs/wiki/术语表.md');
  const stripped = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/harness-wiki:(begin|end)/.test(line))
    .join('\n');
  fs.writeFileSync(file, stripped);

  const { ctx, tools } = fakeCtx({
    userQuestions: fakeQuestions('接管既有文档'),
  });
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
  execFileSync(
    process.execPath,
    [BIN, 'init', '--preset', 'prototype', '--root', dir],
    { cwd: dir },
  );
  execFileSync(process.execPath, [BIN, 'page', 'task-demo', '--root', dir], {
    cwd: dir,
  });
  const model = {
    goal: '用手机号+密码完成登录闭环',
    scope: '登录表单、校验、错误提示与会话发放',
    nonGoals: ['第三方登录', '找回密码'],
    context: '身份与访问控制',
    terms: [
      { term: '账号', definition: '可被认证的主体' },
      { term: '会话', definition: '认证后的凭证集合' },
      { term: '锁定', definition: '连续失败后禁止认证' },
    ],
    aggregates: ['聚合根 Account：守住凭据与锁定状态'],
    invariants: ['锁定账号不接受任何密码校验'],
    contracts: [
      {
        id: 'S-01',
        title: '用手机号+密码换取会话',
        input: '手机号、密码',
        output: '返回 token',
        error: '密码错 401；锁定 423',
        accept: 'node --test 覆盖 401/423',
      },
      {
        id: 'S-02',
        title: '连续失败 5 次锁定账号',
        input: '同一账号 5 次错误密码',
        output: '账号进入锁定',
        error: '第 6 次仍返回 423',
        accept: '测试覆盖第 5、6 次',
      },
    ],
    steps: [
      { title: '写契约与失败用例', spec: 'S-01' },
      { title: '实现账号与会话', spec: 'S-02' },
      { title: '回归与文档', spec: 'S-02' },
    ],
    acceptance: ['S-01、S-02 的验收标准全部可执行', '门禁全绿'],
  };
  execFileSync(
    process.execPath,
    [
      BIN,
      'plan',
      'task-demo',
      '--input-json',
      JSON.stringify(model),
      '--force',
      '--root',
      dir,
    ],
    { cwd: dir },
  );
  execFileSync(process.execPath, [BIN, 'review', 'task-demo', '--root', dir], {
    cwd: dir,
  });

  const questions = fakeQuestions('确认');
  const { ctx, tools } = fakeCtx({ userQuestions: questions });
  mod.apply(ctx);
  const tool = tools.find((item) => item.name === 'harness_cli_plan');
  const result = await tool.execute(
    { task: 'task-demo', confirm: true },
    fakeExec(dir),
  );

  assert.strictEqual(result.exitCode, 0, result.report);
  assert.strictEqual(questions.asked.length, 1);
  const planText = fs.readFileSync(
    path.join(dir, 'prototype/task-demo/plan.html'),
    'utf8',
  );
  assert.match(planText, /data-plan-status="已确认"/);
  assert.match(planText, /用户（弹窗确认）/);
});

test('apply 注册全部工具与斜杠命令', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, tools, commands } = fakeCtx();
  mod.apply(ctx);

  assert.deepStrictEqual(tools.map((tool) => tool.name).sort(), [
    'harness_cli_agents',
    'harness_cli_check',
    'harness_cli_delete',
    'harness_cli_doctor',
    'harness_cli_init',
    'harness_cli_page',
    'harness_cli_plan',
    'harness_cli_progress',
    'harness_cli_review',
    'harness_cli_sql',
    'harness_cli_style',
    'harness_cli_ui',
    'harness_cli_wiki',
  ]);
  assert.deepStrictEqual(
    commands.map((command) => command.name).sort(),
    ['harness-cli'],
    '指令菜单只保留一条聚合入口，子指令走弹窗或 /harness-cli <子指令>',
  );
});

test('apply 订阅 session/event，todo/write 没有仓库配置时安全跳过', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, events } = fakeCtx();
  mod.apply(ctx);

  const registration = events.find((item) => item.name === 'session/event');
  assert.ok(registration, '应订阅 session/event');
  const result = await registration.handler(
    { id: 'session-1', header: { cwd: tmpRepo() } },
    {
      type: 'todo/write',
      data: { todos: [{ content: '一步', status: 'completed' }] },
    },
  );
  assert.deepStrictEqual(result, { ok: true, skipped: 'no-harness-config' });
});

test('每个工具都是 object 根 schema + 可渲染的输出', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, tools } = fakeCtx();
  mod.apply(ctx);

  for (const tool of tools) {
    assert.strictEqual(
      tool.parameters.type,
      'object',
      `${tool.name} 的 parameters 必须是 object 根`,
    );
    assert.strictEqual(tool.parameters.additionalProperties, false);
    assert.ok(
      Array.isArray(tool.parameters.required),
      `${tool.name} 必须显式声明 required`,
    );
    assert.ok(
      tool.output && typeof tool.output.render === 'function',
      `${tool.name} 缺少 output.render`,
    );
    const rendered = tool.output.render(
      {},
      {
        root: '/tmp/x',
        command: 'check',
        args: ['check'],
        exitCode: 1,
        ok: false,
        report: '报告正文\n',
      },
    );
    assert.deepStrictEqual(rendered, [{ type: 'text', text: '报告正文\n' }]);
  }
});

test('空仓库 check 失败（退出码 1），init 之后 check 通过', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, tools } = fakeCtx();
  mod.apply(ctx);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const dir = tmpRepo();
  const init = byName.get('harness_cli_init');
  const check = byName.get('harness_cli_check');

  const before = await check.execute({}, fakeExec(dir));
  assert.strictEqual(before.exitCode, 1, '空仓库应当判失败');
  assert.strictEqual(before.ok, false);
  assert.match(before.report, /退出码 1/);

  const scaffold = await init.execute(
    { preset: 'prototype', dry_run: true },
    fakeExec(dir),
  );
  assert.strictEqual(scaffold.exitCode, 0, scaffold.report);
  assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')), 'dry_run 不能落盘');

  const real = await init.execute({ preset: 'prototype' }, fakeExec(dir));
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
  const { ctx, tools } = fakeCtx();
  mod.apply(ctx);
  const doctor = tools.find((tool) => tool.name === 'harness_cli_doctor');
  const pluginDir = path.resolve(__dirname, '..');
  const value = await doctor.execute({}, fakeExec(pluginDir));
  assert.strictEqual(value.exitCode, 0, value.report);
  assert.match(value.report, /模板/);
});

test('目标目录不存在时给出人话错误，而不是 ENOENT', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, tools } = fakeCtx();
  mod.apply(ctx);
  const check = tools.find((tool) => tool.name === 'harness_cli_check');
  await assert.rejects(
    () =>
      check.execute(
        { root: path.join(os.tmpdir(), 'hcli-does-not-exist-xyz') },
        fakeExec(os.tmpdir()),
      ),
    /目标目录不存在/,
  );
});

test('style 缺参数时不启动子进程', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, tools } = fakeCtx();
  mod.apply(ctx);
  const style = tools.find((tool) => tool.name === 'harness_cli_style');
  await assert.rejects(
    () => style.execute({ args: [] }, fakeExec(process.cwd())),
    /args/,
  );
});

test('resolveRoot：显式路径按 cwd 解析，无 cwd 且无 root 时拒绝', async () => {
  const mod = await import('../cordis.mjs');
  assert.deepStrictEqual(mod.resolveRoot('sub/dir', '/work'), {
    root: path.resolve('/work', 'sub/dir'),
  });
  assert.deepStrictEqual(mod.resolveRoot(undefined, '/work'), {
    root: '/work',
  });
  assert.deepStrictEqual(mod.resolveRoot('/abs/path', undefined), {
    root: '/abs/path',
  });
  assert.match(mod.resolveRoot(undefined, undefined).error, /root/);
  assert.match(mod.resolveRoot(undefined, '/').error, /root/);
  assert.match(mod.resolveRoot(42, '/work').error, /root/);
});

test('parseCommandInput：位置参数与 flag', async () => {
  const mod = await import('../cordis.mjs');
  assert.deepStrictEqual(mod.parseCommandInput(''), {});
  assert.deepStrictEqual(mod.parseCommandInput('/repo --strict'), {
    root: '/repo',
    strict: true,
  });
  assert.deepStrictEqual(mod.parseCommandInput('--preset prototype --force'), {
    preset: 'prototype',
    force: true,
  });
  assert.match(mod.parseCommandInput('--root').error, /--root/);
  assert.match(mod.parseCommandInput('--bogus').error, /无法识别/);
});

test('parseTaskInput：任务名在前，root 用 --root 或第二个位置参数', async () => {
  const mod = await import('../cordis.mjs');
  assert.deepStrictEqual(mod.parseTaskInput('登录页面'), { task: '登录页面' });
  assert.deepStrictEqual(mod.parseTaskInput('登录页面 --force'), {
    task: '登录页面',
    force: true,
  });
  assert.deepStrictEqual(mod.parseTaskInput('login-flow --root /tmp/x'), {
    task: 'login-flow',
    root: '/tmp/x',
  });
  assert.deepStrictEqual(mod.parseTaskInput('login-flow /tmp/x'), {
    task: 'login-flow',
    root: '/tmp/x',
  });
  assert.deepStrictEqual(
    mod.parseTaskInput('登录页面 --user-words "先把登录做了"'),
    {
      task: '登录页面',
      userWords: '先把登录做了',
    },
  );
  assert.match(mod.parseTaskInput('--root').error, /--root/);
  assert.match(mod.parseTaskInput('t --bogus').error, /无法识别/);
});

test('/harness-cli ui：中文任务名也能生成（目录自动创建）', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const ui = commands.find((command) => command.name === 'harness-cli');
  assert.ok(ui, '应注册聚合指令 /harness-cli');

  const dir = tmpRepo();
  const result = await ui.handler({
    rawInput: 'ui 登录页面',
    agent: { session: { header: { cwd: dir } } },
  });
  assert.strictEqual(result.kind, 'success', result.text);
  assert.ok(
    fs.existsSync(path.join(dir, 'prototype', '登录页面', 'ui', 'index.html')),
  );
  assert.ok(
    fs.existsSync(path.join(dir, 'prototype', '登录页面', 'ui', 'README.md')),
  );
});

test('/harness-cli ui：显式 --root 指向不存在的目录时主动创建', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const ui = commands.find((command) => command.name === 'harness-cli');

  const base = tmpRepo();
  const target = path.join(base, 'new-project');
  const result = await ui.handler({
    rawInput: `ui 登录页面 --root "${target}"`,
    agent: { session: { header: { cwd: base } } },
  });
  assert.strictEqual(result.kind, 'success', result.text);
  assert.ok(
    fs.existsSync(
      path.join(target, 'prototype', '登录页面', 'ui', 'index.html'),
    ),
  );
});

test('/harness-cli help：列出全部命令与工具，并支持按名字查看', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);

  // 帮助手册与真实注册项必须同名（防止加了命令忘了写说明）
  assert.deepStrictEqual(
    commands.map((command) => command.name).sort(),
    mod.COMMAND_MANUAL.map((item) => item.name).sort(),
  );

  const help = commands.find((command) => command.name === 'harness-cli');
  const full = await help.handler({ rawInput: 'help' });
  assert.strictEqual(full.kind, 'success');
  for (const item of mod.COMMAND_MANUAL)
    assert.ok(full.text.includes('/' + item.name), `缺少 ${item.name}`);
  for (const spec of mod.TOOL_SPECS)
    assert.ok(full.text.includes(spec.toolName), `缺少 ${spec.toolName}`);
  assert.match(full.text, /任务标准流程/);
  assert.match(full.text, /自动 loop/);
  assert.match(full.text, /退出码/);

  const one = await help.handler({ rawInput: 'help ui' });
  assert.match(one.text, /harness_cli_ui/);
  assert.doesNotMatch(one.text, /harness_cli_wiki/);

  const tool = await help.handler({ rawInput: 'help harness_cli_progress' });
  assert.match(tool.text, /harness_cli_progress/);

  const missing = await help.handler({ rawInput: 'help nope' });
  assert.match(missing.text, /没有找到/);
});

test('/harness-cli：不带子指令时弹窗选中文项并执行', async () => {
  const mod = await import('../cordis.mjs');
  const asked = [];
  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return { answers: [{ id: 'harness-cli', selected: ['帮助'] }] };
      },
    },
  });
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');
  const res = await cli.handler({
    rawInput: '',
    agent: { session: { header: { cwd: tmpRepo() } } },
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 1, '应弹一次选择框');
  const question = asked[0].questions[0];
  assert.strictEqual(question.header, 'Harness-CLI 指令');
  assert.strictEqual(question.question, '选择要执行的 Harness-CLI 指令：');
  assert.deepStrictEqual(
    question.options.map((option) => option.label),
    [
      '初始化',
      '校验',
      '自检',
      '建任务',
      '方案',
      '复盘',
      '推进度',
      '继续任务',
      '重跑任务',
      'UI 设计',
      '数据库设计',
      '删除任务',
      '业务 wiki',
      '任务总览',
      '入口地图',
      '帮助',
    ],
  );
  // 选「帮助」→ 走 help 子指令
  assert.match(res.text, /harness_cli_progress/);
});

test('/harness-cli：没有选择框时给出原因与子指令写法，不泄漏内部提示', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');
  const res = await cli.handler({
    rawInput: '',
    agent: { session: { header: { cwd: tmpRepo() } } },
  });
  assert.strictEqual(res.kind, 'error');
  assert.match(res.text, /选择框没有弹出来/);
  assert.match(res.text, /\/harness-cli check/);
});

test('/harness-cli：选到需要参数的子指令时，再弹一次输入框拿任务名', async () => {
  const mod = await import('../cordis.mjs');
  const asked = [];
  const answers = [
    { answers: [{ id: 'harness-cli', selected: ['建任务'] }] },
    { answers: [{ id: 'harness-cli', selected: [], custom: '登录页面' }] },
    { answers: [{ id: 'harness-cli', selected: ['手动'] }] }, // 操作模式
    { answers: [{ id: 'harness-cli', selected: ['先不用'] }] }, // 数模设计
    { answers: [{ id: 'harness-cli', selected: ['先不用'] }] }, // UI 设计
  ];
  const { ctx, commands } = fakeCtx({
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
  const res = await cli.handler({
    rawInput: '',
    agent: { session: { header: { cwd: dir } } },
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(
    asked.length,
    5,
    '选指令 → 填任务名 → 问模式 → 问数模 → 问 UI',
  );
  const second = asked[1].questions[0];
  assert.strictEqual(second.header, '任务名');
  assert.ok(
    !second.options || second.options.length === 0,
    '任务名是纯文本输入',
  );
  assert.match(second.question, /登录页面/);
  assert.strictEqual(asked[2].questions[0].header, '操作模式');
  assert.strictEqual(asked[3].questions[0].header, '数模设计');
  assert.strictEqual(asked[4].questions[0].header, 'UI 设计');
  assert.ok(
    fs.existsSync(path.join(dir, 'prototype', '登录页面', 'progress.html')),
    '应按输入的任务名建页',
  );
});

test('/harness-cli：rawInput 带命令本名也能识别子指令', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');
  const res = await cli.handler({
    rawInput: 'harness-cli help',
    agent: { session: { header: { cwd: tmpRepo() } } },
  });
  assert.strictEqual(res.kind, 'success', res.text);
  assert.match(res.text, /任务标准流程/);
});

test('/harness-cli-ui：省略任务名时自动选最近的任务', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const ui = commandFor(commands, 'ui');
  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'),
      'page',
      '自动任务',
      '--root',
      dir,
    ],
    { cwd: dir, encoding: 'utf8' },
  );

  const res = await ui.handler({
    rawInput: '',
    agent: { session: { header: { cwd: dir } } },
  });
  assert.strictEqual(res.kind, 'success', res.text);
  assert.ok(
    fs.existsSync(path.join(dir, 'prototype', '自动任务', 'ui', 'index.html')),
  );
});

test('/harness-cli：菜单选「任务总览」自动带 serve，端口可跳过（随机）', async () => {
  const mod = await import('../cordis.mjs');
  const asked = [];
  const answers = [
    { answers: [{ id: 'harness-cli', selected: ['任务总览'] }] },
    { answers: [{ id: 'harness-cli', selected: [] }] }, // 跳过端口
  ];
  const { ctx, commands } = fakeCtx({
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
    [
      path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'),
      'page',
      '自动任务',
      '--root',
      dir,
    ],
    { cwd: dir, encoding: 'utf8' },
  );

  const res = await cli.handler({
    rawInput: '',
    agent: { session: { header: { cwd: dir } } },
  });
  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 2, '先选指令，再问端口');
  assert.match(asked[1].questions[0].header, /端口/);
  const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(res.text);
  assert.ok(match, `应回显地址：${res.text}`);

  await commandFor(commands, 'plans').handler({
    rawInput: 'stop',
    agent: { session: { header: { cwd: dir } } },
  });
});

test('/harness-cli：菜单选「任务总览」时也可以填固定端口', async () => {
  const mod = await import('../cordis.mjs');
  const port = 8100 + Math.floor(Math.random() * 80);
  const answers = [
    { answers: [{ id: 'harness-cli', selected: ['任务总览'] }] },
    { answers: [{ id: 'harness-cli', selected: [], custom: String(port) }] },
  ];
  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask() {
        return answers.shift();
      },
    },
  });
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'),
      'page',
      '自动任务',
      '--root',
      dir,
    ],
    { cwd: dir, encoding: 'utf8' },
  );

  const res = await cli.handler({
    rawInput: '',
    agent: { session: { header: { cwd: dir } } },
  });
  assert.strictEqual(res.kind, 'success', res.text);
  assert.match(res.text, new RegExp(`127\\.0\\.0\\.1:${port}/`));

  await commandFor(commands, 'plans').handler({
    rawInput: 'stop',
    agent: { session: { header: { cwd: dir } } },
  });
});

test('/harness-cli：先选是否生成 UI，再一起执行 page 与 ui', async () => {
  const mod = await import('../cordis.mjs');
  const asked = [];
  const feedback = [];
  let pageExistedAtUiChoice;
  let pageExistedAtUiFeedback;
  const answers = [
    { answers: [{ id: 'harness-cli', selected: ['建任务'] }] },
    { answers: [{ id: 'harness-cli', selected: [], custom: '登录页面' }] },
    { answers: [{ id: 'harness-cli', selected: ['手动'] }] }, // 操作模式
    { answers: [{ id: 'harness-cli', selected: ['先不用'] }] }, // 数模设计
    { answers: [{ id: 'harness-cli', selected: ['生成 UI 设计稿'] }] }, // UI 设计
  ];
  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        if (asked.length === 5) {
          pageExistedAtUiChoice = fs.existsSync(
            path.join(dir, 'prototype', '登录页面', 'progress.html'),
          );
        }
        return (
          answers.shift() || { answers: [{ id: 'harness-cli', selected: [] }] }
        );
      },
    },
  });
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'),
      'init',
      '--preset',
      'prototype',
      '--root',
      dir,
    ],
    { cwd: dir, encoding: 'utf8' },
  );

  const agent = {
    session: {
      header: { cwd: dir },
      append(type, message, options) {
        feedback.push({ type, message, options });
        const text = message.content.map((block) => block.text || '').join('');
        if (text.includes('生成 UI 设计稿')) {
          pageExistedAtUiFeedback = fs.existsSync(
            path.join(dir, 'prototype', '登录页面', 'progress.html'),
          );
        }
      },
    },
  };
  const res = await cli.handler({ rawInput: '', agent });
  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(
    asked.length,
    5,
    '选指令 → 填任务名 → 问模式 → 问数模 → 问 UI',
  );
  assert.match(asked[2].questions[0].header, /模式/);
  assert.match(asked[3].questions[0].header, /数模/);
  assert.match(asked[4].questions[0].header, /UI/);
  assert.match(asked[4].questions[0].question, /登录页面/);
  assert.strictEqual(
    pageExistedAtUiChoice,
    false,
    'UI 选择完成前不能先执行 page',
  );
  assert.strictEqual(
    pageExistedAtUiFeedback,
    false,
    '选择反馈必须立即写入，且不等待 page 执行',
  );
  assert.deepStrictEqual(
    feedback.map((item) => item.message.content[0].text),
    [
      '已选择：建任务',
      '已输入：登录页面',
      '已选择：手动',
      '已选择：先不用',
      '已选择：生成 UI 设计稿',
    ],
    '每个选择都要立即反馈到对话框',
  );
  for (const item of feedback) {
    assert.strictEqual(item.type, 'user/message');
    assert.deepStrictEqual(item.message.source, { kind: 'user' });
    assert.deepStrictEqual(item.options, { surfaceOp: 'append' });
  }
  assert.ok(
    fs.existsSync(path.join(dir, 'prototype', '登录页面', 'progress.html')),
    '应先建任务页',
  );
  assert.ok(
    fs.existsSync(path.join(dir, 'prototype', '登录页面', 'ui', 'index.html')),
    '选「是」应同步生成 UI',
  );
  assert.match(res.text, /已执行 \/harness-cli ui 登录页面/);
});

test('/harness-cli plan：先完成 UI 选择和生成，再自动开工', async () => {
  const mod = await import('../cordis.mjs');
  process.env.HARNESS_CLI_NO_AUTO_PLANS = '1';
  try {
    let planExistedAtUiChoice;
    let uiExistedAtKickoff;
    let askCount = 0;
    const { ctx, commands } = fakeCtx({
      userQuestions: {
        async ask() {
          askCount += 1;
          planExistedAtUiChoice = fs.existsSync(
            path.join(dir, 'prototype', '登录页面', 'plan.html'),
          );
          const selected =
            askCount === 1
              ? '手动'
              : askCount === 2
                ? '先不用'
                : '生成 UI 设计稿';
          return { answers: [{ id: 'harness-cli', selected: [selected] }] };
        },
      },
    });
    mod.apply(ctx);
    const plan = commandFor(commands, 'plan');

    const dir = tmpRepo();
    const bin = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
    execFileSync(
      process.execPath,
      [bin, 'init', '--preset', 'prototype', '--root', dir],
      {
        cwd: dir,
        encoding: 'utf8',
      },
    );
    execFileSync(process.execPath, [bin, 'page', '登录页面', '--root', dir], {
      cwd: dir,
      encoding: 'utf8',
    });
    fs.unlinkSync(path.join(dir, 'prototype', '登录页面', 'plan.html'));

    const res = await plan.handler({
      rawInput: '登录页面',
      agent: {
        session: { header: { cwd: dir } },
        followup() {
          if (uiExistedAtKickoff === undefined) {
            uiExistedAtKickoff = fs.existsSync(
              path.join(dir, 'prototype', '登录页面', 'ui', 'index.html'),
            );
          }
        },
      },
    });

    assert.strictEqual(res.kind, 'success', res.text);
    assert.strictEqual(
      planExistedAtUiChoice,
      false,
      'UI 选择完成前不能先执行 plan',
    );
    assert.strictEqual(uiExistedAtKickoff, true, 'UI 生成完成前不能自动开工');
    assert.ok(
      fs.existsSync(path.join(dir, 'prototype', '登录页面', 'plan.html')),
      '选择完成后应执行 plan',
    );
    assert.ok(
      fs.existsSync(
        path.join(dir, 'prototype', '登录页面', 'ui', 'index.html'),
      ),
      '选择 UI 时应生成设计稿',
    );
  } finally {
    delete process.env.HARNESS_CLI_NO_AUTO_PLANS;
  }
});

test('/harness-cli plan：任务名后面的说明自动进 --user-words', async () => {
  const mod = await import('../cordis.mjs');
  process.env.HARNESS_CLI_NO_AUTO_PLANS = '1';
  try {
    const { ctx, commands } = fakeCtx();
    mod.apply(ctx);
    const plan = commandFor(commands, 'plan');

    const dir = tmpRepo();
    const bin = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
    execFileSync(
      process.execPath,
      [bin, 'init', '--preset', 'prototype', '--root', dir],
      { cwd: dir, encoding: 'utf8' },
    );
    execFileSync(process.execPath, [bin, 'page', '登录页面', '--root', dir], {
      cwd: dir,
      encoding: 'utf8',
    });

    const res = await plan.handler({
      rawInput: '登录页面 添加限制用户最小输入6位，最大输入8位',
      agent: { session: { header: { cwd: dir } } },
    });
    assert.strictEqual(res.kind, 'success', res.text);
    const proposal = fs.readFileSync(
      path.join(dir, 'docs/specs/登录页面/proposal.md'),
      'utf8',
    );
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
    const { ctx, commands } = fakeCtx({
      userQuestions: {
        async ask(request) {
          asked.push(request);
          // 先答「任务名」，再答「模式 / 数模 / UI」=手动 + 先不用
          if (asked.length === 1)
            return {
              answers: [
                { id: 'harness-cli', selected: [], custom: '登录页面' },
              ],
            };
          if (asked.length === 2)
            return { answers: [{ id: 'harness-cli', selected: ['手动'] }] };
          return { answers: [{ id: 'harness-cli', selected: ['先不用'] }] };
        },
      },
    });
    mod.apply(ctx);
    const plan = commandFor(commands, 'plan');

    const dir = tmpRepo();
    const bin = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
    execFileSync(
      process.execPath,
      [bin, 'init', '--preset', 'prototype', '--root', dir],
      { cwd: dir, encoding: 'utf8' },
    );
    execFileSync(process.execPath, [bin, 'page', '登录页面', '--root', dir], {
      cwd: dir,
      encoding: 'utf8',
    });

    const res = await plan.handler({
      rawInput: '登录页面添加限制用户最小输入6位，最大输入8位',
      agent: { session: { header: { cwd: dir } } },
    });
    assert.strictEqual(res.kind, 'success', res.text);
    assert.strictEqual(
      asked.length,
      4,
      '先弹任务名，再问模式，再问数模，再问 UI',
    );
    assert.strictEqual(asked[0].questions[0].header, '任务名');
    assert.match(asked[1].questions[0].header, /模式/);
    assert.match(asked[2].questions[0].header, /数模/);
    assert.match(asked[3].questions[0].header, /UI/);
    const proposal = fs.readFileSync(
      path.join(dir, 'docs/specs/登录页面/proposal.md'),
      'utf8',
    );
    assert.match(proposal, /最小输入6位，最大输入8位/);
  } finally {
    delete process.env.HARNESS_CLI_NO_AUTO_PLANS;
  }
});

test('/harness-cli plans serve：省略端口时随机分配，并把真实地址回给对话', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const plans = commandFor(commands, 'plans');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'),
      'page',
      '自动任务',
      '--root',
      dir,
    ],
    { cwd: dir, encoding: 'utf8' },
  );

  const serve = await plans.handler({
    rawInput: 'serve',
    agent: { session: { header: { cwd: dir } } },
  });
  assert.strictEqual(serve.kind, 'success', serve.text);
  const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(serve.text);
  assert.ok(match, `应回显真实端口：${serve.text}`);
  const port = Number(match[1]);
  assert.ok(port > 0 && port !== 7788, '默认应是随机端口，不是 7788');

  const state = JSON.parse(
    fs.readFileSync(path.join(dir, '.harness/plans-server.json'), 'utf8'),
  );
  assert.strictEqual(state.port, port, '状态文件端口应与回显一致');

  const stop = await plans.handler({
    rawInput: 'stop',
    agent: { session: { header: { cwd: dir } } },
  });
  assert.strictEqual(stop.kind, 'success', stop.text);
});

test('/harness-cli plan：成功后自动发起开工回合，并提示操作台', async () => {
  const mod = await import('../cordis.mjs');
  process.env.HARNESS_CLI_NO_AUTO_PLANS = '1';
  try {
    const { ctx, commands } = fakeCtx();
    mod.apply(ctx);
    const plan = commandFor(commands, 'plan');

    const dir = tmpRepo();
    execFileSync(
      process.execPath,
      [
        path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'),
        'init',
        '--preset',
        'prototype',
        '--root',
        dir,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    execFileSync(
      process.execPath,
      [
        path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'),
        'page',
        '登录页面',
        '--root',
        dir,
      ],
      { cwd: dir, encoding: 'utf8' },
    );

    const sent = [];
    const queued = [];
    const agent = {
      session: { header: { cwd: dir } },
      steer: (message) => sent.push(message),
      followup: (message) => queued.push(message),
    };
    const res = await plan.handler({ rawInput: '登录页面', agent });

    assert.strictEqual(res.kind, 'success', res.text);
    assert.match(res.text, /自动开工/);
    assert.strictEqual(sent.length, 1, '应直接发送执行消息');
    assert.strictEqual(queued.length, 0, '不能排到下一轮');
    assert.match(sent[0].content[0].text, /开始执行任务「登录页面」/);
    assert.match(sent[0].content[0].text, /harness_cli_progress/);
  } finally {
    delete process.env.HARNESS_CLI_NO_AUTO_PLANS;
  }
});

test('/harness-cli plans：生成页面；serve <端口> 起服务、被占用时强制接管、stop 停止', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const plans = commandFor(commands, 'plans');
  assert.ok(plans, '应注册 /harness-cli-plans');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'),
      'page',
      '自动任务',
      '--root',
      dir,
    ],
    { cwd: dir, encoding: 'utf8' },
  );

  const open = await plans.handler({
    rawInput: '',
    agent: { session: { header: { cwd: dir } } },
  });
  assert.strictEqual(open.kind, 'success', open.text);
  assert.ok(fs.existsSync(path.join(dir, 'plans.html')));

  const port = 7800 + Math.floor(Math.random() * 100);
  const serve = await plans.handler({
    rawInput: `serve ${port}`,
    agent: { session: { header: { cwd: dir } } },
  });
  assert.strictEqual(serve.kind, 'success', serve.text);
  assert.match(serve.text, new RegExp(String(port)));

  // 同一个端口再起一次：不报「已在运行」，而是强制结束旧的并接管
  const again = await plans.handler({
    rawInput: `serve ${port}`,
    agent: { session: { header: { cwd: dir } } },
  });
  assert.strictEqual(again.kind, 'success', again.text);
  assert.match(again.text, /已启动/);
  assert.doesNotMatch(again.text, /已在运行/);

  const stop = await plans.handler({
    rawInput: 'stop',
    agent: { session: { header: { cwd: dir } } },
  });
  assert.strictEqual(stop.kind, 'success', stop.text);
});

test('/harness-cli-wiki：生成后自动发起「反推补全」对话', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const wiki = commandFor(commands, 'wiki');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'),
      'init',
      '--preset',
      'prototype',
      '--root',
      dir,
    ],
    { cwd: dir, encoding: 'utf8' },
  );

  const sent = [];
  const queued = [];
  const agent = {
    session: { header: { cwd: dir } },
    steer: (message) => sent.push(message),
    followup: (message) => queued.push(message),
  };
  const result = await wiki.handler({ rawInput: '', agent, signal: undefined });
  assert.strictEqual(result.kind, 'success', result.text);
  assert.strictEqual(sent.length, 1, '应当直接发送一条补全消息');
  assert.strictEqual(queued.length, 0, '不能排到下一轮');
  assert.strictEqual(sent[0].role, 'user');
  assert.match(sent[0].content[0].text, /反推 docs\/wiki/);
  assert.match(sent[0].content[0].text, /harness-wiki-gaps\.json/);

  const check = await wiki.handler({
    rawInput: '--check',
    agent: {
      session: { header: { cwd: dir } },
      followup: () => {
        throw new Error('不该发起');
      },
    },
  });
  assert.strictEqual(check.kind, 'success');
});

test('/harness-cli-ui：覆盖已有设计稿，有缺口时继续派发补全', async () => {
  const mod = await import('../cordis.mjs');
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const ui = commandFor(commands, 'ui');

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'),
      'init',
      '--preset',
      'prototype',
      '--root',
      dir,
    ],
    { cwd: dir, encoding: 'utf8' },
  );

  const sent = [];
  const queued = [];
  const agent = {
    session: { header: { cwd: dir } },
    steer: (message) => sent.push(message),
    followup: (message) => queued.push(message),
  };
  const first = await ui.handler({ rawInput: 'auto-ui-task', agent });
  assert.strictEqual(first.kind, 'success', first.text);
  assert.strictEqual(sent.length, 1, '有缺口时应直接发送一条消息');
  assert.strictEqual(queued.length, 0, '不能排到下一轮');
  assert.match(sent[0].content[0].text, /补全 UI 设计/);
  assert.match(sent[0].content[0].text, /ui-gaps\.json/);

  const page = path.join(dir, 'prototype', 'auto-ui-task', 'ui', 'index.html');
  fs.writeFileSync(page, '<html data-stale="1">旧设计</html>');

  const second = await ui.handler({ rawInput: 'auto-ui-task', agent });
  assert.strictEqual(second.kind, 'success', second.text);
  assert.strictEqual(sent.length, 2, '覆盖执行后仍有缺口，应继续发起补全');
  const regenerated = fs.readFileSync(page, 'utf8');
  assert.doesNotMatch(regenerated, /data-stale/, '已存在的设计稿应被覆盖');
  assert.match(regenerated, /data-design-system="antd"/);
  assert.match(second.text, /UI 设计仍需补全：/);
});

/** 建一个带状态 / 进度的任务（状态落在任务页与方案页，供 continue / restart 读取）。 */
function seedTask(dir, name, options) {
  const opts = options || {};
  const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');
  execFileSync(process.execPath, [BIN, 'page', name, '--root', dir], {
    cwd: dir,
    encoding: 'utf8',
  });

  const page = path.join(dir, 'prototype', name, 'progress.html');
  let html = fs.readFileSync(page, 'utf8');
  const pct = opts.pct === undefined ? 0 : opts.pct;
  html = html
    .replace(/data-pct="\d+"/g, `data-pct="${pct}"`)
    .replace(
      /(<span[^>]*class="[^"]*\bstep-pct\b[^"]*"[^>]*>)\s*\d+%\s*(<\/span>)/g,
      `$1${pct}%$2`,
    );
  if (opts.status) {
    html = html
      .replace(/data-task-status="[^"]*"/, `data-task-status="${opts.status}"`)
      .replace(
        /(<span[^>]*data-task-status-label[^>]*>)[^<]*(<\/span>)/,
        `$1${opts.status}$2`,
      );
  }
  fs.writeFileSync(page, html);

  if (opts.planStatus) {
    const plan = path.join(dir, 'prototype', name, 'plan.html');
    if (fs.existsSync(plan)) {
      fs.writeFileSync(
        plan,
        fs
          .readFileSync(plan, 'utf8')
          .replace(
            /data-plan-status="[^"]*"/,
            `data-plan-status="${opts.planStatus}"`,
          ),
      );
    }
  }
}

test('/harness-cli continue：只列未完成任务，选中后派发「从当前进度继续」', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '已经完成', { status: '完成', pct: 100 });
  seedTask(dir, '做到一半', { status: '进行中', pct: 50 });

  const asked = [];
  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return { answers: [{ id: 'harness-cli', selected: ['做到一半'] }] };
      },
    },
  });
  mod.apply(ctx);

  const sent = [];
  const agent = {
    session: { header: { cwd: dir } },
    steer: (message) => sent.push(message),
  };
  const res = await commandFor(commands, 'continue').handler({
    rawInput: '',
    agent,
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 1, '应弹一次任务选择框');
  const question = asked[0].questions[0];
  assert.strictEqual(question.header, '继续任务');
  assert.ok(question.multiSelect !== true, 'continue 是单选');
  assert.deepStrictEqual(
    question.options.map((option) => option.label),
    ['做到一半'],
    '已完成任务不应出现在继续列表里',
  );
  assert.match(question.options[0].description, /进行中/);
  assert.match(question.options[0].description, /50%/);

  assert.strictEqual(sent.length, 1, '选中后应把执行请求直接发给当前对话');
  assert.strictEqual(sent[0].role, 'user');
  assert.match(sent[0].content[0].text, /继续任务「做到一半」/);
  assert.match(sent[0].content[0].text, /不要从 Step 1 重做/);
  assert.match(res.text, /已继续任务「做到一半」/);
});

test('/harness-cli continue：没有未完成任务时不弹窗，提示改走 restart', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '已经完成', { status: '完成', pct: 100 });

  const asked = [];
  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return { answers: [{ id: 'harness-cli', selected: [] }] };
      },
    },
  });
  mod.apply(ctx);
  const res = await commandFor(commands, 'continue').handler({
    rawInput: '',
    agent: { session: { header: { cwd: dir } } },
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 0, '没有未完成任务不应弹选择框');
  assert.match(res.text, /所有任务都已完成/);
  assert.match(res.text, /\/harness-cli restart/);
});

test('/harness-cli continue：没有选择框时给出任务名写法与未完成清单', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '做到一半', { status: '进行中', pct: 30 });
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const res = await commandFor(commands, 'continue').handler({
    rawInput: '',
    agent: { session: { header: { cwd: dir } } },
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.match(res.text, /没有可用的选择框/);
  assert.match(res.text, /\/harness-cli continue <任务名>/);
  assert.match(res.text, /做到一半（进行中 · 30%）/);
});

test('/harness-cli restart：多选任务后进度归零、方案待确认并派发从 Step 1 重跑', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '任务甲', { status: '完成', pct: 100, planStatus: '已确认' });
  seedTask(dir, '任务乙', { status: '进行中', pct: 50, planStatus: '已确认' });

  const asked = [];
  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return {
          answers: [{ id: 'harness-cli', selected: ['任务甲', '任务乙'] }],
        };
      },
    },
  });
  mod.apply(ctx);

  const sent = [];
  const agent = {
    session: { header: { cwd: dir } },
    steer: (message) => sent.push(message),
  };
  const res = await commandFor(commands, 'restart').handler({
    rawInput: '',
    agent,
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 1, '应弹一次多选框');
  const question = asked[0].questions[0];
  assert.strictEqual(question.header, '重跑任务');
  assert.strictEqual(question.multiSelect, true, 'restart 必须支持多选');
  const labels = question.options.map((option) => option.label);
  assert.strictEqual(labels.length, 2, '所有任务都应在候选里');
  assert.ok(labels.includes('任务甲') && labels.includes('任务乙'));

  for (const name of ['任务甲', '任务乙']) {
    const page = fs.readFileSync(
      path.join(dir, 'prototype', name, 'progress.html'),
      'utf8',
    );
    assert.match(page, /data-task-status="进行中"/, `${name} 状态应重置`);
    assert.ok(!/data-pct="(?:50|100)"/.test(page), `${name} 步骤进度应归零`);
    const plan = fs.readFileSync(
      path.join(dir, 'prototype', name, 'plan.html'),
      'utf8',
    );
    assert.match(plan, /data-plan-status="待确认"/, `${name} 方案应回到待确认`);
  }

  assert.strictEqual(sent.length, 1, '重置后应派发一次重跑请求');
  assert.match(sent[0].content[0].text, /重跑任务/);
  assert.match(sent[0].content[0].text, /任务甲/);
  assert.match(sent[0].content[0].text, /任务乙/);
  assert.match(sent[0].content[0].text, /从 Step 1 开始执行/);
  assert.match(res.text, /已重跑 2 个任务/);
});

test('/harness-cli restart：一个都不选时不动文件、也不派发', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '保持原样', { status: '完成', pct: 100, planStatus: '已确认' });
  const page = path.join(dir, 'prototype', '保持原样', 'progress.html');
  const before = fs.readFileSync(page, 'utf8');

  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask() {
        return { answers: [{ id: 'harness-cli', selected: [] }] };
      },
    },
  });
  mod.apply(ctx);
  const sent = [];
  const res = await commandFor(commands, 'restart').handler({
    rawInput: '',
    agent: {
      session: { header: { cwd: dir } },
      steer: (message) => sent.push(message),
    },
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.match(res.text, /没有选择任务/);
  assert.strictEqual(
    fs.readFileSync(page, 'utf8'),
    before,
    '未选任务时任务页不应变化',
  );
  assert.strictEqual(sent.length, 0, '未选任务时不应派发');
});

test('/harness-cli restart：直接给任务名时跳过多选框，只重跑指定任务', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '只跑这个', { status: '完成', pct: 100, planStatus: '已确认' });
  seedTask(dir, '不要动', { status: '完成', pct: 100, planStatus: '已确认' });

  let asked = 0;
  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask() {
        asked += 1;
        return { answers: [{ id: 'harness-cli', selected: [] }] };
      },
    },
  });
  mod.apply(ctx);
  const res = await commandFor(commands, 'restart').handler({
    rawInput: '只跑这个',
    agent: { session: { header: { cwd: dir } }, steer: () => {} },
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked, 0, '显式任务名时不应弹窗');
  assert.match(res.text, /已重跑 1 个任务/);
  const touched = fs.readFileSync(
    path.join(dir, 'prototype', '只跑这个', 'progress.html'),
    'utf8',
  );
  assert.match(touched, /data-task-status="进行中"/);
  const untouched = fs.readFileSync(
    path.join(dir, 'prototype', '不要动', 'progress.html'),
    'utf8',
  );
  assert.match(untouched, /data-task-status="完成"/);
});

test('/harness-cli restart：任务名不存在时列出可选项，不写盘', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '真实任务', { status: '进行中' });
  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const res = await commandFor(commands, 'restart').handler({
    rawInput: '查无此任务',
    agent: { session: { header: { cwd: dir } } },
  });

  assert.strictEqual(res.kind, 'error', res.text);
  assert.match(res.text, /没有找到任务：查无此任务/);
  assert.match(res.text, /真实任务（进行中）/);
});

test('/harness-cli：菜单选「继续任务」后接着弹任务选择并派发', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '接着做', { status: '进行中', pct: 20 });

  const answers = [
    { answers: [{ id: 'harness-cli', selected: ['继续任务'] }] },
    { answers: [{ id: 'harness-cli', selected: ['接着做'] }] },
  ];
  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask() {
        return answers.shift();
      },
    },
  });
  mod.apply(ctx);
  const sent = [];
  const cli = commands.find((command) => command.name === 'harness-cli');
  const res = await cli.handler({
    rawInput: '',
    agent: {
      session: { header: { cwd: dir } },
      steer: (message) => sent.push(message),
    },
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.match(res.text, /已执行 \/harness-cli continue/);
  assert.strictEqual(sent.length, 1, '菜单入口也应派发继续请求');
  assert.match(sent[0].content[0].text, /继续任务「接着做」/);
});

/** 写一份能通过 Google 数模 lint 的 schema（含主键、外键索引、审计时间）。 */
function writeValidSchema(dir, task) {
  const file = path.join(dir, 'docs', 'specs', task, 'schema.sql');
  fs.writeFileSync(
    file,
    [
      'CREATE TABLE user_account (',
      '  user_account_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,',
      '  email varchar(255) NOT NULL UNIQUE,',
      '  created_at timestamptz NOT NULL DEFAULT now(),',
      '  updated_at timestamptz NOT NULL DEFAULT now()',
      ');',
      'CREATE TABLE login_attempt (',
      '  login_attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,',
      '  user_account_id bigint NOT NULL REFERENCES user_account (user_account_id),',
      '  succeeded boolean NOT NULL,',
      '  created_at timestamptz NOT NULL DEFAULT now(),',
      '  updated_at timestamptz NOT NULL DEFAULT now()',
      ');',
      'CREATE INDEX idx_login_attempt_user_account_id ON login_attempt (user_account_id);',
      '',
    ].join('\n'),
  );
}

test('/harness-cli sql：多选任务后生成 schema / database.md / 数模图并派发设计', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '任务甲', { status: '进行中' });
  seedTask(dir, '任务乙', { status: '待验收' });

  const asked = [];
  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return {
          answers: [{ id: 'harness-cli', selected: ['任务甲', '任务乙'] }],
        };
      },
    },
  });
  mod.apply(ctx);

  const sent = [];
  const agent = {
    session: { header: { cwd: dir } },
    steer: (message) => sent.push(message),
  };
  const res = await commandFor(commands, 'sql').handler({
    rawInput: '',
    agent,
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 1, '应弹一次多选框');
  const question = asked[0].questions[0];
  assert.strictEqual(question.header, '数据库设计');
  assert.strictEqual(question.multiSelect, true, 'sql 必须支持多选');
  const labels = question.options.map((option) => option.label);
  assert.strictEqual(labels.length, 2);
  assert.ok(labels.includes('任务甲') && labels.includes('任务乙'));

  for (const name of ['任务甲', '任务乙']) {
    assert.ok(
      fs.existsSync(path.join(dir, 'docs', 'specs', name, 'schema.sql')),
      `${name} 应有 schema.sql`,
    );
    assert.ok(
      fs.existsSync(path.join(dir, 'docs', 'specs', name, 'database.md')),
      `${name} 应有 database.md`,
    );
    assert.ok(
      fs.existsSync(path.join(dir, 'prototype', name, 'db', 'index.html')),
      `${name} 应有数模图`,
    );
  }

  assert.strictEqual(sent.length, 1, '待设计的任务应派发一次设计请求');
  assert.match(sent[0].content[0].text, /数据库设计/);
  assert.match(sent[0].content[0].text, /Google 数模规范/);
  assert.match(sent[0].content[0].text, /harness_cli_sql/);
  assert.match(res.text, /覆盖执行：2 个/);
});

test('/harness-cli sql：已有 schema 也覆盖执行并派发重新设计', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '已设计任务', { status: '进行中' });
  writeValidSchema(dir, '已设计任务');

  const { ctx, commands } = fakeCtx();
  mod.apply(ctx);
  const sent = [];
  const res = await commandFor(commands, 'sql').handler({
    rawInput: '已设计任务',
    agent: {
      session: { header: { cwd: dir } },
      steer: (message) => sent.push(message),
    },
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(sent.length, 1, '已有 schema 也要覆盖执行并派发');
  assert.match(sent[0].content[0].text, /已存在.*覆盖/);
  assert.match(res.text, /覆盖执行：1 个/);
  assert.ok(
    fs.existsSync(path.join(dir, 'docs', 'specs', '已设计任务', 'er.mmd')),
  );
  const page = fs.readFileSync(
    path.join(dir, 'prototype', '已设计任务', 'db', 'index.html'),
    'utf8',
  );
  assert.match(page, /data-table="user_account"/);
  assert.match(page, /data-table="login_attempt"/);
});

test('harness_cli_sql：工具运行 CLI 并生成 Mermaid / 数模图', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '工具任务', { status: '进行中' });
  writeValidSchema(dir, '工具任务');

  const { ctx, tools } = fakeCtx();
  mod.apply(ctx);
  const tool = tools.find((item) => item.name === 'harness_cli_sql');
  assert.ok(tool, '应注册 harness_cli_sql');
  const result = await tool.execute({ task: '工具任务' }, fakeExec(dir));

  assert.strictEqual(result.exitCode, 0, result.report);
  assert.match(result.report, /2 张表 \/ 1 条关系/);
  assert.ok(
    fs.existsSync(path.join(dir, 'docs', 'specs', '工具任务', 'er.mmd')),
  );
  assert.ok(
    fs.existsSync(path.join(dir, 'prototype', '工具任务', 'db', 'index.html')),
  );
});

test('/harness-cli delete：多选删除任务，进行中的任务先发停止指令', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '进行中的任务', { status: '进行中', pct: 40 });
  seedTask(dir, '已完成任务', { status: '完成', pct: 100 });

  const asked = [];
  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return {
          answers: [
            { id: 'harness-cli', selected: ['进行中的任务', '已完成任务'] },
          ],
        };
      },
    },
  });
  mod.apply(ctx);

  const sent = [];
  const agent = {
    session: { header: { cwd: dir } },
    steer: (message) => sent.push(message),
  };
  const res = await commandFor(commands, 'delete').handler({
    rawInput: '',
    agent,
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(
    asked[0].questions[0].multiSelect,
    true,
    'delete 必须支持多选',
  );
  assert.strictEqual(asked[0].questions[0].options.length, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'prototype', '进行中的任务')));
  assert.ok(!fs.existsSync(path.join(dir, 'prototype', '已完成任务')));
  assert.ok(!fs.existsSync(path.join(dir, 'docs', 'specs', '进行中的任务')));

  assert.strictEqual(sent.length, 1, '进行中的任务应先收到停止指令');
  assert.match(sent[0].content[0].text, /立即停止任务：进行中的任务/);
  assert.match(sent[0].content[0].text, /不要重新创建/);
  assert.match(res.text, /已停止进行中的任务：进行中的任务/);
});

test('/harness-cli delete：一个都不选时不动文件、也不停止任何任务', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '保持不变', { status: '进行中' });
  const page = path.join(dir, 'prototype', '保持不变', 'progress.html');
  const before = fs.readFileSync(page, 'utf8');

  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask() {
        return { answers: [{ id: 'harness-cli', selected: [] }] };
      },
    },
  });
  mod.apply(ctx);
  const sent = [];
  const res = await commandFor(commands, 'delete').handler({
    rawInput: '',
    agent: {
      session: { header: { cwd: dir } },
      steer: (message) => sent.push(message),
    },
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.match(res.text, /没有选择任务/);
  assert.strictEqual(fs.readFileSync(page, 'utf8'), before);
  assert.strictEqual(sent.length, 0);
});

test('/harness-cli delete：显式任务名保留一次确认，取消时不删', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '不要删我', { status: '进行中' });

  const { ctx, commands } = fakeCtx({ userQuestions: fakeQuestions('取消') });
  mod.apply(ctx);
  const res = await commandFor(commands, 'delete').handler({
    rawInput: '不要删我',
    agent: { session: { header: { cwd: dir } } },
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.match(res.text, /已取消删除/);
  assert.ok(fs.existsSync(path.join(dir, 'prototype', '不要删我')));
});

test('/harness-cli：菜单选「删除任务」直接弹全部任务多选，不再先问任务名', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, '菜单删除', { status: '完成', pct: 100 });

  const answers = [
    { answers: [{ id: 'harness-cli', selected: ['删除任务'] }] },
    { answers: [{ id: 'harness-cli', selected: ['菜单删除'] }] },
  ];
  const asked = [];
  const { ctx, commands } = fakeCtx({
    cwd: dir,
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return answers.shift();
      },
    },
  });
  mod.apply(ctx);
  const cli = commands.find((command) => command.name === 'harness-cli');
  const res = await cli.handler({
    rawInput: '',
    agent: { session: { header: { cwd: dir } }, steer: () => {} },
  });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(
    asked.length,
    2,
    '选指令 → 直接多选，不再插一次任务名输入',
  );
  assert.strictEqual(asked[1].questions[0].multiSelect, true);
  assert.match(res.text, /已执行 \/harness-cli delete/);
  assert.ok(!fs.existsSync(path.join(dir, 'prototype', '菜单删除')));
});

test('/harness-cli：page 先选数模设计、再选 UI，选数模后生成 schema 与整体数模图', async () => {
  const mod = await import('../cordis.mjs');
  const asked = [];
  const answers = [
    { answers: [{ id: 'harness-cli', selected: ['建任务'] }] },
    { answers: [{ id: 'harness-cli', selected: [], custom: '登录页面' }] },
    { answers: [{ id: 'harness-cli', selected: ['自动 loop'] }] },
    { answers: [{ id: 'harness-cli', selected: ['创建数模设计'] }] },
    { answers: [{ id: 'harness-cli', selected: ['先不用'] }] },
  ];
  const { ctx, commands } = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return answers.shift();
      },
    },
  });
  mod.apply(ctx);

  const dir = tmpRepo();
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js'),
      'init',
      '--preset',
      'prototype',
      '--root',
      dir,
    ],
    { cwd: dir, encoding: 'utf8' },
  );

  const sent = [];
  const agent = {
    session: { header: { cwd: dir } },
    steer: (message) => sent.push(message),
  };
  const res = await commands
    .find((command) => command.name === 'harness-cli')
    .handler({ rawInput: '', agent });

  assert.strictEqual(res.kind, 'success', res.text);
  assert.strictEqual(asked.length, 5, '选指令 → 任务名 → 模式 → 数模 → UI');
  assert.strictEqual(asked[2].questions[0].header, '操作模式');
  assert.strictEqual(asked[3].questions[0].header, '数模设计');
  assert.strictEqual(asked[4].questions[0].header, 'UI 设计');
  assert.ok(
    fs.existsSync(path.join(dir, 'docs', 'specs', '登录页面', 'schema.sql')),
  );
  assert.ok(
    fs.existsSync(path.join(dir, 'docs', 'specs', '登录页面', 'database.md')),
  );
  assert.ok(
    fs.existsSync(path.join(dir, 'prototype', 'db.html')),
    '应生成整体数模图',
  );
  assert.strictEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(dir, 'prototype', '登录页面', '.harness-mode.json'),
        'utf8',
      ),
    ).mode,
    'auto',
    '自动 loop 模式应落到任务目录',
  );
  assert.ok(
    !fs.existsSync(path.join(dir, 'prototype', '登录页面', 'ui')),
    '第二个问题选「先不用」不应生成 UI',
  );
  assert.strictEqual(sent.length, 1, '选数模设计后应派发设计请求');
  assert.match(sent[0].content[0].text, /数据库设计/);
  assert.match(res.text, /已执行 \/harness-cli sql 登录页面/);
});

test('harness_cli_plan：任务模式 auto 时确认方案不再弹窗', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, 'auto-plan', { status: '进行中' });
  fs.writeFileSync(
    path.join(dir, 'prototype', 'auto-plan', '.harness-mode.json'),
    `${JSON.stringify({ mode: 'auto' })}\n`,
  );

  const asked = [];
  const { ctx } = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return { answers: [{ id: 'harness-cli', selected: ['取消'] }] };
      },
    },
  });
  const spec = mod.TOOL_SPECS.find(
    (item) => item.toolName === 'harness_cli_plan',
  );
  const result = await spec.decide({
    ctx,
    exec: fakeExec(dir),
    input: { task: 'auto-plan', confirm: true },
    root: dir,
    argv: ['plan', 'auto-plan', '--confirm'],
  });

  assert.strictEqual(result, null, 'auto 模式应直接继续（由 CLI 自动补 by）');
  assert.strictEqual(asked.length, 0, 'auto 模式不应弹确认框');
});

test('harness_cli_plan：没有 auto 标记时仍然弹窗确认', async () => {
  const mod = await import('../cordis.mjs');
  const dir = tmpRepo();
  seedTask(dir, 'manual-plan', { status: '进行中' });

  const asked = [];
  const { ctx } = fakeCtx({
    userQuestions: {
      async ask(request) {
        asked.push(request);
        return { answers: [{ id: 'harness-cli', selected: ['取消'] }] };
      },
    },
  });
  const spec = mod.TOOL_SPECS.find(
    (item) => item.toolName === 'harness_cli_plan',
  );
  const result = await spec.decide({
    ctx,
    exec: fakeExec(dir),
    input: { task: 'manual-plan', confirm: true },
    root: dir,
    argv: ['plan', 'manual-plan', '--confirm'],
  });

  assert.strictEqual(result.cancelled, true);
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].questions[0].header, '方案确认');
});
