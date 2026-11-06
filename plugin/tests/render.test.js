'use strict';

/** 模板引擎单测：块标签、点号取值、嵌套循环、错误提示。 */

const test = require('node:test');
const assert = require('node:assert');
const {render, requiredKeys} = require('../src/render');

test('变量替换与数组拼接', () => {
  assert.strictEqual(render('a={{x}}', {x: 1}), 'a=1');
  assert.strictEqual(render('{{list}}', {list: ['a', 'b']}), 'a, b');
  assert.strictEqual(render('{{missing}}', {}), '');
});

test('点号路径取值', () => {
  assert.strictEqual(render('{{a.b.c}}', {a: {b: {c: 'deep'}}}), 'deep');
  assert.strictEqual(render('{{a.b.c}}', {a: {}}), '');
});

test('if / unless 按真值判断，空数组算假', () => {
  const t = '{{#if on}}Y{{/if}}{{#unless on}}N{{/unless}}';
  assert.strictEqual(render(t, {on: true}), 'Y');
  assert.strictEqual(render(t, {on: false}), 'N');
  assert.strictEqual(render(t, {on: []}), 'N');
  assert.strictEqual(render(t, {on: 'x'}), 'Y');
});

test('each 支持 this 与对象字段', () => {
  assert.strictEqual(render('{{#each xs}}[{{.}}]{{/each}}', {xs: ['a', 'b']}), '[a][b]');
  assert.strictEqual(
    render('{{#each rows}}{{name}}:{{.cmd}} {{/each}}', {rows: [{name: 'n', cmd: 'c'}]}),
    'n:c '
  );
});

test('嵌套 each 使用内层作用域', () => {
  const tpl = '{{#each steps}}{{name}}({{#each lines}}{{.}}|{{/each}}){{/each}}';
  const out = render(tpl, {steps: [{name: 'a', lines: ['x', 'y']}, {name: 'b', lines: []}]});
  assert.strictEqual(out, 'a(x|y|)b()');
});

test('未闭合与不配对的标签要报错，不静默通过', () => {
  assert.throws(() => render('{{#if x}}', {x: true}), /未闭合/);
  assert.throws(() => render('{{#if x}}{{/each}}', {x: true}), /不配对/);
  assert.throws(() => render('{{/if}}', {}), /多余/);
});

test('requiredKeys 收集模板依赖的字段', () => {
  const keys = requiredKeys('{{a}} {{#if b}}{{/if}}{{#each c}}{{/each}}');
  assert.deepStrictEqual(keys.sort(), ['a', 'b', 'c']);
});
