'use strict';

/**
 * UX 分析的行为用例：需求拆解、报告生成、缺口判定与回写。
 * 分析是规则驱动的，这里只证明「事实进得去、缺口出得来、结论写得回」。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {
  collectUxFacts,
  writeUxReports,
  sliceFacts,
  applyUxContext,
  resolveUxGaps,
  saveUxRequirements,
  UX_BEGIN,
  splitRequirements,
  classifyRequirement,
  escapeHtml,
} = require('../src/ux');
const {loadConfig} = require('../src/config');
const {collectTasks} = require('../src/plans');

const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ux-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({name: 'ux-app', version: '1.0.0', scripts: {test: 'node --test'}})
  );
  execFileSync(process.execPath, [BIN, 'init', '--preset', 'prototype', '--root', dir], {cwd: dir});
  return dir;
}

function configOf(dir) {
  return loadConfig(dir).config;
}

/** 造一个文档齐全的任务（用于证明「没有阻断缺口」与回写）。 */
function seedCompleteTask(dir, name = '登录页面') {
  execFileSync(process.execPath, [BIN, 'page', name, '--root', dir], {cwd: dir});
  const specDir = path.join(dir, 'docs/specs', name);
  fs.writeFileSync(
    path.join(specDir, 'flow.md'),
    [
      `# ${name} · 业务流程图`,
      '',
      '## 1. 参与角色',
      '',
      '- 发起人：来访者，需要进入系统的人',
      '- 系统边界：登录表单与认证服务',
      '',
      '## 2. 业务流程图',
      '',
      '```mermaid',
      'flowchart TD',
      '  A[打开页面] --> B[填写表单]',
      '  B --> C[提交]',
      '```',
      '',
      '- 主流程：打开页面 → 填写表单 → 提交 → 看到成功或失败提示',
      '',
      '## 3. 异常路径',
      '',
      '- 输入不合法：就地提示，不发起登录。',
      '- 连续失败五次：锁定五分钟，提示剩余时间。',
      '',
      '## 4. 状态流转',
      '',
      '- 表单：待填写 → 提交中 → 成功 / 失败 / 锁定',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(specDir, 'proposal.md'),
    [
      `# ${name} · 提案`,
      '',
      '## 2. 为什么做',
      '',
      '来访者需要一个可用的入口进入系统，否则后面的页面都无法访问。',
      '',
      '## 3. 范围',
      '',
      '- 做什么：',
      '  - 一张登录表单，含用户名、密码、图形验证码。',
      '- 不做什么（非目标）：',
      '  - 不做注册与找回密码。',
      '',
      '## 4. 验收',
      '',
      '- 合法输入能登录并看到成功提示。',
      '- 空值与验证码错误被拦下并给出可读提示。',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(specDir, 'spec.md'),
    [
      `# ${name} · 契约`,
      '',
      '## S-01 登录主流程',
      '',
      '- 输入：用户名、密码、验证码。',
      '- 输出：进入系统首页。',
      '- 错误语义：凭证错误提示剩余次数。',
      '- 验收标准：合法输入通过。',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(specDir, 'design.md'),
    [
      `# ${name} · 设计`,
      '',
      '## 2. 统一语言',
      '',
      '| 术语 | 定义 |',
      '|---|---|',
      '| 登录 | 用凭证换取进入系统的资格 |',
      '',
      '## 4. 不变量',
      '',
      '- 锁定期间不允许提交。',
      '',
    ].join('\n')
  );
  const uiDir = path.join(dir, 'prototype', name, 'ui');
  fs.mkdirSync(uiDir, {recursive: true});
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>ui</title>');
  fs.writeFileSync(
    path.join(uiDir, 'README.md'),
    [
      `# ${name} · UI 设计说明`,
      '',
      '## 1. 页面目标',
      '',
      '- 让来访者完成登录。',
      '',
      '## 5. 状态与交互',
      '',
      '- 加载：按钮转圈。',
      '- 错误：表单下方提示。',
      '',
      '## 7. 响应式与可访问性',
      '',
      '- 键盘可聚焦；窄屏单列。',
      '',
    ].join('\n')
  );
}

test('ux：自定义需求拆句与分类', () => {
  const items = splitRequirements('做一个审批流。需要支持批量审批；不能跳过权限。体验要快');
  assert.deepStrictEqual(items, ['做一个审批流', '需要支持批量审批', '不能跳过权限', '体验要快']);
  assert.strictEqual(classifyRequirement('不能跳过权限'), '约束');
  assert.strictEqual(classifyRequirement('体验要快'), '体验');
  assert.strictEqual(classifyRequirement('支持批量审批'), '功能');
});

test('ux：自定义需求生成事实，且没有任务也能出报告', () => {
  const dir = tmpRepo();
  const facts = collectUxFacts(dir, configOf(dir), {
    userWords: '做一个审批流，管理员可以批量审批。体验要快，不能超过两秒。什么算做成：批量审批成功。',
  });
  assert.strictEqual(facts.summary.tasks, 0);
  assert.ok(facts.summary.requirements >= 2);
  assert.ok(facts.custom.users.includes('管理员'));
  assert.strictEqual(facts.blockingGaps.length, 0);

  const files = writeUxReports(dir, configOf(dir), facts);
  const html = fs.readFileSync(path.join(dir, files.global.html), 'utf8');
  assert.match(html, /UX 与需求分析报告/);
  assert.match(html, /批量审批/);
  assert.doesNotMatch(html, /\{\{/);
  assert.doesNotMatch(html, /<script>/);
  assert.ok(fs.existsSync(path.join(dir, files.global.json)));
  assert.ok(fs.existsSync(path.join(dir, files.global.gaps)));
});

test('ux：报告会转义仓库与用户文本，不把 HTML 写进页面', () => {
  const dir = tmpRepo();
  const facts = collectUxFacts(dir, configOf(dir), {
    userWords: '做一个 <script>alert(1)</script> 的页面，什么算做成：页面能打开。',
  });
  const files = writeUxReports(dir, configOf(dir), facts);
  const html = fs.readFileSync(path.join(dir, files.global.html), 'utf8');
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.strictEqual(escapeHtml('<a "x">'), '&lt;a &quot;x&quot;&gt;');
});

test('ux：文档齐全的任务没有阻断缺口，拆出用户 / 场景 / 需求', () => {
  const dir = tmpRepo();
  seedCompleteTask(dir);
  const facts = collectUxFacts(dir, configOf(dir), {tasks: ['登录页面']});
  assert.strictEqual(facts.summary.tasks, 1);
  assert.strictEqual(facts.blockingGaps.length, 0, JSON.stringify(facts.blockingGaps));
  assert.ok(facts.users.some((row) => row.text.includes('来访者')));
  assert.ok(facts.scenarios.some((row) => row.text.includes('打开页面')));
  assert.ok(facts.requirements.some((row) => row.text.includes('登录表单')));
  assert.ok(facts.heuristics.some((row) => row.tone === 'pass'));

  const files = writeUxReports(dir, configOf(dir), facts);
  assert.ok(fs.existsSync(path.join(dir, files.global.html)), '应有全量报告 prototype/ux.html');
  assert.ok(fs.existsSync(path.join(dir, files.tasks[0].html)), '应有单任务报告 prototype/<任务>/ux/index.html');
  const taskHtml = fs.readFileSync(path.join(dir, files.tasks[0].html), 'utf8');
  assert.match(taskHtml, /登录页面 · UX 与需求分析报告/);
  assert.doesNotMatch(taskHtml, /自定义需求分析/);
  // 全量报告是 prototype 根下的文件，不能被当成任务
  assert.deepStrictEqual(collectTasks(dir, configOf(dir)).map((task) => task.name), ['登录页面']);
});

test('ux：骨架任务会列出阻断缺口，并写进缺口清单', () => {
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'page', '登录页面', '--root', dir], {cwd: dir});
  const facts = collectUxFacts(dir, configOf(dir), {tasks: ['登录页面']});
  assert.ok(facts.blockingGaps.length >= 2);
  assert.ok(facts.gaps.some((gap) => gap.item.includes('主流程')));
  const files = writeUxReports(dir, configOf(dir), facts);
  const report = JSON.parse(fs.readFileSync(path.join(dir, files.global.gaps), 'utf8'));
  assert.strictEqual(report.count, facts.gaps.length);
  assert.strictEqual(report.blocking, facts.blockingGaps.length);
});

test('ux --apply：把结论写回 design.md 的受管区块，可重复执行', () => {
  const dir = tmpRepo();
  seedCompleteTask(dir);
  const config = configOf(dir);
  const facts = collectUxFacts(dir, config, {tasks: ['登录页面']});

  const first = applyUxContext(dir, config, facts);
  assert.deepStrictEqual(first.updated, ['登录页面']);
  const design = path.join(dir, 'docs/specs/登录页面/design.md');
  const text = fs.readFileSync(design, 'utf8');
  assert.ok(text.includes(UX_BEGIN));
  assert.match(text, /UX 复核/);
  assert.match(text, /需求：/);

  const second = applyUxContext(dir, config, facts);
  assert.deepStrictEqual(second.updated, []);
  assert.deepStrictEqual(second.unchanged, ['登录页面']);
  assert.strictEqual(fs.readFileSync(design, 'utf8'), text);
});

test('ux：未知任务给出可操作错误', () => {
  const dir = tmpRepo();
  assert.throws(
    () => collectUxFacts(dir, configOf(dir), {tasks: ['不存在的任务']}),
    /没有找到任务/
  );
});

test('ux：整体报告永远覆盖全部任务，任务参数只决定回写范围', () => {
  const dir = tmpRepo();
  seedCompleteTask(dir, '任务甲');
  seedCompleteTask(dir, '任务乙');
  const config = configOf(dir);

  const facts = collectUxFacts(dir, config, {tasks: ['任务甲']});
  assert.strictEqual(facts.summary.tasks, 2, '整体报告必须覆盖全部任务');
  assert.deepStrictEqual(facts.selected, ['任务甲']);

  const files = writeUxReports(dir, config, facts);
  assert.strictEqual(files.tasks.length, 2, '每个任务都要有单任务报告');
  const html = fs.readFileSync(path.join(dir, files.global.html), 'utf8');
  assert.match(html, /任务甲/);
  assert.match(html, /任务乙/);
  assert.match(html, /全部 2 个任务/);
});

test('ux：项目需求写入 docs/ux/requirements.md，重跑不会丢', () => {
  const dir = tmpRepo();
  const config = configOf(dir);
  const facts = collectUxFacts(dir, config, {
    userWords: '做一个审批流，管理员可以批量审批。什么算做成：批量审批成功。',
  });
  const saved = saveUxRequirements(dir, config, facts);
  assert.strictEqual(saved, 'docs/ux/requirements.md');
  assert.ok(fs.existsSync(path.join(dir, saved)));

  const again = collectUxFacts(dir, config, {});
  assert.strictEqual(again.summary.tasks, 0);
  assert.ok(again.requirements.some((row) => row.text.includes('批量审批')));
  assert.strictEqual(again.projectRequirements.newCount, 0);
  assert.deepStrictEqual(again.projectRequirements.users, ['管理员']);

  // 同一段需求重复输入不会写成两行
  const dup = collectUxFacts(dir, config, {userWords: '做一个审批流，管理员可以批量审批。'});
  assert.strictEqual(dup.newRequirements.length, 0);
  saveUxRequirements(dir, config, dup);
  const text = fs.readFileSync(path.join(dir, saved), 'utf8');
  assert.strictEqual((text.match(/管理员可以批量审批/g) || []).length, 1);
});

test('ux：缺口编号稳定，关闭后移出清单，文档修好后关闭记录自动清理', () => {
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'page', '登录页面', '--root', dir], {cwd: dir});
  const config = configOf(dir);

  const facts = collectUxFacts(dir, config, {});
  const target = facts.gaps.find((gap) => gap.item === '没有写清目标用户 / 角色');
  assert.ok(target, '骨架任务应缺参与角色');
  const again = collectUxFacts(dir, config, {});
  assert.strictEqual(
    again.gaps.find((gap) => gap.item === target.item).id,
    target.id,
    '同一缺口重跑后编号不变'
  );

  const closed = resolveUxGaps(dir, config, [target.id], '测试');
  assert.deepStrictEqual(closed.resolved.map((gap) => gap.id), [target.id]);
  assert.strictEqual(closed.unknown.length, 0);

  const after = collectUxFacts(dir, config, {});
  assert.ok(!after.gaps.some((gap) => gap.id === target.id), '关闭后不再出现在待确认清单');
  assert.ok(after.resolvedGaps.some((gap) => gap.id === target.id));
  assert.strictEqual(after.summary.blocking, facts.summary.blocking, '关闭非阻断项不影响阻断数');

  // 把参与角色补进 flow.md：缺口本身消失，关闭记录也应被清理，避免文档回退后被误关
  const flowFile = path.join(dir, 'docs/specs/登录页面/flow.md');
  fs.writeFileSync(
    flowFile,
    [
      '# 登录页面 · 业务流程图',
      '',
      '## 1. 参与角色',
      '',
      '- 发起人：来访者，需要进入系统的人',
      '',
      '## 2. 业务流程图',
      '',
      '```mermaid',
      'flowchart TD',
      '  A[打开页面] --> B[提交]',
      '```',
      '',
      '- 主流程：打开发页面 → 提交 → 看到结果',
      '',
      '## 3. 异常路径',
      '',
      '- 输入不合法：就地提示。',
      '',
      '## 4. 状态流转',
      '',
      '- 表单：待填写 → 提交中 → 成功 / 失败',
      '',
    ].join('\n')
  );
  const fixed = collectUxFacts(dir, config, {});
  assert.ok(!fixed.gaps.some((gap) => gap.id === target.id), '文档修好后缺口自动消失');
  writeUxReports(dir, config, fixed);
  const store = JSON.parse(fs.readFileSync(path.join(dir, 'prototype/.ux-resolved.json'), 'utf8'));
  assert.deepStrictEqual(store.resolved, [], '文档修好后关闭记录不再保留');
});

test('ux：维度按优先级给出分析结论，用户 / 需求 / 流程 / 异常优先', () => {
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'page', '登录页面', '--root', dir], {cwd: dir});
  const facts = collectUxFacts(dir, configOf(dir), {});
  assert.deepStrictEqual(
    facts.dimensions.map((item) => item.key),
    ['users', 'requirements', 'relations', 'flow', 'recovery', 'states', 'usability', 'docs']
  );
  for (const key of ['users', 'requirements', 'flow', 'recovery']) {
    const dimension = facts.dimensions.find((item) => item.key === key);
    assert.ok(dimension.conclusion.length > 0, `${key} 应有分析结论`);
    assert.ok(dimension.gapCount > 0, `${key} 的缺口应进入待确认`);
  }
  assert.ok(facts.analysis.users.includes('参与角色'));
  assert.ok(facts.analysis.recovery.includes('异常路径'));
});

