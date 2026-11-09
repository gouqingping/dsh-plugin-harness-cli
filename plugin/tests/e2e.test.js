'use strict';

/**
 * 端到端：证明"规则真的会失败"。
 * 每个用例只改一个变量，断言失败码与失败原因，避免出现"看起来通过"的假绿。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync, spawn} = require('child_process');
const http = require('http');

const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');

function run(args, cwd) {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], {cwd, encoding: 'utf8'});
    return {code: 0, out};
  } catch (err) {
    return {code: err.status === undefined ? 1 : err.status, out: String(err.stdout || ''), err: String(err.stderr || '')};
  }
}

function repo(initArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-e2e-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'e2e-app', version: '1.0.0', scripts: {test: 'node --test'}}));
  const res = run(['init', '--root', dir, ...(initArgs || [])], dir);
  assert.strictEqual(res.code, 0, res.err);
  return dir;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** 改并行上限：task_queue.json 的 wipLimit 是唯一的并行度来源。 */
function setWip(dir, limit) {
  const file = path.join(dir, 'task_queue.json');
  const data = readJson(file);
  data.wipLimit = limit;
  writeJson(file, data);
}

/** 按顺序设置 feature 状态。 */
function setStatuses(dir, statuses) {
  const file = path.join(dir, 'docs/feature_list.json');
  const data = readJson(file);
  statuses.forEach((status, index) => {
    if (data.features[index]) data.features[index].status = status;
  });
  writeJson(file, data);
}

/** 跑生成出来的 scripts/claim.js（它才是认领规则的真源）。 */
function claim(dir, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(dir, 'scripts', 'claim.js'), ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
    return {code: 0, out};
  } catch (err) {
    return {
      code: err.status === undefined ? 1 : err.status,
      out: String(err.stdout || ''),
      err: String(err.stderr || ''),
    };
  }
}

test('init 生成骨架，check 通过', () => {
  const dir = repo();
  for (const rel of [
    'AGENTS.md',
    'init.sh',
    'scripts/gate.sh',
    'scripts/claim.js',
    'docs/claims/README.md',
    'docs/feature_list.json',
    'claude-progress.md',
    'docs/current.md',
    '.gitignore',
  ]) {
    assert.ok(fs.existsSync(path.join(dir, rel)), `缺少 ${rel}`);
  }
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /5\.2 并行 loop/, 'AGENTS.md 应写清认领约定');
  const lines = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').split('\n').length;
  assert.ok(lines <= 120, `AGENTS.md ${lines} 行超限`);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.out);
});

test('init 幂等：第二次不覆盖已有文件', () => {
  const dir = repo();
  const agents = path.join(dir, 'AGENTS.md');
  fs.appendFileSync(agents, '\n人工补充的一行\n');
  const before = fs.readFileSync(agents, 'utf8');

  const res = run(['init', '--root', dir], dir);
  assert.strictEqual(res.code, 0);
  assert.strictEqual(fs.readFileSync(agents, 'utf8'), before, 'init 覆盖了已有文件');
});

test('默认 wipLimit=1：两个 in_progress 触发 F107 失败', () => {
  const dir = repo();
  setStatuses(dir, ['in_progress', 'in_progress']);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /超过 wipLimit = 1/);
});

test('done 没有 evidence 触发失败', () => {
  const dir = repo();
  const file = path.join(dir, 'docs/feature_list.json');
  const data = readJson(file);
  data.features[0].evidence = [];
  writeJson(file, data);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /没有 evidence/);
});

test('AGENTS.md 加失效链接触发失败', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'AGENTS.md'), '\n- 部署说明：`docs/deploy-missing.md`\n');

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /失效链接/);
});

test('AGENTS.md 超过 120 行触发失败', () => {
  const dir = repo();
  const file = path.join(dir, 'AGENTS.md');
  // 填充量按当前行数算，避免模板变短后用例失效（曾经写死 40 行导致假绿）
  const before = fs.readFileSync(file, 'utf8');
  const extra = Math.max(0, 130 - before.split('\n').length);
  fs.writeFileSync(file, `${before}\n${'padding\n'.repeat(extra)}`);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /超过 120 行/);
});

test('agents 生成后与配置同源，定位占位给出警告', () => {
  const dir = repo();
  const cfgFile = path.join(dir, 'harness-cli.json');
  const cfg = readJson(cfgFile);
  cfg.project.positioning = '本地优先的任务看板，数据存在 SQLite。';
  writeJson(cfgFile, cfg);

  const res = run(['agents', '--root', dir], dir);
  assert.strictEqual(res.code, 0);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /SQLite/);

  const check = run(['check', '--root', dir], dir);
  assert.strictEqual(check.code, 0);
  assert.doesNotMatch(check.out, /占位内容/);
});

test('并行：wipLimit=2 时两个 in_progress + 两份不重叠认领通过', () => {
  const dir = repo();
  setWip(dir, 2);
  setStatuses(dir, ['in_progress', 'in_progress']);

  assert.strictEqual(claim(dir, ['add', 'F-001', '--owner', 'session-a', '--scope', 'src/auth']).code, 0);
  assert.strictEqual(claim(dir, ['add', 'F-002', '--owner', 'session-b', '--scope', 'src/billing']).code, 0);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, /C201\s+in_progress 全部有认领/);
  assert.match(res.out, /F107\s+WIP 正常（in_progress = 2 \/ 上限 2）/);
});

test('并行：wipLimit 调回 1 后 F107 与 C205 同时失败', () => {
  const dir = repo();
  setWip(dir, 2);
  setStatuses(dir, ['in_progress', 'in_progress']);
  claim(dir, ['add', 'F-001', '--owner', 'a', '--scope', 'src/auth']);
  claim(dir, ['add', 'F-002', '--owner', 'b', '--scope', 'src/billing']);

  setWip(dir, 1);
  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /F107\s+同时有 2 个 in_progress，超过 wipLimit = 1/);
  assert.match(res.out, /C205\s+当前 2 个认领/);
});

test('in_progress 没有认领触发 C201', () => {
  const dir = repo();
  setStatuses(dir, ['in_progress']);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /C201[\s\S]*F-001/);
});

