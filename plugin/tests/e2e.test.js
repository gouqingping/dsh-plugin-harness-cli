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
const {syncTodoWrite} = require('../src/todo-bridge.js');

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

test('help process：查看完整任务流程（含别名）', () => {
  const dir = repo(['--preset', 'prototype']);
  const res = run(['help', 'process'], dir);
  assert.strictEqual(res.code, 0, res.err);
  for (const stage of [
    '选操作模式',
    '初始化骨架',
    '建任务',
    '复盘',
    '方案确认',
    '执行与推进度',
    '验收与门禁',
    '收尾与运维',
  ]) {
    assert.match(res.out, new RegExp(stage));
  }
  assert.strictEqual(run(['help', '流程'], dir).out, res.out);
  assert.match(run(['help'], dir).out, /help process/);
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
  // 13 篇主文档；业务域下钻页只在配置里声明了业务名时才生成
  assert.match(first.out, /已写入 13 篇/);

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

test('wiki：人工改受管区块默认增量合并；--keep 不动、--update 重写', () => {
  const dir = repo();
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);

  const file = path.join(dir, 'docs/wiki/术语表.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## 1. 体系与文件', '## 1. 体系与文件（人工改名）'));

  const merged = run(['wiki', '--root', dir], dir);
  assert.strictEqual(merged.code, 0, `${merged.out}${merged.err}`);
  assert.doesNotMatch(merged.out, /CONFLICT/);
  assert.match(fs.readFileSync(file, 'utf8'), /人工改名/);

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

test('wiki：既有文档没有受管区块时，默认补区块并原样保留正文', () => {
  const dir = repo();
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);
  const file = path.join(dir, 'docs/wiki/一页纸速览.md');
  fs.writeFileSync(file, '# 一页纸速览（人工版）\n\n人工写的第一段。\n\n- 人工要点一\n');

  const adopt = run(['wiki', '--root', dir], dir);
  assert.strictEqual(adopt.code, 0, `${adopt.out}${adopt.err}`);
  assert.match(adopt.out, /ADOPT/);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('<!-- harness-wiki:begin -->'), '应补上受管区块');
  assert.match(text, /^# 一页纸速览（人工版）/m);
  assert.match(text, /人工写的第一段/);
  assert.match(text, /人工要点一/);

  const check = run(['wiki', '--check', '--root', dir], dir);
  assert.strictEqual(check.code, 0, check.out);
  assert.match(check.out, /全部为最新/);

  // 接管后回到正常维护：再跑一次既不改原文、也不重复写
  const again = run(['wiki', '--root', dir], dir);
  assert.strictEqual(again.code, 0, again.out);
  assert.match(again.out, /已写入 0 篇/);
  assert.match(fs.readFileSync(file, 'utf8'), /人工写的第一段/);
});

test('wiki：全部文档都没有受管区块时，默认逐篇补区块并保留原文', () => {
  const dir = repo();
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);
  const wikiDir = path.join(dir, 'docs/wiki');
  const originals = new Map();
  for (const name of fs.readdirSync(wikiDir)) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(wikiDir, name);
    const stripped = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/harness-wiki:(begin|end)/.test(line))
      .join('\n');
    originals.set(name, stripped);
    fs.writeFileSync(file, stripped);
  }

  const res = run(['wiki', '--root', dir], dir);
  assert.strictEqual(res.code, 0, `${res.out}${res.err}`);
  assert.match(res.out, /已写入 13 篇/);
  assert.doesNotMatch(res.out, /冲突/);
  for (const [name, original] of originals) {
    const text = fs.readFileSync(path.join(wikiDir, name), 'utf8');
    assert.ok(text.includes('<!-- harness-wiki:begin -->'), `${name} 应补上受管区块`);
    // 原文的关键内容必须还在（区块外）
    const marker = original.trim().split('\n').find((line) => line.startsWith('## '));
    if (marker) assert.ok(text.includes(marker), `${name} 的原文应保留`);
  }
});

test('wiki：受管区块标记不完整时不硬写、不崩溃', () => {
  const dir = repo();
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);
  const file = path.join(dir, 'docs/wiki/术语表.md');
  const broken = '# 术语表\n\n<!-- harness-wiki:begin -->\n没有结束标记。\n';
  fs.writeFileSync(file, broken);

  const res = run(['wiki', '--update', '--root', dir], dir);
  assert.strictEqual(res.code, 1, `${res.out}${res.err}`);
  assert.doesNotMatch(res.err, /must be of type string/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), broken, '标记不完整的文件不能被改写');
});

test('wiki：生成物是业务白话，不带代码块、流程图与命令', () => {
  const dir = repo();
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);
  const wikiDir = path.join(dir, 'docs/wiki');
  const walk = (base) => {
    for (const entry of fs.readdirSync(base, {withFileTypes: true})) {
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const text = fs.readFileSync(full, 'utf8');
      assert.doesNotMatch(text, /```/, `${entry.name} 出现代码块`);
      assert.doesNotMatch(text, /mermaid/i, `${entry.name} 出现流程图语法`);
      assert.doesNotMatch(text, /\bnode\s+\S+\.js\b/, `${entry.name} 出现命令行`);
      assert.doesNotMatch(text, /`/, `${entry.name} 出现代码标记`);
    }
  };
  walk(wikiDir);
});

test('wiki：定位取 README 正文，不把标题当定位', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-wiki-pos-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'demo-shop', version: '1.0.0'}));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo Shop\n\n在线商城：下单、支付、退款。\n');
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);
  const overview = fs.readFileSync(path.join(dir, 'docs/wiki/一页纸速览.md'), 'utf8');
  assert.match(overview, /在线商城：下单、支付、退款/);
  assert.doesNotMatch(overview, /^\*\*demo-shop\*\*[\s\S]{0,40}\nDemo Shop$/m);
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