test('ux：关联任务会被识别，--apply 同步刷新关联任务', () => {
  const dir = tmpRepo();
  seedCompleteTask(dir, '任务甲');
  seedCompleteTask(dir, '任务乙');
  fs.appendFileSync(
    path.join(dir, 'docs/specs/任务甲/flow.md'),
    '\n## 5. 关联任务\n\n- 关联任务：任务乙\n'
  );
  const config = configOf(dir);
  const facts = collectUxFacts(dir, config, {tasks: ['任务甲']});
  assert.ok(
    facts.relations.some((row) => row.from === '任务甲' && row.to === '任务乙' && row.kind === 'explicit'),
    JSON.stringify(facts.relations)
  );
  assert.ok(facts.taskRows.find((row) => row.name === '任务甲').relatedText.includes('任务乙'));

  const result = applyUxContext(dir, config, facts, ['任务甲']);
  assert.deepStrictEqual(result.related, ['任务乙']);
  assert.ok(result.updated.includes('任务甲'));
  assert.ok(result.updated.includes('任务乙'), '关联任务应同步刷新');
  assert.match(
    fs.readFileSync(path.join(dir, 'docs/specs/任务乙/design.md'), 'utf8'),
    /关联任务：任务甲/
  );
});

test('ux：文档里互相提及也会识别为任务关联', () => {
  const dir = tmpRepo();
  seedCompleteTask(dir, '任务甲');
  seedCompleteTask(dir, '任务乙');
  fs.appendFileSync(
    path.join(dir, 'docs/specs/任务乙/proposal.md'),
    '\n## 5. 关联\n\n本任务接在任务甲之后，复用同一套登录口径。\n'
  );
  const facts = collectUxFacts(dir, configOf(dir), {tasks: ['任务乙']});
  const relation = facts.relations.find(
    (row) => row.from === '任务乙' && row.to === '任务甲'
  );
  assert.ok(relation, JSON.stringify(facts.relations));
  assert.strictEqual(relation.kind, 'mention');
  assert.ok(relation.evidence.includes('任务甲'));
});

