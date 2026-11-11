'use strict';

/**
 * DSH Web 客户端菜单的纯逻辑测试。
 *
 * `plugin/client.js` 由宿主 ModuleLoader 加载；这里只执行模块工厂，不启动 React DOM，
 * 用来锁定上下键、首尾键对应的焦点索引规则。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

function loadClientModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');
  let definition;
  const context = {
    _ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  };
  vm.runInNewContext(source, context, {filename: 'client.js'});
  assert.ok(definition, '应调用 _ModuleLoader__.load');

  const react = {
    Fragment: {},
    createElement() {},
    useCallback(fn) {
      return fn;
    },
    useEffect() {},
    useRef() {
      return {current: null};
    },
    useState(value) {
      return [value, () => {}];
    },
  };
  return definition.factory((name) => {
    if (name === 'react') return react;
    if (name === 'react-dom') return {createPortal: (node) => node};
    throw new Error(`unexpected module: ${name}`);
  });
}

test('菜单键盘映射：上下键循环，Home / End 跳首尾', () => {
  const client = loadClientModule();
  assert.strictEqual(typeof client.menuIndexForKey, 'function');

  assert.strictEqual(client.menuIndexForKey(-1, 'ArrowDown', 3), 0);
  assert.strictEqual(client.menuIndexForKey(-1, 'ArrowUp', 3), 2);
  assert.strictEqual(client.menuIndexForKey(2, 'ArrowDown', 3), 0);
  assert.strictEqual(client.menuIndexForKey(0, 'ArrowUp', 3), 2);
  assert.strictEqual(client.menuIndexForKey(2, 'Home', 3), 0);
  assert.strictEqual(client.menuIndexForKey(0, 'End', 3), 2);
  assert.strictEqual(client.menuIndexForKey(1, 'Tab', 3), 1);
  assert.strictEqual(client.menuIndexForKey(-1, 'ArrowDown', 0), -1);
});

test('占位文案覆盖：自定义回答改为「请输入」，会话输入改为「请输入自定义语义」', () => {
  const client = loadClientModule();
  assert.strictEqual(typeof client.applyPlaceholderOverrides, 'function');

  const dict = {
    'question/custom.placeholder': '输入你的答案',
    'conversation/placeholder.default': '发消息或创建任务, / 调用指令, @ 文件或对话',
    'conversation/placeholder.hero': '描述你想要构建的内容, / 调用指令, @ 文件或对话',
    'conversation/placeholder.parentOffline': '父会话已离线',
    'other/key': '原样',
  };
  const locale = {
    translate(ns, key) {
      return dict[`${ns}/${key}`] ?? `${ns}/${key}`;
    },
  };
  const ctx = {locale, slots: {inject() {}, register() {}}};

  assert.strictEqual(client.applyPlaceholderOverrides(ctx), true);
  assert.strictEqual(locale.translate('question', 'custom.placeholder'), '请输入');
  assert.strictEqual(locale.translate('conversation', 'placeholder.default'), '请输入自定义语义');
  assert.strictEqual(locale.translate('conversation', 'placeholder.hero'), '请输入自定义语义');
  assert.strictEqual(locale.translate('conversation', 'placeholder.parentOffline'), '父会话已离线');
  assert.strictEqual(locale.translate('other', 'key'), '原样');
  assert.strictEqual(client.applyPlaceholderOverrides(ctx), false, '重复调用不应再次包装');
});

test('占位文案覆盖：locale 被冻结时保持宿主文案，不抛错', () => {
  const client = loadClientModule();
  const locale = Object.freeze({
    translate() {
      return '输入你的答案';
    },
  });
  assert.strictEqual(client.applyPlaceholderOverrides({locale}), false);
  assert.strictEqual(locale.translate('question', 'custom.placeholder'), '输入你的答案');
});

test('工具栏指令只填入草稿并聚焦，不自动 submit（与 / 菜单一致）', () => {
  const client = loadClientModule();
  assert.strictEqual(typeof client.launch, 'function');

  const calls = [];
  const inputActions = {
    setDraft(text) {
      calls.push(['draft', text]);
    },
    submit() {
      calls.push(['submit']);
    },
    focus() {
      calls.push(['focus']);
    },
  };

  client.launch({name: 'harness-cli check', needsArg: false}, inputActions);
  assert.deepStrictEqual(calls[0], ['draft', '/harness-cli check']);
  assert.deepStrictEqual(calls[1], ['focus']);
  assert.ok(!calls.some((call) => call[0] === 'submit'), '不能自动提交');

  calls.length = 0;
  client.launch({name: 'harness-cli page', needsArg: true}, inputActions);
  assert.deepStrictEqual(calls[0], ['draft', '/harness-cli page ']);
  assert.ok(!calls.some((call) => call[0] === 'submit'));
});