test('check：docs/wiki 过期或标记损坏时给 H109 警告', () => {
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

  // 重跑 wiki 刷新事实
  assert.strictEqual(run(['wiki', '--root', dir], dir).code, 0);

  // 人工改写段落：增量合并会保留，不再算冲突
  const file = path.join(dir, 'docs/wiki/术语表.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## 1. 体系与文件', '## 1. 人工改名'));
  const edited = run(['check', '--root', dir], dir);
  assert.match(edited.out, /H109\s+docs\/wiki 与事实一致/);
  assert.doesNotMatch(edited.out, /冲突/);

  // 受管区块标记坏了才是真冲突
  fs.writeFileSync(file, '# 术语表\n\n<!-- harness-wiki:begin -->\n没有结束标记。\n');
  const conflict = run(['check', '--root', dir], dir);
  assert.match(conflict.out, /H109[\s\S]*标记不完整/);
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

test('docs 改过之后确认失效：progress 照常写但提示，check 报 P22', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  reviewAndConfirm(dir, 'task-demo');

  // 先正常开工，让任务进入「已开始」状态
  assert.strictEqual(run(['progress', 'task-demo', '--step', '1', '--pct', '50', '--root', dir], dir).code, 0);

  const design = path.join(dir, 'docs/specs/task-demo/design.md');
  fs.appendFileSync(design, '\n- 人工补充：锁定账号 30 分钟。\n');

  const res = run(['progress', 'task-demo', '--step', '2', '--pct', '50', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.err);
  assert.match(res.out, /确认已失效/);

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

test('plan：创建任务时把 docs/specs 五份文档一次补全', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'task-demo', '--root', dir], dir).code, 0);

  const plan = run(['plan', 'task-demo', '--root', dir], dir);
  assert.strictEqual(plan.code, 0, plan.err);
  assert.match(plan.out, /规范文档：写入 5 篇/);

  for (const file of ['flow.md', 'proposal.md', 'spec.md', 'design.md', 'tasks.md']) {
    const text = fs.readFileSync(path.join(dir, 'docs/specs/task-demo', file), 'utf8');
    assert.doesNotMatch(text, /待填/, `${file} 不应再有占位`);
  }

  const page = fs.readFileSync(path.join(dir, 'prototype/task-demo/progress.html'), 'utf8');
  assert.match(page, /data-spec="S-01"/);
  assert.match(page, /data-case="T-01"/);
  assert.match(page, /模拟环境沙箱测试/);
  assert.doesNotMatch(page, /真机/);
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
  assert.match(res.out, /保留 1 篇|保留 5 篇/);
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
  assert.match(html, /data-flow-status="待确认"/);
  assert.match(html, /id="business-flow"/);
  assert.match(html, /data-flow-diagram/);
  assert.match(html, /class="flow-node"/);
  for (const section of ['business-flow', 'goal', 'approach', 'ui', 'flow', 'risks', 'accept', 'confirm']) {
    assert.match(html, new RegExp(`data-section="${section}"`), `方案页缺少 ${section}`);
  }
});

test('progress：方案未确认也能记录，只提示 check 仍会红', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);

  const res = run(['progress', 'task-demo', '--step', '1', '--pct', '40', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.err);
  assert.match(res.out, /方案未确认（check 的 P21 仍是红项）/);
  const html = fs.readFileSync(path.join(dir, 'prototype/task-demo/progress.html'), 'utf8');
  assert.match(html, /data-pct="40"/);
});

test('progress 页：每个任务都有步骤流程，当前步骤高亮由页面脚本生成', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'task-demo', '--root', dir], dir).code, 0);

  const html = fs.readFileSync(path.join(dir, 'prototype/task-demo/progress.html'), 'utf8');
  assert.match(html, /<section class="flow">/);
  assert.match(html, /<h2>步骤流程<\/h2>/);
  assert.match(html, /data-flow-summary/);
  assert.match(html, /data-flow-stage/);
  assert.match(html, /<ol class="flow-track" data-flow/);
  assert.match(html, /<script data-progress-flow>/);
  assert.match(html, /is-current/);
  assert.match(html, /flow-current/);
  // 流程从任务规划的步骤卡片生成，而不是另存一份
  assert.match(html, /querySelectorAll\('li\.step'\)/);
});

test('progress：老任务页缺步骤流程时自动补上', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'old-task', '--root', dir], dir).code, 0);
  const file = path.join(dir, 'prototype/old-task/progress.html');
  const legacy = fs
    .readFileSync(file, 'utf8')
    .replace(/<section class="flow">[\s\S]*?<\/section>/, '')
    .replace(/<script data-progress-flow>[\s\S]*?<\/script>/, '');
  assert.doesNotMatch(legacy, /data-flow/);
  fs.writeFileSync(file, legacy);

  const res = run(['progress', 'old-task', '--step', '1', '--pct', '50', '--root', dir], dir);
  assert.strictEqual(res.code, 0, res.err);
  assert.match(res.out, /已补「步骤流程」区块/);
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /data-flow/);
  assert.match(html, /data-progress-flow/);
  assert.match(html, /data-pct="50"/);
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
  assert.match(html, /data-step="1" data-pct="100"/);
  assert.match(html, /第 1 步完成/);
  assert.match(html, /data-total="33"/);
  assert.match(fs.readFileSync(path.join(dir, 'prototype/progress.html'), 'utf8'), /data-task="task-demo" data-total="33"/);
});

test('progress：总览同步脚本缺失时先补回，总览仍会更新', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  reviewAndConfirm(dir, 'task-demo');

  const script = path.join(dir, 'scripts/prototype-check.js');
  fs.rmSync(script);
  const before = fs.readFileSync(path.join(dir, 'prototype/progress.html'), 'utf8');

  const res = run(['progress', 'task-demo', '--step', '1', '--pct', '100', '--root', dir], dir);
  assert.strictEqual(res.code, 0, `${res.out}${res.err}`);
  assert.match(res.out, /总览同步脚本缺失，已按模板补回/);
  assert.ok(fs.existsSync(script), '应补回同步脚本');
  const after = fs.readFileSync(path.join(dir, 'prototype/progress.html'), 'utf8');
  assert.notStrictEqual(after, before, '总览页必须跟着更新');
  assert.match(after, /data-task="task-demo" data-total="33"/);
});

test('delete：默认只预演，--yes 才真删，并刷新总览', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);

  const preview = run(['delete', 'task-demo', '--root', dir], dir);
  assert.strictEqual(preview.code, 1);
  assert.match(preview.out, /将删除/);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/task-demo')), '预演不能删文件');

  const done = run(['delete', 'task-demo', '--yes', '--root', dir], dir);
  assert.strictEqual(done.code, 0, `${done.out}${done.err}`);
  assert.ok(!fs.existsSync(path.join(dir, 'prototype/task-demo')));
  assert.ok(!fs.existsSync(path.join(dir, 'docs/specs/task-demo')));
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'prototype/progress.html'), 'utf8'), /task-demo/);
});