test('ux：关联任务术语口径不一致会进待确认，两边报告都能看到', () => {
  const dir = tmpRepo();
  seedCompleteTask(dir, '任务甲');
  seedCompleteTask(dir, '任务乙');
  fs.appendFileSync(
    path.join(dir, 'docs/specs/任务甲/flow.md'),
    '\n## 5. 关联任务\n\n- 关联任务：任务乙\n'
  );
  fs.writeFileSync(
    path.join(dir, 'docs/specs/任务乙/design.md'),
    [
      '# 任务乙 · 设计',
      '',
      '## 2. 统一语言',
      '',
      '| 术语 | 定义 |',
      '|---|---|',
      '| 登录 | 用另一套凭证换取进入系统的资格 |',
      '',
    ].join('\n')
  );
  const facts = collectUxFacts(dir, configOf(dir), {});
  const conflict = facts.gaps.find(
    (gap) => gap.dimension === 'relations' && gap.item.includes('登录')
  );
  assert.ok(conflict, JSON.stringify(facts.gaps.filter((gap) => gap.dimension === 'relations')));
  assert.deepStrictEqual(conflict.related.sort(), ['任务乙', '任务甲'].sort());
  const sliced = sliceFacts(
    facts,
    facts.tasks.find((task) => task.name === '任务乙'),
    'prototype',
    configOf(dir)
  );
  assert.ok(sliced.gaps.some((gap) => gap.id === conflict.id), '关联任务报告也要看到同一条');
});