test('claim add 拒绝重复认领 / 超上限 / scope 冲突', () => {
  const dir = repo();
  setStatuses(dir, ['in_progress', 'in_progress']);

  assert.strictEqual(claim(dir, ['add', 'F-001', '--owner', 'a', '--scope', 'src/auth']).code, 0);
  const dup = claim(dir, ['add', 'F-001', '--owner', 'b', '--scope', 'docs']);
  assert.strictEqual(dup.code, 1);
  assert.match(dup.err, /已被认领/);

  const over = claim(dir, ['add', 'F-002', '--owner', 'b', '--scope', 'docs']);
  assert.strictEqual(over.code, 1);
  assert.match(over.err, /并行上限 1/);

  setWip(dir, 2);
  const overlap = claim(dir, ['add', 'F-002', '--owner', 'b', '--scope', 'src/auth/deep']);
  assert.strictEqual(overlap.code, 1);
  assert.match(overlap.err, /scope 冲突/);

  assert.strictEqual(claim(dir, ['add', 'F-002', '--owner', 'b', '--scope', 'src/billing']).code, 0);
  const listOut = claim(dir, ['list']).out;
  assert.match(listOut, /F-001 由 a 认领/);
  assert.match(listOut, /F-002 由 b 认领/);
});

test('prune 只清理死掉的认领，dry-run 不动文件', () => {
  const dir = repo();
  setWip(dir, 2);
  setStatuses(dir, ['in_progress', 'in_progress']);
  claim(dir, ['add', 'F-001', '--owner', 'a', '--scope', 'src/auth']);
  claim(dir, ['add', 'F-002', '--owner', 'b', '--scope', 'src/billing']);

  const staleFile = path.join(dir, 'docs/claims/F-002.json');
  const data = readJson(staleFile);
  const stale = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  data.startedAt = stale;
  data.heartbeatAt = stale;
  writeJson(staleFile, data);

  const dry = claim(dir, ['prune', '--dry-run']);
  assert.match(dry.out, /将删除 F-002/);
  assert.ok(fs.existsSync(staleFile), 'dry-run 不能删文件');

  const real = claim(dir, ['prune']);
  assert.match(real.out, /已清理 1 个认领/);
  assert.ok(!fs.existsSync(staleFile));
  assert.ok(fs.existsSync(path.join(dir, 'docs/claims/F-001.json')), '新鲜认领不能被清理');
});

test('两份认领 scope 重叠触发 C203（绕过 add 直接写文件也能抓到）', () => {
  const dir = repo();
  setWip(dir, 2);
  setStatuses(dir, ['in_progress', 'in_progress']);
  claim(dir, ['add', 'F-001', '--owner', 'a', '--scope', 'src/auth']);
  const now = new Date().toISOString();
  writeJson(path.join(dir, 'docs/claims/F-002.json'), {
    feature: 'F-002',
    owner: 'b',
    loop: 1,
    scope: ['src/auth/deep'],
    status: 'active',
    startedAt: now,
    heartbeatAt: now,
  });

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /C203\s+写冲突/);
});

test('陈旧认领只警告（C204），不判失败', () => {
  const dir = repo();
  setStatuses(dir, ['in_progress']);
  claim(dir, ['add', 'F-001', '--owner', 'a', '--scope', 'src/auth']);

  const file = path.join(dir, 'docs/claims/F-001.json');
  const data = readJson(file);
  const stale = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  data.startedAt = stale;
  data.heartbeatAt = stale;
  writeJson(file, data);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, /C204/);
});

test('done 还留着认领触发 C202；release 之后 in_progress 无认领触发 C201', () => {
  const dir = repo();
  setStatuses(dir, ['in_progress']);
  claim(dir, ['add', 'F-001', '--owner', 'a', '--scope', 'src/auth']);

  // 收工只改了状态、忘了 release
  const file = path.join(dir, 'docs/feature_list.json');
  const data = readJson(file);
  data.features[0].status = 'done';
  data.features[0].evidence = ['node --test：12 passed'];
  writeJson(file, data);
  const done = run(['check', '--root', dir], dir);
  assert.strictEqual(done.code, 1);
  assert.match(done.out, /C202[\s\S]*done/);

  assert.strictEqual(claim(dir, ['release', 'F-001']).code, 0);

  // 释放之后又把状态改回 in_progress：这次是没有认领
  const back = readJson(file);
  back.features[0].status = 'in_progress';
  writeJson(file, back);
  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /C201[\s\S]*F-001/);
});

test('claims.enabled=false 时整条认领链路跳过', () => {
  const dir = repo();
  const cfgFile = path.join(dir, 'harness-cli.json');
  const cfg = readJson(cfgFile);
  cfg.claims = {enabled: false, ttlHours: 12};
  writeJson(cfgFile, cfg);
  setWip(dir, 2);
  setStatuses(dir, ['in_progress', 'in_progress']);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.out);
  assert.ok(!/C201|C205|H107/.test(res.out), '关闭后不该再出现认领判定');
});

/** 用 plan 的内容模型把任务页与四份文档填成"合格"的样子（与真实用法一致）。 */
function fillTask(dir, name = 'task-demo') {
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
      {title: '写契约与失败用例', spec: 'S-01'},
      {title: '实现账号与会话', spec: 'S-02'},
      {title: '回归与文档', spec: 'S-02'},
    ],
    acceptance: ['S-01、S-02 的验收标准全部可执行', '门禁全绿'],
  };
  const res = run(['plan', name, '--input-json', JSON.stringify(model), '--force', '--root', dir], dir);
  assert.strictEqual(res.code, 0, `${res.out}${res.err}`);
}

test('wiki：首次生成 13 篇，二次运行不重复写', () => {
  const dir = repo(['--preset', 'prototype']);
  const first = run(['wiki', '--root', dir], dir);
  assert.strictEqual(first.code, 0, first.out);
  // 13 篇主文档 + 每个反推出的业务域一页（初始项目里是 scripts/）
  assert.match(first.out, /已写入 1[34] 篇/);

  for (const file of [
    '一页纸速览.md',
    '系统全景与部署形态.md',
    '角色与场景.md',
    '业务流程.md',
    '功能清单.md',
    '业务规则与状态.md',
    '业务规范与口径.md',
    '质量与交付卡点.md',
    '验收与测试要点.md',
    '业务风险与现场现象.md',
    '术语表.md',
    '业务操作手册.md',
    'README.md',
  ]) {
    assert.ok(fs.existsSync(path.join(dir, 'docs/wiki', file)), `缺少 ${file}`);
  }

  const second = run(['wiki', '--root', dir], dir);
  assert.strictEqual(second.code, 0, second.out);
  assert.match(second.out, /已写入 0 篇/);
});