test('delete：任务不存在时报错，不动其他目录', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'keep-me', '--root', dir], dir);

  const res = run(['delete', 'nope', '--yes', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.err, /不存在/);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/keep-me')));
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

test('DSH todo/write：completed / in_progress 自动落盘为 100% / 50%', async () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  reviewAndConfirm(dir, 'task-demo');

  const result = await syncTodoWrite({
    root: dir,
    todos: [
      {content: '写契约与失败用例', status: 'completed'},
      {content: '实现账号与会话', status: 'in_progress'},
      {content: '回归与文档', status: 'pending'},
    ],
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const html = fs.readFileSync(path.join(dir, 'prototype/task-demo/progress.html'), 'utf8');
  assert.match(html, /data-pct="100">100%/);
  assert.match(html, /data-pct="50">50%/);
  assert.match(html, /data-step="1" data-pct="100"/);
  assert.match(html, /data-step="2" data-pct="50"/);
  assert.match(html, /DSH todo/);

  const check = run(['check', '--root', dir], dir);
  assert.strictEqual(check.code, 0, check.out);
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

test('任务页：手改进度但没有 progress 的 data-step 记录被判失败（P25）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  reviewAndConfirm(dir, 'task-demo');
  assert.strictEqual(run(['progress', 'task-demo', '--step', '1', '--pct', '100', '--root', dir], dir).code, 0);

  const file = path.join(dir, 'prototype/task-demo/progress.html');
  const now = new Date().toISOString();
  const html = fs
    .readFileSync(file, 'utf8')
    .replace('data-pct="0">0%</span>', 'data-pct="50">50%</span>')
    .replace(
      '</ul>\n  </section>\n</main>',
      `<li data-at="${now}" data-total="50">手改第 2 步，但没有 progress 记录</li>\n    </ul>\n  </section>\n</main>`
    );
  fs.writeFileSync(file, html);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P25[\s\S]*第 2 步/);
});

test('任务页：进度记录早于方案确认被判失败（P26）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');
  reviewAndConfirm(dir, 'task-demo');

  const planFile = path.join(dir, 'prototype/task-demo/plan.html');
  const confirmedAt = /data-confirmed-at="([^"]*)"/.exec(fs.readFileSync(planFile, 'utf8'))[1];
  const before = new Date(Date.parse(confirmedAt) - 1000).toISOString();
  const file = path.join(dir, 'prototype/task-demo/progress.html');
  const html = fs
    .readFileSync(file, 'utf8')
    .replace('data-pct="0">0%</span>', 'data-pct="100">100%</span>')
    .replace(
      '</ul>\n  </section>\n</main>',
      `<li data-at="${before}" data-total="33" data-step="1" data-pct="100">确认前就写了进度</li>\n    </ul>\n  </section>\n</main>`
    );
  fs.writeFileSync(file, html);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P26/);
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
      .replace(
        '</ul>\n  </section>\n</main>',
        `<li data-at="${now}" data-total="33" data-step="1" data-pct="100">第 1 步完成，33%</li>\n    </ul>\n  </section>\n</main>`
      )
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

test('TDD：用例仍写「真机验证」被判失败（P15）', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'task-demo', '--root', dir], dir);
  fillTask(dir, 'task-demo');

  const file = path.join(dir, 'prototype/task-demo/progress.html');
  const html = fs.readFileSync(file, 'utf8').replace(
    /<li class="case" data-case="T-01"[\s\S]*?<\/li>/,
    '<li class="case" data-case="T-01" data-spec="S-01" data-step="1" data-tdd="green">真机验证：按人工步骤操作</li>'
  );
  fs.writeFileSync(file, html);

  const res = run(['check', '--root', dir], dir);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /P15[\s\S]*模拟环境沙箱测试/);
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
function startPlansServer(dir, port = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'plans', 'serve', String(port), '--root', dir], {cwd: dir});
    let out = '';
    const timer = setTimeout(() => reject(new Error('start timeout: ' + out)), 8000);
    const onData = (chunk) => {
      out += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({child, port: Number(match[1]), out: () => out});
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

function postJson(port, api, payload, options = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Origin: `http://127.0.0.1:${port}`,
      ...(options.headers || {}),
    };
    const req = http.request(
      {host: '127.0.0.1', port, path: api, method: 'POST', headers},
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

function getText(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path: pathname, headers}, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({status: res.statusCode, text, headers: res.headers}));
    }).on('error', reject);
  });
}

