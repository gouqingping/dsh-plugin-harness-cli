'use strict';

/**
 * 业务 wiki 的行为用例：三路合并、基线状态、docs 反推。
 * 这些用例直接调 src/wiki.js 与 src/wikidocs.js，跑得快，也不依赖 CLI 输出格式。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {merge3, diffOps, applyWiki, planWiki, extractBlock} = require('../src/wiki');
const {collectDocFacts, stripInline, isBusiness, scopeOf, paragraphs} = require('../src/wikidocs');

const BIN = path.join(__dirname, '..', 'bin', 'dsh-plugin-harness-cli.js');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-wiki-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({name: 'wiki-app', version: '1.0.0', scripts: {test: 'node --test'}})
  );
  execFileSync(process.execPath, [BIN, 'init', '--root', dir], {cwd: dir});
  return dir;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function setPositioning(dir, value) {
  const file = path.join(dir, 'harness-cli.json');
  const cfg = readJson(file);
  cfg.project.positioning = value;
  writeJson(file, cfg);
}

function seedDocs(dir) {
  const specDir = path.join(dir, 'docs/specs/demo');
  fs.mkdirSync(specDir, {recursive: true});
  fs.writeFileSync(
    path.join(specDir, 'proposal.md'),
    [
      '# demo · 提案（Proposal）',
      '',
      '## 2. 为什么做',
      '',
      '线下登记容易漏单，客户投诉多，需要一张随时能填的表单。',
      '',
      '## 3. 范围',
      '',
      '- 做什么：',
      '  - 一张下单表单，字段与校验规则写清。',
      '  - 提交后给出可读的成功提示。',
      '- 不做什么（非目标）：',
      '  - 不做支付对接，支付由财务系统承接。',
      '  - 不做短信通知。',
      '',
      '## 4. 验收',
      '',
      '- 合法输入能提交并看到成功提示。',
      '- 空值被拦下并提示。',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(specDir, 'spec.md'),
    [
      '# demo · 契约（SDD / Spec）',
      '',
      '## S-01 下单主流程',
      '',
      '- 输入：门店、金额、备注。',
      '',
      '## S-02 异常与边界',
      '',
      '- 输入：金额为空或小于零。',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(specDir, 'design.md'),
    [
      '# demo · 设计（DDD）',
      '',
      '## 2. 统一语言',
      '',
      '| 术语 | 定义 |',
      '|---|---|',
      '| 单据 | 一次下单产生的业务记录 |',
      '| 门店 | 下单发生的线下门店 |',
      '',
      '## 4. 不变量',
      '',
      '- 单据金额必须大于零，否则不允许提交。',
      '',
    ].join('\n')
  );
  fs.mkdirSync(path.join(dir, 'docs/adr'), {recursive: true});
  fs.writeFileSync(
    path.join(dir, 'docs/adr/ADR-0001-store.md'),
    [
      '# ADR-0001：先做线下门店',
      '',
      '- 状态：已接受',
      '',
      '## 2. 决策',
      '',
      '先覆盖三家直营门店，再考虑加盟。',
      '',
    ].join('\n')
  );
}

test('merge3：两边改不同段落时都生效', () => {
  const base = ['a', 'b', 'c', 'd', 'e'];
  const ours = ['a', 'B', 'c', 'd', 'e'];
  const theirs = ['a', 'b', 'c', 'D', 'e'];
  const result = merge3(base, ours, theirs);
  assert.deepStrictEqual(result.lines, ['a', 'B', 'c', 'D', 'e']);
  assert.strictEqual(result.kept, 0);
});

test('merge3：两边改同一段时保留人工版本并计数', () => {
  const base = ['a', 'b', 'c'];
  const ours = ['a', '人工', 'c'];
  const theirs = ['a', '生成', 'c'];
  const result = merge3(base, ours, theirs);
  assert.deepStrictEqual(result.lines, ['a', '人工', 'c']);
  assert.strictEqual(result.kept, 1);
});

test('merge3：合并结果作为新基线时可重复合并（幂等）', () => {
  const base = ['a', 'b', 'c', 'd'];
  const ours = ['a', '人工', 'c', 'd', 'X'];
  const theirs = ['a', 'b', 'c', '生成', 'd'];
  const once = merge3(base, ours, theirs);
  const twice = merge3(theirs, once.lines, theirs);
  assert.deepStrictEqual(twice.lines, once.lines);
  assert.strictEqual(twice.kept, 0);
});

test('diffOps：纯插入与整段替换都能表达', () => {
  assert.deepStrictEqual(diffOps(['a', 'b'], ['a', 'x', 'b']), [{aStart: 1, aEnd: 1, lines: ['x']}]);
  assert.deepStrictEqual(diffOps(['a', 'b'], ['a']), [{aStart: 1, aEnd: 2, lines: []}]);
});

test('applyWiki：默认增量合并，人工段落保留、事实刷新', () => {
  const dir = tmpRepo();
  const first = applyWiki(dir, {mode: 'merge'});
  assert.strictEqual(first.changed, 13);

  const overview = path.join(dir, 'docs/wiki/一页纸速览.md');
  fs.writeFileSync(
    overview,
    fs.readFileSync(overview, 'utf8').replace('## 3. 能力全景', '## 3. 能力全景（人工改名）')
  );
  setPositioning(dir, '新的项目定位，用来触发事实刷新。');

  const second = applyWiki(dir, {mode: 'merge'});
  const entry = second.entries.find((item) => item.name === '一页纸速览.md');
  assert.strictEqual(entry.action, 'merge');

  const text = fs.readFileSync(overview, 'utf8');
  assert.match(text, /人工改名/, '人工改过的标题必须保留');
  assert.match(text, /新的项目定位，用来触发事实刷新。/, '生成器的事实必须刷新');
});

test('applyWiki：旧状态没有基线时保留人工段落并建立基线', () => {
  const dir = tmpRepo();
  applyWiki(dir, {mode: 'merge'});
  const stateFile = path.join(dir, 'docs/wiki/.harness-wiki.json');
  const state = readJson(stateFile);
  // 模拟旧版状态：只有 autoHash，没有 base
  for (const key of Object.keys(state.files)) delete state.files[key].base;
  writeJson(stateFile, state);

  const overview = path.join(dir, 'docs/wiki/一页纸速览.md');
  fs.writeFileSync(overview, fs.readFileSync(overview, 'utf8').replace('## 3. 能力全景', '## 3. 人工改名'));
  setPositioning(dir, '新的定位');

  const legacy = applyWiki(dir, {mode: 'merge'});
  const legacyEntry = legacy.entries.find((item) => item.name === '一页纸速览.md');
  assert.strictEqual(legacyEntry.action, 'keep');
  assert.match(legacyEntry.reason, /没有合并基线/);
  assert.match(fs.readFileSync(overview, 'utf8'), /人工改名/);

  // 基线已建立，下一次生成可以按差异合并
  const next = readJson(stateFile);
  assert.strictEqual(typeof next.files['一页纸速览.md'].base, 'string');
  assert.match(next.files['一页纸速览.md'].base, /新的定位/);
});

test('applyWiki：--keep 不动已有文件，--update 整块重写', () => {
  const dir = tmpRepo();
  applyWiki(dir, {mode: 'merge'});
  const file = path.join(dir, 'docs/wiki/术语表.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## 1. 体系与文件', '## 1. 人工改名'));
  setPositioning(dir, '换定位');

  const kept = applyWiki(dir, {mode: 'keep'});
  assert.strictEqual(kept.changed, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /人工改名/);

  const rewritten = applyWiki(dir, {mode: 'auto'});
  assert.ok(rewritten.changed >= 1);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /人工改名/);
});

test('applyWiki：没有受管区块的既有文档被接管，原文保留', () => {
  const dir = tmpRepo();
  applyWiki(dir, {mode: 'merge'});
  const file = path.join(dir, 'docs/wiki/业务流程.md');
  fs.writeFileSync(file, '# 业务流程（人工版）\n\n人工写的一段。\n');

  const result = applyWiki(dir, {mode: 'merge'});
  const entry = result.entries.find((item) => item.name === '业务流程.md');
  assert.strictEqual(entry.action, 'adopt');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('<!-- harness-wiki:begin -->'));
  assert.match(text, /^# 业务流程（人工版）/m);
  assert.match(text, /人工写的一段/);
});

test('applyWiki：受管区块标记不完整时只报冲突，不硬写', () => {
  const dir = tmpRepo();
  applyWiki(dir, {mode: 'merge'});
  const file = path.join(dir, 'docs/wiki/术语表.md');
  const broken = '# 术语表\n\n<!-- harness-wiki:begin -->\n没有结束标记。\n';
  fs.writeFileSync(file, broken);

  const result = applyWiki(dir, {mode: 'merge'});
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), broken);
});

test('planWiki：状态记录本次生成的正文作为下次合并基线', () => {
  const dir = tmpRepo();
  applyWiki(dir, {mode: 'merge'});
  const state = readJson(path.join(dir, 'docs/wiki/.harness-wiki.json'));
  assert.strictEqual(state.version, 2);
  const entry = state.files['术语表.md'];
  assert.strictEqual(typeof entry.base, 'string');
  assert.ok(entry.base.includes('## 1. 体系与文件'));
});

test('wiki --merge：显式模式覆盖配置里的 wiki.mode = keep', () => {
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'wiki', '--root', dir], {cwd: dir});
  const cfgFile = path.join(dir, 'harness-cli.json');
  const cfg = readJson(cfgFile);
  cfg.wiki = {mode: 'keep'};
  writeJson(cfgFile, cfg);

  const overview = path.join(dir, 'docs/wiki/一页纸速览.md');
  fs.writeFileSync(overview, fs.readFileSync(overview, 'utf8').replace('## 3. 能力全景', '## 3. 人工改名'));
  setPositioning(dir, '显式 --merge 的定位');

  execFileSync(process.execPath, [BIN, 'wiki', '--merge', '--root', dir], {cwd: dir});
  const text = fs.readFileSync(overview, 'utf8');
  assert.match(text, /人工改名/);
  assert.match(text, /显式 --merge 的定位/);
});

test('wikidocs：从提案 / 契约 / 设计 / ADR 反推业务事实', () => {
  const dir = tmpRepo();
  seedDocs(dir);
  const facts = collectDocFacts(dir, {specs: 'docs/specs', decisions: 'docs/adr'});

  assert.ok(facts.why.some((item) => item.includes('线下登记容易漏单')));
  assert.ok(facts.scopeOut.some((item) => item.includes('不做支付对接')));
  assert.deepStrictEqual(facts.acceptance[0].items.length, 2);
  assert.strictEqual(facts.terms[0].term, '单据');
  assert.ok(facts.invariants[0].includes('金额必须大于零'));
  assert.deepStrictEqual(facts.contracts.map((item) => item.id), ['S-01', 'S-02']);
  assert.ok(facts.decisions.some((item) => item.title.includes('先做线下门店')));
});

test('wikidocs：反推内容会进入生成物，且不透出代码、路径与技术细节', () => {
  const dir = tmpRepo();
  seedDocs(dir);
  applyWiki(dir, {mode: 'merge'});

  const overview = fs.readFileSync(path.join(dir, 'docs/wiki/一页纸速览.md'), 'utf8');
  assert.match(overview, /线下登记容易漏单/);
  assert.match(overview, /不做支付对接/);

  const glossary = fs.readFileSync(path.join(dir, 'docs/wiki/术语表.md'), 'utf8');
  assert.match(glossary, /单据/);
  assert.match(glossary, /一次下单产生的业务记录/);

  const rules = fs.readFileSync(path.join(dir, 'docs/wiki/业务规则与状态.md'), 'utf8');
  assert.match(rules, /S-01/);
  assert.match(rules, /金额必须大于零/);

  const conventions = fs.readFileSync(path.join(dir, 'docs/wiki/业务规范与口径.md'), 'utf8');
  assert.match(conventions, /ADR-0001/);

  for (const name of fs.readdirSync(path.join(dir, 'docs/wiki'))) {
    if (!name.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(dir, 'docs/wiki', name), 'utf8');
    assert.doesNotMatch(text, /`/, `${name} 出现反引号`);
    assert.doesNotMatch(text, /```/, `${name} 出现代码块`);
  }
});

test('wikidocs：Markdown 清洗只留业务白话', () => {
  assert.strictEqual(
    stripInline('**登录页** 是 `前置关卡`，见 [说明](https://example.com)。'),
    '登录页是前置关卡，见说明。'
  );
  assert.strictEqual(isBusiness('运行 node plugin/bin/x.js 生成'), false);
  assert.strictEqual(isBusiness('字段 account.username 不允许为空'), false);
  assert.strictEqual(isBusiness('用户名长度需为 4-10 位'), true);

  const scope = scopeOf([
    '- 做什么：',
    '  - 一张下单表单，字段与校验规则写清。',
    '- 不做什么（非目标）：',
    '  - 不做支付对接，支付由财务系统承接。',
  ]);
  assert.deepStrictEqual(scope.inside, ['一张下单表单，字段与校验规则写清。']);
  assert.deepStrictEqual(scope.outside, ['不做支付对接，支付由财务系统承接。']);

  const items = paragraphs([
    '- 数据模型里用户名为 varchar(10)，',
    '  长度校验在提交前完成。',
  ]);
  assert.strictEqual(items.length, 1);
  assert.match(items[0], /长度校验在提交前完成/);
});