test('wiki：人工改受管区块报冲突；--keep 保留、--update 覆盖', () => {
  const dir = repo();
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);

  const file = path.join(dir, 'docs/wiki/术语表.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## 1. 体系与文件', '## 1. 体系与文件（人工改名）'));

  const conflict = run(['wiki', '--root', dir], dir);
  assert.strictEqual(conflict.code, 1);
  assert.match(conflict.out, /CONFLICT/);

  const keep = run(['wiki', '--keep', '--root', dir], dir);
  assert.strictEqual(keep.code, 0, keep.out);
  assert.match(fs.readFileSync(file, 'utf8'), /人工改名/);

  const update = run(['wiki', '--update', '--root', dir], dir);
  assert.strictEqual(update.code, 0, update.out);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /人工改名/);
});

test('wiki：受管区块外的人工内容不被覆盖', () => {
  const dir = repo();
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);

  const file = path.join(dir, 'docs/wiki/业务风险与现场现象.md');
  fs.appendFileSync(file, '\n- 人工补充：现场约定 X。\n');

  const res = run(['wiki', '--update', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.out);
  assert.match(fs.readFileSync(file, 'utf8'), /人工补充：现场约定 X/);
});

test('wiki --check：缺失报 1，生成后为 0', () => {
  const dir = repo();
  const before = run(['wiki', '--check', '--root', dir], dir);
  assert.strictEqual(before.code, 1);

  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);
  const after = run(['wiki', '--check', '--root', dir], dir);
  assert.strictEqual(after.code, 0, after.out);
});

test('wiki：内容来自实际文件（功能编号、并行上限），dry-run 不落盘', () => {
  const dir = repo();
  const dry = run(['wiki', '--dry-run', '--root', dir], dir);
  assert.strictEqual(dry.code, 0, dry.out);
  assert.ok(!fs.existsSync(path.join(dir, 'docs/wiki')), 'dry-run 不能创建目录');

  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);
  const features = fs.readFileSync(path.join(dir, 'docs/wiki/功能清单.md'), 'utf8');
  assert.match(features, /F-001/);
  const rules = fs.readFileSync(path.join(dir, 'docs/wiki/业务规则与状态.md'), 'utf8');
  assert.match(rules, /并行上限 1/);
});

test('check：docs/wiki 过期或冲突时给 H109 警告', () => {
  const dir = repo();
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);
  const fresh = run(['check', '--root', dir], dir);
  assert.match(fresh.out, /H109\s+docs\/wiki 与事实一致/);

  // 改配置 → wiki 过期
  const cfgFile = path.join(dir, 'harness-cli.json');
  const cfg = readJson(cfgFile);
  cfg.project.positioning = '新的项目定位，会让 wiki 过期。';
  writeJson(cfgFile, cfg);
  const stale = run(['check', '--root', dir], dir);
  assert.match(stale.out, /H109[\s\S]*已过期/);

  // 人工改受管区块 → 冲突
  const file = path.join(dir, 'docs/wiki/术语表.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## 1. 体系与文件', '## 1. 人工改名'));
  const conflict = run(['check', '--root', dir], dir);
  assert.match(conflict.out, /H109[\s\S]*冲突/);
});

function reviewAndConfirm(dir, task) {
  const review = run(['review', task, '--root', dir], dir);
  assert.strictEqual(review.code, 0, `${review.out}${review.err}`);
  const confirm = run(['plan', task, '--confirm', '--by', '张三', '--root', dir], dir);
  assert.strictEqual(confirm.code, 0, `${confirm.out}${confirm.err}`);
}

test('page：任务页能力未开启时自动补齐 prototype 与规范文档', () => {
  const dir = repo();
  assert.strictEqual(readJson(path.join(dir, 'harness-cli.json')).presets.prototype.enabled, false);

  const res = run(['page', 'auto-task', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.err);
  assert.strictEqual(readJson(path.join(dir, 'harness-cli.json')).presets.prototype.enabled, true);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/auto-task/progress.html')));
  assert.ok(fs.existsSync(path.join(dir, 'docs/specs/auto-task/spec.md')));
});

test('中文任务名：page / ui 直接建目录，不再要求 kebab-case', () => {
  const dir = repo(['--preset', 'prototype']);

  const page = run(['page', '登录页面', '--root', dir], dir);
  assert.strictEqual(page.code, 0, page.err);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/登录页面/progress.html')));

  const ui = run(['ui', '登录页面', '--root', dir], dir);
  assert.strictEqual(ui.code, 0, ui.err);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/登录页面/ui/index.html')));

  const index = fs.readFileSync(path.join(dir, 'prototype/progress.html'), 'utf8');
  assert.match(index, /data-task="登录页面"/);
  assert.match(index, /data-ui="yes"/);
  // 链接对中文做 URL 编码，页面仍显示原名
  assert.match(index, /href="%E7%99%BB%E5%BD%95%E9%A1%B5%E9%9D%A2\/progress\.html"/);

  const check = run(['check', '--root', dir], dir);
  assert.doesNotMatch(check.out, /P2[^\n]*名字不合法/);
});

test('ui：生成 antd 设计稿与说明，总览标记 data-ui，P20 通过', () => {
  const dir = repo(['--preset', 'prototype']);
  const res = run(['ui', 'login-flow', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.err);

  const html = fs.readFileSync(path.join(dir, 'prototype/login-flow/ui/index.html'), 'utf8');
  assert.match(html, /data-design-system="antd"/);
  assert.match(html, /--ant-color-primary/);
  assert.match(fs.readFileSync(path.join(dir, 'prototype/login-flow/ui/README.md'), 'utf8'), /组件清单/);
  assert.match(fs.readFileSync(path.join(dir, 'prototype/progress.html'), 'utf8'), /data-ui="yes"/);

  const check = run(['check', '--root', dir], dir);
  assert.match(check.out, /P20\s+prototype\/login-flow\/ui\/index\.html 是 antd 风格/);
});

test('ui：混入第二套设计体系 / 缺令牌 / 缺说明都被 P20 判失败', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['ui', 'login-flow', '--root', dir], dir).code, 0);

  const file = path.join(dir, 'prototype/login-flow/ui/index.html');
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace('--ant-color-primary:', '--primary:')
      .replace('Ant Design v5', 'Bootstrap 5')
  );
  fs.rmSync(path.join(dir, 'prototype/login-flow/ui/README.md'));

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P20[^\n]*设计令牌/);
  assert.match(res.out, /P20[^\n]*bootstrap/);
  assert.match(res.out, /P20[^\n]*README\.md/);
});