/** 读指定数量的 SSE data 事件；首条到达后执行 onFirst，用于验证后续推送。 */
function getSseEvents(port, pathname, count, onFirst) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('SSE timeout'));
    }, 6000);
    timer.unref();
    const req = http.get({host: '127.0.0.1', port, path: pathname}, (res) => {
      let buffer = '';
      const events = [];
      let fired = false;
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          const match = /(?:^|\n)data: ([^\n]*)(?:\n|$)/.exec(block);
          if (!match) continue;
          events.push(JSON.parse(match[1]));
          if (!fired && events.length === 1) {
            fired = true;
            if (onFirst) onFirst();
          }
          if (events.length >= count) {
            clearTimeout(timer);
            req.destroy();
            resolve({status: res.statusCode, type: String(res.headers['content-type']), events});
            return;
          }
        }
      });
    });
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
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
  assert.doesNotMatch(text, /<th>UI<\/th>/);
  assert.doesNotMatch(text, /<th>数模<\/th>/);
  assert.match(text, /data-ui="' \+ index \+ '">UI<\/button>/);
  assert.match(text, /data-db="' \+ index \+ '">数模<\/button>/);
  assert.match(text, /modal-refresh/);
  assert.match(text, /harnessStartConversation/);
  assert.match(text, /EventSource/);
  assert.match(text, /live-state/);
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

    const feed = await getText(server.port, '/api/tasks');
    assert.strictEqual(feed.status, 200);
    assert.strictEqual(JSON.parse(feed.text).tasks[0].name, 'task-demo');

    // 首帧之后改任务页，服务应通过 SSE 主动推送变化，而不是等客户端刷新。
    const taskPageFile = path.join(dir, 'prototype/task-demo/progress.html');
    const pushed = await getSseEvents(server.port, '/api/events', 2, () => {
      const text = fs.readFileSync(taskPageFile, 'utf8');
      fs.writeFileSync(taskPageFile, text.replace(/data-task-status="[^"]*"/, 'data-task-status="待验收"'));
    });
    assert.strictEqual(pushed.status, 200);
    assert.match(pushed.type, /^text\/event-stream/);
    assert.strictEqual(pushed.events[0].tasks[0].name, 'task-demo');
    assert.strictEqual(pushed.events[1].tasks[0].status, '待验收');

    // 点击任务名加载的任务页必须能直接从服务取到
    const progressPage = await getText(server.port, '/prototype/task-demo/progress.html');
    assert.strictEqual(progressPage.status, 200);
    assert.match(progressPage.text, /data-task="task-demo"/);
    assert.match(progressPage.headers.etag, /^"[0-9a-f]+-[0-9a-f]+"$/);
    assert.ok(progressPage.headers['last-modified'], '任务页应返回 Last-Modified 供自刷新判断');

    // 总览页每次请求都重新读取任务页：Agent 改了 progress.html，刷新总览就能看到
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

test('plans --serve：拒绝 DNS 重绑定和跨站写入', async () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'task-demo', '--root', dir], dir).code, 0);

  const server = await startPlansServer(dir);
  try {
    const rebound = await getText(server.port, '/api/tasks', {Host: 'evil.example'});
    assert.strictEqual(rebound.status, 403);

    const crossOrigin = await postJson(
      server.port,
      '/api/delete',
      {task: 'task-demo'},
      {headers: {Origin: 'https://evil.example'}}
    );
    assert.strictEqual(crossOrigin.status, 403);
    assert.ok(fs.existsSync(path.join(dir, 'prototype/task-demo/progress.html')), '跨站请求删除了任务');
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

  const panorama = fs.readFileSync(path.join(dir, 'docs/wiki/系统全景与部署形态.md'), 'utf8');
  assert.match(panorama, /技术栈 \| Python/);
  assert.doesNotMatch(panorama, /技术栈 \|[^\n]*JavaScript/);

  const features = fs.readFileSync(path.join(dir, 'docs/wiki/功能清单.md'), 'utf8');
  assert.doesNotMatch(features, /dsh-plugin-harness-cli/);
  assert.doesNotMatch(features, /业务域\/dsh-plugin-harness-cli/);
});

test('sql：首次生成骨架，补全 schema 后生成 Mermaid 与离线数模图', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'db-task', '--root', dir], dir);

  const first = run(['sql', 'db-task', '--root', dir], dir);
  assert.strictEqual(first.code, 1, `${first.out}${first.err}`);
  assert.match(first.out, /DB001/);
  assert.ok(fs.existsSync(path.join(dir, 'docs/specs/db-task/schema.sql')));
  assert.ok(fs.existsSync(path.join(dir, 'docs/specs/db-task/database.md')));
  const emptyPage = fs.readFileSync(path.join(dir, 'prototype/db-task/db/index.html'), 'utf8');
  assert.match(emptyPage, /还没有表/);

  fs.writeFileSync(
    path.join(dir, 'docs/specs/db-task/schema.sql'),
    [
      'CREATE TABLE user_account (',
      '  user_account_id bigint PRIMARY KEY,',
      '  email varchar(255) NOT NULL UNIQUE,',
      '  created_at timestamptz NOT NULL,',
      '  updated_at timestamptz NOT NULL',
      ');',
      'CREATE TABLE login_attempt (',
      '  login_attempt_id bigint PRIMARY KEY,',
      '  user_account_id bigint NOT NULL REFERENCES user_account (user_account_id),',
      '  created_at timestamptz NOT NULL,',
      '  updated_at timestamptz NOT NULL',
      ');',
      'CREATE INDEX idx_login_attempt_user_account_id ON login_attempt (user_account_id);',
      '',
    ].join('\n')
  );

  const second = run(['sql', 'db-task', '--root', dir], dir);
  assert.strictEqual(second.code, 0, `${second.out}${second.err}`);
  assert.match(second.out, /2 张表 \/ 1 条关系/);
  const mermaid = fs.readFileSync(path.join(dir, 'docs/specs/db-task/er.mmd'), 'utf8');
  assert.match(mermaid, /erDiagram/);
  assert.match(mermaid, /user_account \|\|--o\{ login_attempt : "user_account_id"/);
  const page = fs.readFileSync(path.join(dir, 'prototype/db-task/db/index.html'), 'utf8');
  assert.match(page, /data-table="user_account"/);
  assert.match(page, /data-table="login_attempt"/);
  assert.match(page, /关系说明/);
  assert.match(page, /字段说明/);
  assert.doesNotMatch(page, /\{\{/);

  const databaseDoc = fs.readFileSync(path.join(dir, 'docs/specs/db-task/database.md'), 'utf8');
  assert.match(databaseDoc, /harness-db:begin/);
  assert.match(databaseDoc, /关系说明/);
  assert.match(databaseDoc, /字段说明/);
  assert.strictEqual((databaseDoc.match(/harness-db:begin/g) || []).length, 1);

  const overview = fs.readFileSync(path.join(dir, 'prototype/db.html'), 'utf8');
  assert.match(overview, /schema\.sql 源码/);
  assert.match(overview, /CREATE TABLE user_account/);
  assert.match(overview, /关系说明/);
});

test('sql：schema 有命名 / 主键 / 浮点金额问题时退出 1 并把问题写进数模图', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'bad-db', '--root', dir], dir);
  fs.writeFileSync(
    path.join(dir, 'docs/specs/bad-db/schema.sql'),
    [
      'CREATE TABLE BadTable (',
      '  id int,',
      '  amount float',
      ');',
      '',
    ].join('\n')
  );

  const res = run(['sql', 'bad-db', '--root', dir], dir);
  assert.strictEqual(res.code, 1, `${res.out}${res.err}`);
  assert.match(res.out, /DB002/);
  assert.match(res.out, /DB004/);
  assert.match(res.out, /DB010/);
  const page = fs.readFileSync(path.join(dir, 'prototype/bad-db/db/index.html'), 'utf8');
  assert.match(page, /DB004/);
  assert.match(page, /DB010/);
});

