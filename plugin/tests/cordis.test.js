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
function fakeCtx() {
  const tools = [];
  const commands = [];
  const ctx = {
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
  };
  return {ctx, tools, commands};
}

test('模块导出 cordis 插件契约', async () => {
  const mod = await import('../cordis.mjs');
  assert.strictEqual(mod.name, 'harness-cli');
  assert.deepStrictEqual(mod.inject, ['tools']);
  assert.strictEqual(typeof mod.apply, 'function');
  assert.strictEqual(mod.TOOL_SPECS.length, 11);
});

test('apply 注册 5 个工具与 3 个斜杠命令', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, tools, commands} = fakeCtx();
  mod.apply(ctx);

  assert.deepStrictEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'harness_cli_agents',
      'harness_cli_check',
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
    [
      'harness-cli-check',
      'harness-cli-doctor',
      'harness-cli-help',
      'harness-cli-init',
      'harness-cli-plan',
      'harness-cli-plans',
      'harness-cli-progress',
      'harness-cli-review',
      'harness-cli-ui',
      'harness-cli-wiki',
    ]
  );
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

test('/harness-cli-ui 命令：中文任务名也能生成（目录自动创建）', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const ui = commands.find((command) => command.name === 'harness-cli-ui');
  assert.ok(ui, '应注册 /harness-cli-ui');

  const dir = tmpRepo();
  const result = await ui.handler({
    rawInput: '登录页面',
    agent: {session: {header: {cwd: dir}}},
  });
  assert.strictEqual(result.kind, 'success', result.text);
  assert.ok(fs.existsSync(path.join(dir, 'prototype', '登录页面', 'ui', 'index.html')));
  assert.ok(fs.existsSync(path.join(dir, 'prototype', '登录页面', 'ui', 'README.md')));
});

test('/harness-cli-ui：显式 --root 指向不存在的目录时主动创建', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const ui = commands.find((command) => command.name === 'harness-cli-ui');

  const base = tmpRepo();
  const target = path.join(base, 'new-project');
  const result = await ui.handler({
    rawInput: `登录页面 --root "${target}"`,
    agent: {session: {header: {cwd: base}}},
  });
  assert.strictEqual(result.kind, 'success', result.text);
  assert.ok(fs.existsSync(path.join(target, 'prototype', '登录页面', 'ui', 'index.html')));
});

test('/harness-cli-help：列出全部命令与工具，并支持按名字查看', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);

  // 帮助手册与真实注册项必须同名（防止加了命令忘了写说明）
  assert.deepStrictEqual(
    commands.map((command) => command.name).sort(),
    mod.COMMAND_MANUAL.map((item) => item.name).sort()
  );

  const help = commands.find((command) => command.name === 'harness-cli-help');
  const full = await help.handler({rawInput: ''});
  assert.strictEqual(full.kind, 'success');
  for (const item of mod.COMMAND_MANUAL) assert.ok(full.text.includes('/' + item.name), `缺少 ${item.name}`);
  for (const spec of mod.TOOL_SPECS) assert.ok(full.text.includes(spec.toolName), `缺少 ${spec.toolName}`);
  assert.match(full.text, /任务标准流程/);
  assert.match(full.text, /退出码/);

  const one = await help.handler({rawInput: 'ui'});
  assert.match(one.text, /\/harness-cli-ui/);
  assert.doesNotMatch(one.text, /\/harness-cli-wiki/);

  const tool = await help.handler({rawInput: 'harness_cli_progress'});
  assert.match(tool.text, /harness_cli_progress/);

  const missing = await help.handler({rawInput: 'nope'});
  assert.match(missing.text, /没有找到/);
});

test('/harness-cli-ui：省略任务名时自动选最近的任务', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const ui = commands.find((command) => command.name === 'harness-cli-ui');
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

test('/harness-cli-plans：生成页面；--serve 起服务、--stop 停止', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const plans = commands.find((command) => command.name === 'harness-cli-plans');
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
  const serve = await plans.handler({rawInput: `--serve --port ${port}`, agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(serve.kind, 'success', serve.text);
  assert.match(serve.text, new RegExp(String(port)));

  const again = await plans.handler({rawInput: `--serve --port ${port}`, agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(again.kind, 'success', again.text);
  assert.match(again.text, /已在运行/);

  const stop = await plans.handler({rawInput: '--stop', agent: {session: {header: {cwd: dir}}}});
  assert.strictEqual(stop.kind, 'success', stop.text);
});

test('/harness-cli-wiki：生成后自动发起「反推补全」对话', async () => {
  const mod = await import('../cordis.mjs');
  const {ctx, commands} = fakeCtx();
  mod.apply(ctx);
  const wiki = commands.find((command) => command.name === 'harness-cli-wiki');

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
  const ui = commands.find((command) => command.name === 'harness-cli-ui');

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