test('ui：默认不覆盖已存在的设计稿，--force 才覆盖', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['ui', 'login-flow', '--root', dir], dir).code, 0);

  const file = path.join(dir, 'prototype/login-flow/ui/index.html');
  fs.writeFileSync(file, '<!-- 人工改过的设计稿 -->\n');

  const keep = run(['ui', 'login-flow', '--root', dir], dir);
  assert.strictEqual(keep.code, 0, keep.out);
  assert.match(fs.readFileSync(file, 'utf8'), /人工改过/);

  const force = run(['ui', 'login-flow', '--force', '--root', dir], dir);
  assert.strictEqual(force.code, 0, force.out);
  assert.match(fs.readFileSync(file, 'utf8'), /data-design-system="antd"/);
});

test('review：文档没填完时复盘失败，并写明失败项', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);

  const res = run(['review', 'task-demo', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  const review = fs.readFileSync(path.join(dir, 'docs/specs/task-demo/review.md'), 'utf8');
  assert.match(review, /状态：待确认/);
  assert.match(review, /❌/);
});

test('plan --confirm：没有复盘时拒绝确认', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  const res = run(['plan', 'task-demo', '--confirm', '--by', '张三', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.err, /还没有复盘/);
});

test('docs 改过之后确认失效：progress 拒绝，check 报 P22', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  reviewAndConfirm(dir, 'task-demo');

  // 先正常开工，让任务进入「已开始」状态
  assert.strictEqual(run(['progress', 'task-demo', '--step', '1', '--pct', '50', '--root', dir], dir).code, 0);

  const design = path.join(dir, 'docs/specs/task-demo/design.md');
  fs.appendFileSync(design, '\n- 人工补充：锁定账号 30 分钟。\n');

  const res = run(['progress', 'task-demo', '--step', '2', '--pct', '50', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.err, /在方案确认后被改过/);

  const check = run(['check', '--root', dir], dir);
  assert.match(check.out, /P22/);

  // 重新复盘 + 重新确认后恢复
  reviewAndConfirm(dir, 'task-demo');
  const again = run(['progress', 'task-demo', '--step', '2', '--pct', '50', '--root', dir], dir);
  assert.strictEqual(again.code, 0, again.err);
});

test('ui/plan/review：省略任务名时自动选上一次的任务（进行中优先）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-a', '--root', dir], dir);
  run(['page', 'task-b', '--root', dir], dir);

  // task-a 标完成，只有 task-b 还在进行中 → 应选 task-b
  const aPage = path.join(dir, 'prototype/task-a/progress.html');
  fs.writeFileSync(
    aPage,
    fs.readFileSync(aPage, 'utf8').replace('data-task-status="进行中"', 'data-task-status="完成"')
  );

  const ui = run(['ui', '--root', dir], dir);
  assert.strictEqual(ui.code, 0, ui.err);
  assert.match(ui.out, /自动选择/);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/task-b/ui/index.html')));
  assert.ok(!fs.existsSync(path.join(dir, 'prototype/task-a/ui/index.html')));

  const plan = run(['plan', '--root', dir], dir);
  assert.strictEqual(plan.code, 0, plan.err);
  assert.match(plan.out, /task-b/);

  const review = run(['review', '--root', dir], dir);
  assert.match(review.out, /task-b/);
});

test('省略任务名且还没有任务时给出引导', () => {
  const dir = repo(['--preset', 'prototype']);
  const res = run(['ui', '--root', dir], dir);
  assert.strictEqual(res.code, 2);
  assert.match(res.err, /还没有任务/);
});

test('ui 改了要同步 specs：design.md 指纹一致，改设计稿后 P23 失败', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  assert.strictEqual(run(['ui', 'task-demo', '--root', dir], dir).code, 0);
  const design = fs.readFileSync(path.join(dir, 'docs/specs/task-demo/design.md'), 'utf8');
  assert.match(design, /<!-- ui-design:begin -->/);
  assert.match(design, /指纹：/);

  const pas = run(['check', '--root', dir], dir);
  assert.doesNotMatch(pas.out, /P23/);

  fs.appendFileSync(path.join(dir, 'prototype/task-demo/ui/index.html'), '\n<!-- changed -->\n');
  const bad = run(['check', '--root', dir], dir);
  assert.match(bad.out, /P23[\s\S]*UI 指纹已过期/);

  assert.strictEqual(run(['ui', 'task-demo', '--root', dir], dir).code, 0);
  const fixed = run(['check', '--root', dir], dir);
  assert.doesNotMatch(fixed.out, /P23/);
});

test('wiki 改了要同步 specs：proposal.md 指纹一致，改 wiki 后 P24 失败', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);

  const proposal = fs.readFileSync(path.join(dir, 'docs/specs/task-demo/proposal.md'), 'utf8');
  assert.match(proposal, /<!-- wiki-context:begin -->/);

  assert.doesNotMatch(run(['check', '--root', dir], dir).out, /P24/);

  fs.appendFileSync(path.join(dir, 'docs/wiki/术语表.md'), '\n- 人工补充\n');
  const bad = run(['check', '--root', dir], dir);
  assert.match(bad.out, /P24[\s\S]*业务指纹已过期/);

  assert.strictEqual(run(['wiki', '--update', '--root', dir], dir).code, 0);
  assert.doesNotMatch(run(['check', '--root', dir], dir).out, /P24/);
});