test('delete：支持一次删除多个任务，并清理重跑备份', () => {
  const dir = repo(['--preset', 'prototype']);
  for (const name of ['task-a', 'task-b', 'keep-me']) {
    run(['page', name, '--root', dir], dir);
  }
  const backup = path.join(dir, '.harness', '.rerun-task-a-ui');
  fs.mkdirSync(backup, {recursive: true});
  fs.writeFileSync(path.join(backup, 'index.html'), '<html></html>');

  const preview = run(['delete', 'task-a', 'task-b', '--root', dir], dir);
  assert.strictEqual(preview.code, 1);
  assert.match(preview.out, /task-a、task-b/);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/task-a')), '预演不能删文件');

  const done = run(['delete', 'task-a', 'task-b', '--yes', '--root', dir], dir);
  assert.strictEqual(done.code, 0, `${done.out}${done.err}`);
  assert.ok(!fs.existsSync(path.join(dir, 'prototype/task-a')));
  assert.ok(!fs.existsSync(path.join(dir, 'docs/specs/task-a')));
  assert.ok(!fs.existsSync(path.join(dir, 'prototype/task-b')));
  assert.ok(fs.existsSync(path.join(dir, 'prototype/keep-me')), '未选中的任务必须保留');
  assert.ok(!fs.existsSync(backup), '重跑备份属于任务相关数据，应一并清理');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'prototype/progress.html'), 'utf8'), /task-a/);
});

test('sql：生成整体数模图，并在 plans.html 暴露单任务 / 整体预览入口', () => {
  const dir = repo(['--preset', 'prototype']);
  for (const name of ['task-a', 'task-b']) {
    assert.strictEqual(run(['page', name, '--root', dir], dir).code, 0);
  }
  fs.writeFileSync(
    path.join(dir, 'docs/specs/task-a/schema.sql'),
    [
      'CREATE TABLE user_account (',
      '  user_account_id bigint PRIMARY KEY, -- 用户主键',
      '  email varchar(255) NOT NULL, -- 登录邮箱',
      '  created_at timestamptz NOT NULL,',
      '  updated_at timestamptz NOT NULL',
      ');',
      "COMMENT ON TABLE user_account IS '用户账号';",
      "COMMENT ON COLUMN user_account.created_at IS '创建时间';",
      "COMMENT ON COLUMN user_account.updated_at IS '更新时间';",
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(dir, 'docs/specs/task-b/schema.sql'),
    [
      'CREATE TABLE login_attempt (',
      '  login_attempt_id bigint PRIMARY KEY,',
      '  user_account_id bigint NOT NULL REFERENCES user_account (user_account_id), -- 所属账号',
      '  created_at timestamptz NOT NULL,',
      '  updated_at timestamptz NOT NULL',
      ');',
      "COMMENT ON TABLE login_attempt IS '登录尝试';",
      "COMMENT ON COLUMN login_attempt.login_attempt_id IS '尝试主键';",
      "COMMENT ON COLUMN login_attempt.created_at IS '创建时间';",
      "COMMENT ON COLUMN login_attempt.updated_at IS '更新时间';",
      'CREATE INDEX idx_login_attempt_user ON login_attempt (user_account_id);',
      '',
    ].join('\n')
  );
  assert.strictEqual(run(['sql', 'task-a', '--root', dir], dir).code, 0);
  assert.strictEqual(run(['sql', 'task-b', '--root', dir], dir).code, 0);

  const overviewFile = path.join(dir, 'prototype/db.html');
  assert.ok(fs.existsSync(overviewFile), '应生成整体数模图');
  const overview = fs.readFileSync(overviewFile, 'utf8');
  assert.match(overview, /data-table="user_account"/);
  assert.match(overview, /data-table="login_attempt"/);
  assert.match(overview, /所属账号/, '整体图也应带字段说明');
  assert.match(overview, /window\.__harnessDb/);
  assert.match(overview, /"positions":\{\}/);

  const plans = fs.readFileSync(path.join(dir, 'plans.html'), 'utf8');
  assert.match(plans, /"hasDb":true/);
  assert.match(plans, /"dbPage":"prototype\/db\.html"/);
  assert.match(plans, /db-overview/);
  assert.match(plans, /data-db/);
});

test('plans --serve：/api/db-layout 保存数模图布局，整体图与单任务图可直接预览', async () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'db-task', '--root', dir], dir).code, 0);
  fs.writeFileSync(
    path.join(dir, 'docs/specs/db-task/schema.sql'),
    [
      'CREATE TABLE user_account (',
      '  user_account_id bigint PRIMARY KEY, -- 用户主键',
      '  email varchar(255) NOT NULL, -- 登录邮箱',
      '  created_at timestamptz NOT NULL,',
      '  updated_at timestamptz NOT NULL',
      ');',
      "COMMENT ON TABLE user_account IS '用户账号';",
      "COMMENT ON COLUMN user_account.created_at IS '创建时间';",
      "COMMENT ON COLUMN user_account.updated_at IS '更新时间';",
      '',
    ].join('\n')
  );
  assert.strictEqual(run(['sql', 'db-task', '--root', dir], dir).code, 0);

  const server = await startPlansServer(dir);
  try {
    const saved = await postJson(server.port, '/api/db-layout', {
      version: 1,
      positions: {user_account: {x: 42, y: 24}},
      updatedAt: new Date().toISOString(),
    });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    const layoutFile = path.join(dir, 'prototype/db-layout.json');
    assert.ok(fs.existsSync(layoutFile));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(layoutFile, 'utf8')).positions.user_account, {x: 42, y: 24});

    const loaded = await getText(server.port, '/api/db-layout');
    assert.strictEqual(loaded.status, 200);
    assert.deepStrictEqual(JSON.parse(loaded.text).positions.user_account, {x: 42, y: 24});

    const overview = await getText(server.port, '/prototype/db.html');
    assert.strictEqual(overview.status, 200);
    assert.match(overview.text, /window\.__HARNESS_DB__/);
    assert.match(overview.text, /data-table="user_account"/);

    const taskDb = await getText(server.port, '/prototype/db-task/db/index.html');
    assert.strictEqual(taskDb.status, 200);
    assert.match(taskDb.text, /关系说明|字段说明/);
  } finally {
    server.child.kill('SIGKILL');
  }
});

