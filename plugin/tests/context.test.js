'use strict';

/**
 * 上下文完整性：模板里的占位符必须都有值。
 * 缺值不会报错，只会渲染成空的反引号对（如 ``）——在生成出来的文档里几乎看不出来，
 * 所以这里把"渲染结果里出现空的行内代码"直接判成失败。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {defaultConfig} = require('../src/config');
const {buildContext} = require('../src/context');
const {buildPlan} = require('../src/scaffold');
const {render} = require('../src/render');
const {loadTemplate} = require('../src/templates');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = defaultConfig(ROOT);

/** 恰好两个反引号（成对但中间没内容），不误伤 ``` 代码围栏。 */
const EMPTY_INLINE_CODE = /(?<!`)``(?!`)/;

test('认领相关路径在上下文里有值：featureList / taskQueue / docs', () => {
  const ctx = buildContext(CONFIG, {});
  assert.strictEqual(ctx.featureList, CONFIG.paths.featureList);
  assert.strictEqual(ctx.taskQueue, CONFIG.paths.taskQueue);
  assert.strictEqual(ctx.docs, CONFIG.paths.docs);
  for (const key of ['featureList', 'taskQueue', 'docs']) {
    assert.ok(String(ctx[key]).length > 0, `上下文缺少 ${key}`);
  }
});

test('AGENTS.md 与认领 README 不出现空的占位符', () => {
  const ctx = buildContext(CONFIG, {});
  for (const key of ['agents', 'claimsReadme']) {
    const out = render(loadTemplate(key), ctx);
    const bad = out.split('\n').filter((line) => EMPTY_INLINE_CODE.test(line));
    assert.deepStrictEqual(bad, [], `${key} 渲染出空的行内代码：\n${bad.join('\n')}`);
  }
  const agents = render(loadTemplate('agents'), ctx);
  assert.ok(agents.includes(`\`${CONFIG.paths.featureList}\``), 'AGENTS.md 没有写清功能清单路径');
  const claims = render(loadTemplate('claimsReadme'), ctx);
  assert.ok(claims.includes(`\`${CONFIG.paths.taskQueue}\``), '认领 README 没有写清任务队列路径');
});

test('AGENTS.md 开工前先问操作模式，并写明自动 loop 的确认口径', () => {
  const ctx = buildContext(CONFIG, {});
  const agents = render(loadTemplate('agents'), ctx);
  assert.match(agents, /开工前先问用户/, '缺少开工前的操作模式问题');
  assert.match(agents, /手动/, '缺少手动模式');
  assert.match(agents, /自动 loop/, '缺少自动 loop 模式');
  assert.match(agents, /推荐项/, '没有写清自动 loop 下确认走推荐项');
});

test('AGENTS.md 默认要求继续未完成任务', () => {
  const ctx = buildContext(CONFIG, {});
  const agents = render(loadTemplate('agents'), ctx);
  assert.match(agents, /有未完成任务时先继续完成/, '没有要求优先继续未完成任务');
  assert.match(agents, /不要从零重做或另起无关任务/, '没有禁止忽略已有进度另起任务');
});

test('任务页约定要求每一步变化都跑 progress，并先问操作模式', () => {
  const ctx = buildContext({...CONFIG, presets: {prototype: {...CONFIG.presets.prototype, enabled: true}}}, {});
  const agents = render(loadTemplate('agents'), ctx);
  assert.match(agents, /每一步变化[\s\S]*dsh-plugin-harness-cli progress/, 'AGENTS.md 没写每一步都要跑 progress');
  assert.match(agents, /不许攒到收工/, 'AGENTS.md 没禁止攒进度');

  const readme = render(loadTemplate('prototypeReadme'), ctx);
  assert.match(readme, /开工前先选操作模式/);
  assert.match(readme, /每一步变化/);
});

test('TDD 验证步骤统一为模拟环境沙箱测试，不再要求真机', () => {
  const config = {...CONFIG, presets: {prototype: {...CONFIG.presets.prototype, enabled: true}}};
  const ctx = buildContext(config, {task: 'task-demo'});
  for (const key of ['progressHtml', 'prototypeReadme', 'agents']) {
    const text = render(loadTemplate(key), ctx);
    assert.match(text, /模拟环境沙箱测试/, `${key} 没写模拟环境沙箱测试`);
    assert.doesNotMatch(text, /真机/, `${key} 仍在要求真机验证`);
  }
});

test('init 计划里的每个生成物都不含空的占位符', () => {
  const config = JSON.parse(JSON.stringify(CONFIG));
  config.presets.prototype.enabled = true;
  const plan = buildPlan(ROOT, config, {});
  const failures = [];
  for (const item of plan) {
    if (item.isDirMarker || typeof item.content !== 'string') continue;
    const lines = item.content.split('\n').filter((line) => EMPTY_INLINE_CODE.test(line));
    if (lines.length > 0) failures.push(`${item.rel}: ${lines[0].trim()}`);
  }
  assert.deepStrictEqual(failures, [], `以下生成物有空的占位符：\n${failures.join('\n')}`);
});