test('plan 也会同步已有的 UI 与 wiki 事实', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  run(['ui', 'task-demo', '--root', dir], dir);
  run(['wiki', '--root', dir], dir);

  // 人为改掉两个受管区块，模拟「文档被回滚」
  const design = path.join(dir, 'docs/specs/task-demo/design.md');
  fs.writeFileSync(design, fs.readFileSync(design, 'utf8').replace(/<!-- ui-design:begin -->[\s\S]*?<!-- ui-design:end -->/, ''));
  const proposal = path.join(dir, 'docs/specs/task-demo/proposal.md');
  fs.writeFileSync(proposal, fs.readFileSync(proposal, 'utf8').replace(/<!-- wiki-context:begin -->[\s\S]*?<!-- wiki-context:end -->/, ''));

  const res = run(['plan', 'task-demo', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.err);
  assert.match(fs.readFileSync(design, 'utf8'), /<!-- ui-design:begin -->/);
  assert.match(fs.readFileSync(proposal, 'utf8'), /<!-- wiki-context:begin -->/);
});

test('plan：创建任务时把 docs/specs 四份文档一次补全', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'task-demo', '--root', dir], dir).code, 0);

  const plan = run(['plan', 'task-demo', '--root', dir], dir);
  assert.strictEqual(plan.code, 0, plan.err);
  assert.match(plan.out, /规范文档：写入 4 篇/);

  for (const file of ['proposal.md', 'spec.md', 'design.md', 'tasks.md']) {
    const text = fs.readFileSync(path.join(dir, 'docs/specs/task-demo', file), 'utf8');
    assert.doesNotMatch(text, /待填/, `${file} 不应再有占位`);
  }

  const page = fs.readFileSync(path.join(dir, 'prototype/task-demo/progress.html'), 'utf8');
  assert.match(page, /data-spec="S-01"/);
  assert.match(page, /data-case="T-01"/);
  assert.strictEqual((page.match(/class="step"/g) || []).length, 4, '默认规划 4 步');

  // 内容补全后，复盘应直接通过
  const review = run(['review', 'task-demo', '--root', dir], dir);
  assert.strictEqual(review.code, 0, `${review.out}${review.err}`);
  assert.match(fs.readFileSync(path.join(dir, 'docs/specs/task-demo/review.md'), 'utf8'), /复盘/);
});

test('plan：--input-json / 参数能改写文档内容', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);

  const model = {
    goal: '用手机号登录',
    scope: '登录表单与校验',
    context: '身份与访问控制',
    terms: [{term: '账号', definition: '主体'}],
    contracts: [
      {id: 'S-01', title: '换取会话', input: '手机号', output: 'token', error: '401', accept: '测试通过'},
      {id: 'S-02', title: '锁定', input: '5 次失败', output: '锁定', error: '423', accept: '测试覆盖'},
    ],
    steps: [{title: '写用例', spec: 'S-01'}, {title: '实现', spec: 'S-02'}],
  };
  const res = run(['plan', 'task-demo', '--input-json', JSON.stringify(model), '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.err);

  const spec = fs.readFileSync(path.join(dir, 'docs/specs/task-demo/spec.md'), 'utf8');
  assert.match(spec, /## S-01 换取会话/);
  const tasks = fs.readFileSync(path.join(dir, 'docs/specs/task-demo/tasks.md'), 'utf8');
  assert.match(tasks, /1\. 写用例（落地 S-01）/);
  assert.match(tasks, /2\. 实现（落地 S-02）/);
  const page = fs.readFileSync(path.join(dir, 'prototype/task-demo/progress.html'), 'utf8');
  assert.strictEqual((page.match(/class="step"/g) || []).length, 2);
});

test('plan：人改过的文档默认不覆盖', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  assert.strictEqual(run(['plan', 'task-demo', '--root', dir], dir).code, 0);

  const proposal = path.join(dir, 'docs/specs/task-demo/proposal.md');
  fs.appendFileSync(proposal, '\n- 人工补充：只允许内网访问。\n');

  const res = run(['plan', 'task-demo', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.err);
  assert.match(res.out, /保留 1 篇|保留 4 篇/);
  assert.match(fs.readFileSync(proposal, 'utf8'), /只允许内网访问/);
});

test('plan：建任务时自动生成方案页，默认待确认', () => {
  const dir = repo(['--preset', 'prototype']);
  const page = run(['page', 'task-demo', '--root', dir], dir);
  assert.strictEqual(page.code, 0, page.err);

  const plan = path.join(dir, 'prototype/task-demo/plan.html');
  assert.ok(fs.existsSync(plan), 'page 应生成 plan.html');
  const html = fs.readFileSync(plan, 'utf8');
  assert.match(html, /data-plan-status="待确认"/);
  for (const section of ['goal', 'approach', 'ui', 'flow', 'risks', 'accept', 'confirm']) {
    assert.match(html, new RegExp(`data-section="${section}"`), `方案页缺少 ${section}`);
  }
});

test('progress：方案未确认时拒绝写进度（先确认再开始）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);

  const res = run(['progress', 'task-demo', '--step', '1', '--pct', '40', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.err, /方案未确认/);
});

test('progress：确认后改步骤/状态，自动追加记录并同步总览', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  reviewAndConfirm(dir, 'task-demo');

  const res = run(
    ['progress', 'task-demo', '--step', '1', '--pct', '100', '--note', '第 1 步完成', '--root', dir],
    dir
  );
  assert.strictEqual(res.code, 0, res.err);

  const html = fs.readFileSync(path.join(dir, 'prototype/task-demo/progress.html'), 'utf8');
  assert.match(html, /data-pct="100">100%/);
  assert.match(html, /第 1 步完成/);
  assert.match(html, /data-total="33"/);
  assert.match(fs.readFileSync(path.join(dir, 'prototype/progress.html'), 'utf8'), /data-task="task-demo" data-total="33"/);
});

test('progress：步骤没到 100% 不能标「完成」', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  reviewAndConfirm(dir, 'task-demo');

  const res = run(['progress', 'task-demo', '--status', '完成', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.err, /还有步骤没到 100%/);
});

test('check：缺少方案页触发 P21', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  fs.rmSync(path.join(dir, 'prototype/task-demo/plan.html'));

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P21[\s\S]*缺少/);
});