test('plans --serve：/api/save-db 保存 database.md / schema.sql 并刷新数模图与总览', async () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'db-edit', '--root', dir], dir).code, 0);
  assert.strictEqual(run(['sql', 'db-edit', '--root', dir], dir).code, 1, '空 schema 应先失败并生成骨架');

  const server = await startPlansServer(dir);
  try {
    const saved = await postJson(server.port, '/api/save-db', {
      task: 'db-edit',
      docs: {
        database: '# 数据模型\n\n| 表 | 说明 |\n|---|---|\n| user_account | 用户账号 |\n',
        schema: [
          'CREATE TABLE user_account (',
          '  user_account_id bigint PRIMARY KEY, -- 用户主键',
          '  email varchar(255) NOT NULL, -- 登录邮箱',
          '  created_at timestamptz NOT NULL,',
          '  updated_at timestamptz NOT NULL',
          ');',
          "COMMENT ON TABLE user_account IS '用户账号';",
          "COMMENT ON COLUMN user_account.created_at IS '创建时间';",
          "COMMENT ON COLUMN user_account.updated_at IS '更新时间';",
          '',
        ].join('\n'),
      },
    });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.strictEqual(saved.body.sql.status, 0, saved.body.sql.out);
    assert.deepStrictEqual(saved.body.written.sort(), ['database.md', 'schema.sql']);
    assert.match(fs.readFileSync(path.join(dir, 'docs/specs/db-edit/schema.sql'), 'utf8'), /email varchar/);
    const dbPage = fs.readFileSync(path.join(dir, 'prototype/db-edit/db/index.html'), 'utf8');
    assert.match(dbPage, /data-table="user_account"/);
    assert.match(dbPage, /字段说明/);
    assert.match(dbPage, /登录邮箱/);
    assert.match(fs.readFileSync(path.join(dir, 'plans.html'), 'utf8'), /登录邮箱/);
    assert.ok(fs.existsSync(path.join(dir, 'prototype/db.html')));
  } finally {
    server.child.kill('SIGKILL');
  }
});

test('ui / sql：追加 progress 记录并更新 task_queue；progress 同步队列，delete 清理条目', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'queue-task', '--root', dir], dir).code, 0);
  assert.strictEqual(run(['ui', 'queue-task', '--root', dir], dir).code, 0);
  fs.writeFileSync(
    path.join(dir, 'docs/specs/queue-task/schema.sql'),
    [
      'CREATE TABLE user_account (',
      '  user_account_id bigint PRIMARY KEY, -- 用户主键',
      '  email varchar(255) NOT NULL, -- 登录邮箱',
      '  created_at timestamptz NOT NULL,',
      '  updated_at timestamptz NOT NULL',
      ');',
      "COMMENT ON TABLE user_account IS '用户账号';",
      "COMMENT ON COLUMN user_account.created_at IS '创建时间';",
      "COMMENT ON COLUMN user_account.updated_at IS '更新时间';",
      '',
    ].join('\n')
  );
  assert.strictEqual(run(['sql', 'queue-task', '--root', dir], dir).code, 0);

  const page = fs.readFileSync(path.join(dir, 'prototype/queue-task/progress.html'), 'utf8');
  assert.match(page, /UI 设计稿已生成/);
  assert.match(page, /数据库设计已生成/);

  const queueFile = path.join(dir, 'task_queue.json');
  const queue = readJson(queueFile);
  assert.strictEqual(queue.items.length, 1);
  const item = queue.items[0];
  assert.strictEqual(item.task, 'queue-task');
  assert.strictEqual(item.status, '进行中');
  assert.strictEqual(item.progress, 0);
  assert.ok(item.artifacts.includes('prototype/queue-task/ui/index.html'));
  assert.ok(item.artifacts.includes('docs/specs/queue-task/schema.sql'));
  assert.ok(item.artifacts.includes('prototype/db.html'));
  assert.ok(item.updatedAt);

  // progress 只更新已有队列条目：状态 / 进度跟着任务页走
  assert.strictEqual(run(['progress', 'queue-task', '--step', '1', '--pct', '100', '--root', dir], dir).code, 0);
  const after = readJson(queueFile);
  assert.strictEqual(after.items[0].progress, 33);
  assert.strictEqual(after.items[0].status, '进行中');

  // 删除任务时队列条目一并清理
  assert.strictEqual(run(['delete', 'queue-task', '--yes', '--root', dir], dir).code, 0);
  assert.deepStrictEqual(readJson(queueFile).items, []);
});

test('HTML 骨架屏：plans / progress / plan / ui / db 都先显示 skeleton', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'skeleton-task', '--root', dir], dir).code, 0);
  fs.writeFileSync(
    path.join(dir, 'docs/specs/skeleton-task/schema.sql'),
    'CREATE TABLE skeleton_entity (skeleton_entity_id bigint PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);\n'
  );
  assert.strictEqual(run(['sql', 'skeleton-task', '--root', dir], dir).code, 0);
  assert.strictEqual(run(['ui', 'skeleton-task', '--root', dir], dir).code, 0);

  for (const rel of [
    'plans.html',
    'prototype/progress.html',
    'prototype/skeleton-task/progress.html',
    'prototype/skeleton-task/plan.html',
    'prototype/skeleton-task/ui/index.html',
    'prototype/skeleton-task/db/index.html',
    'prototype/db.html',
  ]) {
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    assert.match(text, /id="hcli-skeleton"/, `${rel} 缺少骨架屏`);
    assert.match(text, /hcli-sk/, `${rel} 缺少骨架样式`);
  }
  const plans = fs.readFileSync(path.join(dir, 'plans.html'), 'utf8');
  assert.match(plans, /preview-skeleton/);
  assert.match(plans, /progress-skeleton/);
});

test('plan --confirm：任务模式 auto 时自动确认，不需要 --by；手动模式仍要求 --by', () => {
  const autoDir = repo(['--preset', 'prototype']);
  run(['page', 'auto-confirm-task', '--root', autoDir], autoDir);
  fillTask(autoDir, 'auto-confirm-task');
  fs.writeFileSync(
    path.join(autoDir, 'prototype/auto-confirm-task/.harness-mode.json'),
    `${JSON.stringify({mode: 'auto'})}\n`
  );
  assert.strictEqual(run(['review', 'auto-confirm-task', '--root', autoDir], autoDir).code, 0);
  const auto = run(['plan', 'auto-confirm-task', '--confirm', '--root', autoDir], autoDir);
  assert.strictEqual(auto.code, 0, `${auto.out}${auto.err}`);
  const plan = fs.readFileSync(path.join(autoDir, 'prototype/auto-confirm-task/plan.html'), 'utf8');
  assert.match(plan, /data-plan-status="已确认"/);
  assert.match(plan, /data-flow-status="已确认"/);
  assert.match(plan, /data-confirmed-by="自动 loop"/);
  assert.match(
    fs.readFileSync(path.join(autoDir, 'docs/specs/auto-confirm-task/review.md'), 'utf8'),
    /确认人：自动 loop/
  );

  const manualDir = repo(['--preset', 'prototype']);
  run(['page', 'manual-confirm-task', '--root', manualDir], manualDir);
  fillTask(manualDir, 'manual-confirm-task');
  assert.strictEqual(run(['review', 'manual-confirm-task', '--root', manualDir], manualDir).code, 0);
  const manual = run(['plan', 'manual-confirm-task', '--confirm', '--root', manualDir], manualDir);
  assert.strictEqual(manual.code, 2);
  assert.match(manual.err, /需要 --by/);
});

test('delete：删除后同步 db.html / db-layout / plans / progress / wiki', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'task-a', '--root', dir], dir).code, 0);
  assert.strictEqual(run(['page', 'task-b', '--root', dir], dir).code, 0);
  fs.writeFileSync(
    path.join(dir, 'docs/specs/task-a/schema.sql'),
    'CREATE TABLE table_a (id bigint PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);\n' +
      "COMMENT ON TABLE table_a IS 'A 表';\n"
  );
  fs.writeFileSync(
    path.join(dir, 'docs/specs/task-b/schema.sql'),
    'CREATE TABLE table_b (id bigint PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);\n' +
      "COMMENT ON TABLE table_b IS 'B 表';\n"
  );
  assert.strictEqual(run(['sql', 'task-a', '--root', dir], dir).code, 0);
  assert.strictEqual(run(['sql', 'task-b', '--root', dir], dir).code, 0);
  fs.writeFileSync(
    path.join(dir, 'prototype/db-layout.json'),
    `${JSON.stringify({version: 1, positions: {table_a: {x: 10, y: 20}, table_b: {x: 30, y: 40}}}, null, 2)}\n`
  );

  const before = fs.readFileSync(path.join(dir, 'prototype/db.html'), 'utf8');
  assert.match(before, /table_a/);
  assert.match(before, /table_b/);

  const removed = run(['delete', 'task-a', '--yes', '--root', dir], dir);
  assert.strictEqual(removed.code, 0, `${removed.out}${removed.err}`);
  assert.match(removed.out, /docs\/wiki/);

  const db = fs.readFileSync(path.join(dir, 'prototype/db.html'), 'utf8');
  assert.doesNotMatch(db, /table_a/);
  assert.match(db, /table_b/);

  const layout = readJson(path.join(dir, 'prototype/db-layout.json'));
  assert.ok(!('table_a' in layout.positions), '已删除表的布局坐标应清理');
  assert.ok('table_b' in layout.positions);

  const plans = fs.readFileSync(path.join(dir, 'plans.html'), 'utf8');
  assert.doesNotMatch(plans, /"name":"task-a"/);
  assert.match(plans, /"name":"task-b"/);

  const progress = fs.readFileSync(path.join(dir, 'prototype/progress.html'), 'utf8');
  assert.doesNotMatch(progress, /data-task="task-a"/);
  assert.match(progress, /data-task="task-b"/);

  assert.ok(fs.existsSync(path.join(dir, 'docs/wiki/README.md')), '删除后应同步 docs/wiki');
});