test('progress：中文任务名可用', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', '登录页面', '--root', dir], dir);
  fillTask(dir, '登录页面');
  reviewAndConfirm(dir, '登录页面');
  const res = run(['progress', '登录页面', '--step', '2', '--pct', '50', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.err);
  assert.match(
    fs.readFileSync(path.join(dir, 'prototype/登录页面/progress.html'), 'utf8'),
    /data-pct="50">50%/
  );
});

test('preset prototype：新建页是骨架，check 要求把 DDD / SDD / TDD 与文档填完', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/README.md')));
  assert.ok(fs.existsSync(path.join(dir, 'prototype/progress.html')), 'init 应生成总览页');
  assert.ok(fs.existsSync(path.join(dir, 'scripts/prototype-check.js')));

  const page = run(['page', 'task-demo', '--root', dir], dir);
  assert.strictEqual(page.code, 0, page.err);
  for (const file of ['proposal.md', 'spec.md', 'design.md', 'tasks.md']) {
    assert.ok(fs.existsSync(path.join(dir, 'docs/specs/task-demo', file)), `page 应生成 ${file}`);
  }

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P13/);
  assert.match(res.out, /P14/);
  assert.match(res.out, /P17/);
});

test('preset prototype：填满 DDD / SDD / TDD 与文档后通过', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.out);
});

test('任务页：手填总进度被判失败', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  const file = path.join(dir, 'prototype/task-demo/progress.html');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('data-total-pct>—<', 'data-total-pct>50%<'));

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /手填总进度/);
});

test('任务页：进度记录末条与汇总不一致被判失败（P9）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  const file = path.join(dir, 'prototype/task-demo/progress.html');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('data-pct="0">0%</span>', 'data-pct="100">100%</span>'));

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P9/);
});

test('总览页：过期被判失败，--sync 之后通过（P11）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  reviewAndConfirm(dir, 'task-demo');

  const file = path.join(dir, 'prototype/task-demo/progress.html');
  const now = new Date().toISOString();
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8')
      .replace('data-pct="0">0%</span>', 'data-pct="100">100%</span>')
      .replace('</ul>\n  </section>\n</main>', `<li data-at="${now}" data-total="33">第 1 步完成，33%</li>\n    </ul>\n  </section>\n</main>`)
  );

  const stale = run(['check', '--root', dir], dir);
  assert.strictEqual(stale.code, 1);
  assert.match(stale.out, /P11/);

  const sync = execFileSync(process.execPath, [path.join(dir, 'scripts/prototype-check.js'), '--sync'], {cwd: dir, encoding: 'utf8'});
  assert.match(sync, /已同步/);

  const after = run(['check', '--root', dir], dir);
  assert.strictEqual(after.code, 0, after.out);
});

test('DDD：缺少不变量 / 统一语言不足两条会被判失败（P13）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  const file = path.join(dir, 'prototype/task-demo/progress.html');
  const html = fs.readFileSync(file, 'utf8')
    .replace(/<li>锁定账号不接受任何密码校验<\/li>/, '')
    .replace('<dt>会话</dt><dd>认证后的凭证集合</dd>', '');
  fs.writeFileSync(file, html);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P13[\s\S]*不变量/);
  assert.match(res.out, /P13[\s\S]*统一语言/);
});

test('SDD：契约缺列或不足两条会被判失败（P14）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  const file = path.join(dir, 'prototype/task-demo/progress.html');
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace('<td>密码错 401；锁定 423</td>', '<td>—</td>')
  );

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P14[\s\S]*错误语义/);
});

test('TDD：契约没有用例 / 完成时还有 red 会被判失败（P15）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  const file = path.join(dir, 'prototype/task-demo/progress.html');
  let html = fs.readFileSync(file, 'utf8')
    .replace('data-case="T-02"', 'data-case="T-02-unused"')
    .replace('data-spec="S-02" data-step="2" data-tdd="green"', 'data-spec="S-02" data-step="2" data-tdd="green"');
  // 删掉 T-02（原本挂在 S-02 上）
  html = html.replace(/<li class="case" data-case="T-02-unused"[\s\S]*?<\/li>/, '');
  fs.writeFileSync(file, html);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P15[\s\S]*S-02 没有测试用例/);
});

test('规划：步骤没有绑定契约会被判失败（P16）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  const file = path.join(dir, 'prototype/task-demo/progress.html');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('data-step="2" data-spec="S-02"', 'data-step="2"'));

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P16/);
});

test('文档：缺文件 / 步骤数不一致 / 契约集合不一致都被判失败（P17 / P18）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  // 1) 缺一份文档
  fs.rmSync(path.join(dir, 'docs/specs/task-demo/proposal.md'));
  const missing = run(['check', '--root', dir], dir);
  assert.strictEqual(missing.code, 1);
  assert.match(missing.out, /P17[\s\S]*proposal\.md/);

  // 2) 补回来，但 tasks.md 少一步、spec.md 少一条契约
  fs.writeFileSync(path.join(dir, 'docs/specs/task-demo/proposal.md'), '# 提案\n\n用户原话：先把登录做了\n');
  fs.writeFileSync(path.join(dir, 'docs/specs/task-demo/tasks.md'), '1. 写契约与失败用例（落地 S-01）\n');
  const mismatch = run(['check', '--root', dir], dir);
  assert.strictEqual(mismatch.code, 1);
  assert.match(mismatch.out, /P18[\s\S]*tasks\.md 有 1 步/);

  fs.writeFileSync(path.join(dir, 'docs/specs/task-demo/spec.md'), '## S-01 用手机号+密码换取会话\n');
  const specMismatch = run(['check', '--root', dir], dir);
  assert.strictEqual(specMismatch.code, 1);
  assert.match(specMismatch.out, /P18[\s\S]*spec\.md 缺少契约：S-02/);
});

test('设计文档：缺 DDD 小节会被判失败（P19）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  fs.writeFileSync(
    path.join(dir, 'docs/specs/task-demo/design.md'),
    '# 设计\n\n## 1. 限界上下文\n身份与访问控制\n\n## 2. 统一语言\n| 术语 | 定义 |\n|---|---|\n| 账号 | 主体 |\n'
  );

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P19[\s\S]*聚合/);
});