test('业务流程图：page 生成 flow.md 与 plan 流程图，确认后标记已确认', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'flow-task', '--root', dir], dir).code, 0);
  const flow = fs.readFileSync(path.join(dir, 'docs/specs/flow-task/flow.md'), 'utf8');
  assert.match(flow, /业务流程图/);
  assert.match(flow, /```mermaid/);
  assert.match(flow, /flowchart TD/);

  const planFile = path.join(dir, 'prototype/flow-task/plan.html');
  const before = fs.readFileSync(planFile, 'utf8');
  assert.match(before, /0. 业务流程图/);
  assert.match(before, /data-flow-status="待确认"/);
  assert.match(before, /data-flow-diagram/);

  fillTask(dir, 'flow-task');
  reviewAndConfirm(dir, 'flow-task');
  const after = fs.readFileSync(planFile, 'utf8');
  assert.match(after, /data-flow-status="已确认"/);
  assert.match(after, /data-flow-status-label>已确认</);
});

test('progress 方案预览弹窗；plan 流程图源文件弹窗预览', () => {
  const dir = repo(['--preset', 'prototype']);
  run(['page', 'preview-task', '--root', dir], dir);

  const progress = fs.readFileSync(path.join(dir, 'prototype/preview-task/progress.html'), 'utf8');
  assert.match(progress, /id="plan-preview"/);
  assert.match(progress, /id="plan-modal"/);
  assert.match(progress, /id="plan-frame"/);
  assert.match(progress, /方案预览/);
  assert.match(progress, /frame\.src = 'plan\.html'/);

  const plan = fs.readFileSync(path.join(dir, 'prototype/preview-task/plan.html'), 'utf8');
  assert.match(plan, /data-flow-preview/);
  assert.match(plan, /id="flow-doc-modal"/);
  assert.match(plan, /id="flow-doc-body"/);
  assert.match(plan, /docs\/specs\/preview-task\/flow\.md/);
  assert.match(plan, /点击预览/);
});

test('ux：自定义需求生成 HTML 报告、结构化数据与缺口清单', () => {
  const dir = repo();
  const res = run(
    ['ux', '--user-words', '做一个审批流，管理员可以批量审批。体验要快，什么算做成：批量审批成功。', '--root', dir],
    dir
  );
  assert.strictEqual(res.code, 0, `${res.out}${res.err}`);
  assert.match(res.out, /prototype\/ux\.html/);

  const html = fs.readFileSync(path.join(dir, 'prototype/ux.html'), 'utf8');
  assert.match(html, /UX 与需求分析报告/);
  assert.match(html, /批量审批/);
  assert.doesNotMatch(html, /\{\{/);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/ux.json')));
  assert.ok(fs.existsSync(path.join(dir, 'prototype/.ux-gaps.json')));
});

test('ux：任务分析列出阻断缺口，--apply 写回 design.md', () => {
  const dir = repo();
  assert.strictEqual(run(['page', '登录页面', '--root', dir], dir).code, 0);

  const res = run(['ux', '登录页面', '--root', dir], dir);
  assert.strictEqual(res.code, 0, `${res.out}${res.err}`);
  assert.match(res.out, /UX 分析仍需补全/);

  const apply = run(['ux', '--apply', '登录页面', '--root', dir], dir);
  assert.strictEqual(apply.code, 0, `${apply.out}${apply.err}`);
  const design = fs.readFileSync(path.join(dir, 'docs/specs/登录页面/design.md'), 'utf8');
  assert.match(design, /<!-- ux-report:begin -->/);
  assert.match(design, /UX 复核/);
  assert.ok(fs.existsSync(path.join(dir, 'prototype/ux.html')), '应有全量报告');
  assert.ok(fs.existsSync(path.join(dir, 'prototype/登录页面/ux/index.html')), '应有单任务报告');

  // 再跑一次 --apply 不重复写
  const again = run(['ux', '--apply', '登录页面', '--root', dir], dir);
  assert.strictEqual(again.code, 0, again.out);
  assert.match(again.out, /未变化 1 个/);
});

test('ux：整体报告覆盖全部任务，项目需求持久化到 docs/ux/requirements.md', () => {
  const dir = repo();
  assert.strictEqual(run(['page', '任务甲', '--root', dir], dir).code, 0);
  assert.strictEqual(run(['page', '任务乙', '--root', dir], dir).code, 0);

  const res = run(
    ['ux', '任务甲', '--user-words', '做一个审批流，管理员可以批量审批。什么算做成：批量审批成功。', '--root', dir],
    dir
  );
  assert.strictEqual(res.code, 0, `${res.out}${res.err}`);
  assert.match(res.out, /整体报告/);
  assert.match(res.out, /全部 2 个任务/);
  assert.ok(fs.existsSync(path.join(dir, 'docs/ux/requirements.md')), '项目需求应落盘');

  const html = fs.readFileSync(path.join(dir, 'prototype/ux.html'), 'utf8');
  assert.match(html, /任务甲/);
  assert.match(html, /任务乙/, '只选一个任务时整体报告仍要覆盖全部任务');
  assert.match(html, /批量审批/);

  // 第二次不再传需求，项目需求仍从 docs/ux/requirements.md 读取
  assert.strictEqual(run(['ux', '--root', dir], dir).code, 0);
  const again = fs.readFileSync(path.join(dir, 'prototype/ux.html'), 'utf8');
  assert.match(again, /批量审批/);
  assert.match(again, /项目需求 2 条/);
});

test('ux --resolve：逐条关闭后从待确认清单移除，重跑仍保持关闭', () => {
  const dir = repo();
  assert.strictEqual(run(['page', '登录页面', '--root', dir], dir).code, 0);
  assert.strictEqual(run(['ux', '登录页面', '--root', dir], dir).code, 0);

  const gapsFile = path.join(dir, 'prototype/.ux-gaps.json');
  const before = readJson(gapsFile);
  const target = before.gaps.find((gap) => gap.item.includes('主流程'));
  assert.ok(target, JSON.stringify(before.gaps));

  const res = run(['ux', '--resolve', target.id, '--by', '测试', '--root', dir], dir);
  assert.strictEqual(res.code, 0, `${res.out}${res.err}`);
  assert.match(res.out, /CLOSED/);
  assert.match(res.out, /关闭 1 项/);

  const store = readJson(path.join(dir, 'prototype/.ux-resolved.json'));
  assert.strictEqual(store.resolved.length, 1);
  assert.strictEqual(store.resolved[0].id, target.id);

  const after = readJson(gapsFile);
  assert.ok(!after.gaps.some((gap) => gap.id === target.id), '关闭后不再出现在清单');
  assert.ok(after.resolved >= 1);

  // 重跑 ux 仍保持关闭
  assert.strictEqual(run(['ux', '--root', dir], dir).code, 0);
  const rerun = readJson(gapsFile);
  assert.ok(!rerun.gaps.some((gap) => gap.id === target.id));
  assert.ok(rerun.resolvedGaps.some((gap) => gap.id === target.id));
});

test('ux：未知任务报 1，dry-run 不落盘', () => {
  const dir = repo();
  const dry = run(['ux', '--user-words', '做一个页面', '--dry-run', '--root', dir], dir);
  assert.strictEqual(dry.code, 0, dry.out);
  assert.ok(!fs.existsSync(path.join(dir, 'prototype/ux.html')), 'dry-run 不能创建报告');

  const unknown = run(['ux', '不存在的任务', '--root', dir], dir);
  assert.strictEqual(unknown.code, 1);
  assert.match(`${unknown.out}${unknown.err}`, /没有找到任务/);
});

test('ux：plans.html 操作栏暴露单任务 UX 与整体 UX 预览入口', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'task-a', '--root', dir], dir).code, 0);

  const before = fs.readFileSync(path.join(dir, 'plans.html'), 'utf8');
  assert.doesNotMatch(before, /id="ux-overview"/, '没有 UX 报告时不应出现整体 UX 按钮');

  assert.strictEqual(run(['ux', 'task-a', '--root', dir], dir).code, 0);

  const plans = fs.readFileSync(path.join(dir, 'plans.html'), 'utf8');
  assert.match(plans, /"hasUx":true/);
  assert.match(plans, /"uxPage":"prototype\/ux\.html"/);
  assert.match(plans, /id="ux-overview"/);
  assert.match(plans, /data-ux/);
  assert.match(plans, /整体 UX/);
  assert.match(plans, /previewUxOverview/);
});

test('plan：已开工任务只写 docs/specs，不改任务页 / 方案页', () => {
  const dir = repo(['--preset', 'prototype']);
  assert.strictEqual(run(['page', 'task-a', '--root', dir], dir).code, 0);
  assert.strictEqual(
    run(['progress', 'task-a', '--step', '1', '--pct', '100', '--root', dir], dir).code,
    0
  );

  const pageFile = path.join(dir, 'prototype/task-a/progress.html');
  const planFile = path.join(dir, 'prototype/task-a/plan.html');
  const pageBefore = fs.readFileSync(pageFile, 'utf8');
  const planBefore = fs.readFileSync(planFile, 'utf8');

  const res = run(['plan', 'task-a', '--force', '--root', dir], dir);
  assert.strictEqual(res.code, 0, `${res.out}${res.err}`);
  assert.match(res.out, /已开工 \/ 已确认的任务只动 docs\/specs/);
  assert.strictEqual(fs.readFileSync(pageFile, 'utf8'), pageBefore);
  assert.strictEqual(fs.readFileSync(planFile, 'utf8'), planBefore);
  assert.match(
    fs.readFileSync(path.join(dir, 'docs/specs/task-a/proposal.md'), 'utf8'),
    /提案/
  );
});