test('preset prototype：任务目录超过上限被判失败', () => {
  const dir = repo(['--preset', 'prototype']);
  const template = path.join(dir, 'prototype/_template/progress.html');
  for (let i = 1; i <= 12; i++) {
    const taskDir = path.join(dir, `prototype/task-${i}`);
    fs.mkdirSync(taskDir, {recursive: true});
    fs.copyFileSync(template, path.join(taskDir, 'progress.html'));
  }

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /超过上限 10/);
});

test('已有项目补开 preset：配置落盘、AGENTS.md 同源、page 立刻可用', () => {
  const dir = repo();
  const configFile = path.join(dir, 'harness-cli.json');
  assert.strictEqual(readJson(configFile).presets.prototype.enabled, false, '默认不开 preset');
  assert.ok(!fs.existsSync(path.join(dir, 'prototype')), '未开 preset 时不该有 prototype/');

  // 关键回归：配置已存在时 applyPlan 会 keep，早期版本因此把 enabled 留在 false
  const res = run(['init', '--preset', 'prototype', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.err);
  assert.strictEqual(readJson(configFile).presets.prototype.enabled, true, 'enabled 必须真正落盘');
  assert.ok(fs.existsSync(path.join(dir, 'prototype/README.md')));
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /5\.1/, 'AGENTS.md 应带上 preset 章节');

  const page = run(['page', 'later-task', '--root', dir], dir);
  assert.strictEqual(page.code, 0, page.err);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/later-task/progress.html')));

  // 新建页是骨架：先失败，填完 DDD / SDD / TDD 与文档后通过
  const skeleton = run(['check', '--root', dir], dir);
  assert.strictEqual(skeleton.code, 1);
  assert.match(skeleton.out, /P17/);

  fillTask(dir, 'later-task');
  const check = run(['check', '--root', dir], dir);
  assert.strictEqual(check.code, 0, check.out);
  assert.match(check.out, /A106\s+AGENTS\.md 与配置同源/);
});

test('init --preset --dry-run 不写配置、不建 prototype/', () => {
  const dir = repo();
  const res = run(['init', '--preset', 'prototype', '--dry-run', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.err);
  assert.strictEqual(readJson(path.join(dir, 'harness-cli.json')).presets.prototype.enabled, false);
  assert.ok(!fs.existsSync(path.join(dir, 'prototype')));
});

test('init --force 不覆盖状态文件（进度日志 / 功能清单）', () => {
  const dir = repo();
  const progress = path.join(dir, 'claude-progress.md');
  const features = path.join(dir, 'docs/feature_list.json');
  fs.writeFileSync(progress, '# 我手写的进度日志\n');
  const before = fs.readFileSync(features, 'utf8');
  const edited = JSON.parse(before);
  edited.features[0].name = '人工改过的 feature';
  fs.writeFileSync(features, JSON.stringify(edited, null, 2));

  const res = run(['init', '--force', '--root', dir], dir);
  assert.strictEqual(res.code, 0);
  assert.strictEqual(fs.readFileSync(progress, 'utf8'), '# 我手写的进度日志\n');
  assert.strictEqual(JSON.parse(fs.readFileSync(features, 'utf8')).features[0].name, '人工改过的 feature');

  // 显式 --force-state 才允许覆盖
  run(['init', '--force', '--force-state', '--root', dir], dir);
  assert.notStrictEqual(fs.readFileSync(progress, 'utf8'), '# 我手写的进度日志\n');
});

test('版本说明落在 _VERSIONS/v<ver>.md，且四段齐全', () => {
  const dir = repo();
  const note = path.join(dir, '_VERSIONS/v1.0.0.md');
  assert.ok(fs.existsSync(note), '缺少 _VERSIONS/v1.0.0.md');
  assert.ok(!fs.existsSync(path.join(dir, 'version-info')), '仍在生成 version-info/');

  const text = fs.readFileSync(note, 'utf8');
  for (const heading of ['## 1. 更新内容', '## 2. 实现方式', '## 3. 逻辑图', '## 4. 验证标准']) {
    assert.ok(text.includes(heading), `缺少 ${heading}`);
  }
  assert.match(text, /^1\.\s+\S+/m, '更新内容要有编号条目');

  assert.strictEqual(run(['check', '--root', dir], dir).code, 0);
});

test('版本说明缺板块或留着待补占位时失败', () => {
  const dir = repo();
  const note = path.join(dir, '_VERSIONS/v1.0.0.md');
  const text = fs.readFileSync(note, 'utf8');

  fs.writeFileSync(note, text.replace('## 3. 逻辑图', '## 三、随便'));
  let res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /缺少板块/);

  fs.writeFileSync(note, `${text}\n（待补）\n`);
  res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /待补占位/);
});

test('旧的 common-agent.json 仍可读取，check 会提示改名', () => {
  const dir = repo();
  const legacy = path.join(dir, 'common-agent.json');
  fs.renameSync(path.join(dir, 'harness-cli.json'), legacy);

  // 改名后 AGENTS.md 里仍是旧文件名，先重生成再校验（这正是 A106 想暴露的漂移）
  assert.strictEqual(run(['agents', '--root', dir], dir).code, 0);
  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, /旧文件名/);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /common-agent\.json/);
});

test('style 子命令转发给随包的 harness-style', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-style-'));
  const res = run(['style', 'doctor', '--json'], dir);
  // 没有 harness-style.json 时 harness-style 自己返回 2，说明参数确实转到了它
  assert.strictEqual(res.code, 2, res.out + (res.err || ''));
  assert.match(String(res.err || res.out), /harness-style/);
});

test('style 子命令在随包目录里能跑通（doctor --json）', () => {
  const styleDir = path.join(__dirname, '..', 'vendor', 'agent-style-harness');
  const res = run(['style', 'doctor', '--json'], styleDir);
  assert.ok([0, 1, 2].includes(res.code), `退出码异常: ${res.code}`);
  const payload = JSON.parse(res.out);
  assert.strictEqual(payload.schema, 'harness-style/v1');
});

test('上一版文件名 harness-pro.json 也被认作旧名', () => {
  const dir = repo();
  fs.renameSync(path.join(dir, 'harness-cli.json'), path.join(dir, 'harness-pro.json'));
  assert.strictEqual(run(['agents', '--root', dir], dir).code, 0);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, /旧文件名 harness-pro\.json/);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /harness-pro\.json/);
});

test('未知 preset 与未知命令返回 2', () => {
  const dir = repo();
  assert.strictEqual(run(['init', '--root', dir, '--preset', 'nope'], dir).code, 2);
  assert.strictEqual(run(['frobnicate', '--root', dir], dir).code, 2);
});

/** 起一个 plans 服务（随机端口），返回 {child, port}。 */
function startPlansServer(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'plans', '--serve', '--port', '0', '--root', dir], {cwd: dir});
    let out = '';
    const timer = setTimeout(() => reject(new Error('start timeout: ' + out)), 8000);
    const onData = (chunk) => {
      out += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({child, port: Number(match[1])});
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('server exited (' + code + '): ' + out));
    });
  });
}

function postJson(port, api, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {host: '127.0.0.1', port, path: api, method: 'POST', headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}},
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          try { resolve({status: res.statusCode, body: JSON.parse(text || '{}')}); }
          catch (err) { reject(new Error(text)); }
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function getText(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path: pathname}, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({status: res.statusCode, text}));
    }).on('error', reject);
  });
}
test('plans.html：init 生成，列出任务并内嵌文档内容', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.ok(fs.existsSync(path.join(dir, 'plans.html')), 'init should create plans.html');

  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  const text = fs.readFileSync(path.join(dir, 'plans.html'), 'utf8');
  assert.match(text, /"name":"task-demo"/);
  assert.match(text, /"page":"prototype\/task-demo\/progress\.html"/);
  assert.match(text, /"proposal":/);
  assert.match(text, /data-plans="1"/);
  assert.match(text, /data-progress/);
  assert.match(text, /progress-modal/);
  assert.match(text, /data-collapse/);
  assert.match(text, /harnessStartConversation/);
  assert.doesNotMatch(text, /\bconfirm\(|\balert\(/);
});

test('plans --serve：删除 / 重跑 / 保存 三个动作都落盘', async () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  run(['ui', 'task-demo', '--root', dir], dir);
  run(['plan', 'task-demo', '--confirm', '--by', '张三', '--root', dir], dir);

  const server = await startPlansServer(dir);
  try {
    const saved = await postJson(server.port, '/api/save', {
      task: 'task-demo',
      docs: {proposal: '# 人工改过的提案\n\n- 只允许内网访问\n'},
    });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.match(fs.readFileSync(path.join(dir, 'docs/specs/task-demo/proposal.md'), 'utf8'), /只允许内网访问/);
    assert.match(fs.readFileSync(path.join(dir, 'prototype/task-demo/plan.html'), 'utf8'), /data-plan-status="待确认"/);

    const rerun = await postJson(server.port, '/api/rerun', {task: 'task-demo'});
    assert.strictEqual(rerun.status, 200, JSON.stringify(rerun.body));
    assert.ok(fs.existsSync(path.join(dir, 'prototype/task-demo/progress.html')));

    const page = await getText(server.port, '/');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /任务总览/);
    assert.match(page.text, /data-progress/);
    assert.match(page.text, /"page":"prototype\/task-demo\/progress\.html"/);

    // 点击任务名加载的任务页必须能直接从服务取到
    const progressPage = await getText(server.port, '/prototype/task-demo/progress.html');
    assert.strictEqual(progressPage.status, 200);
    assert.match(progressPage.text, /data-task="task-demo"/);

    // 总览页每次请求都重新读取任务页：Agent 改了 progress.html，刷新总览就能看到
    const taskPageFile = path.join(dir, 'prototype/task-demo/progress.html');
    fs.writeFileSync(
      taskPageFile,
      fs.readFileSync(taskPageFile, 'utf8').replace('data-task-status="进行中"', 'data-task-status="待验收"')
    );
    const fresh = await getText(server.port, '/');
    assert.match(fresh.text, /待验收/);

    const ui = await getText(server.port, '/prototype/task-demo/ui/index.html');
    assert.strictEqual(ui.status, 200);
    assert.match(ui.text, /data-design-system="antd"/);

    const removed = await postJson(server.port, '/api/delete', {task: 'task-demo'});
    assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
    assert.ok(!fs.existsSync(path.join(dir, 'prototype/task-demo')));
    assert.ok(!fs.existsSync(path.join(dir, 'docs/specs/task-demo')));
  } finally {
    server.child.kill('SIGKILL');
  }
});

test('wiki：反推事实时排除 harness-cli 工具与它生成的文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-wiki-tool-'));
  // 项目自己的代码：Python
  fs.mkdirSync(path.join(dir, 'src'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'src', 'main.py'), 'print(1)\n');
  // 工作区里嵌入了一份 harness-cli 工具（JS 源码）
  const tool = path.join(dir, 'dsh-plugin-harness-cli', 'plugin');
  fs.mkdirSync(path.join(tool, 'bin'), {recursive: true});
  fs.writeFileSync(path.join(tool, 'package.json'), JSON.stringify({name: 'dsh-plugin-harness-cli', version: '0.1.0'}));
  fs.writeFileSync(path.join(tool, 'bin', 'dsh-plugin-harness-cli.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(dir, 'dsh-plugin-harness-cli', 'install.sh'), '#!/bin/sh\n');

  assert.strictEqual(run(['init', '--preset', 'prototype', '--root', dir], dir).code, 0);
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);

  const readme = fs.readFileSync(path.join(dir, 'docs/wiki/README.md'), 'utf8');
  assert.match(readme, /技术栈 \| Python/);
  assert.doesNotMatch(readme, /技术栈 \|[^\n]*JavaScript/);

  const features = fs.readFileSync(path.join(dir, 'docs/wiki/功能清单.md'), 'utf8');
  assert.doesNotMatch(features, /dsh-plugin-harness-cli/);
  assert.doesNotMatch(features, /业务域\/dsh-plugin-harness-cli/);

  // 生成物（claim.js / prototype-check.js）也不参与事实反推
  const stats = fs.readFileSync(path.join(dir, 'docs/wiki/README.md'), 'utf8');
  assert.doesNotMatch(stats, /测试文件 \| [1-9]/);
});
