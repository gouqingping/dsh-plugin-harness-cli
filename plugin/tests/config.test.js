'use strict';

/** 配置与探测单测：最小覆盖语义不能被意外改掉。 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {defaultConfig, loadConfig, validateConfig, merge, CONFIG_FILE} = require('../src/config');
const {detect} = require('../src/detect');

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-cfg-'));
  for (const [name, content] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

test('默认配置包含四件套路径与门禁', () => {
  const dir = tmpRepo();
  const cfg = defaultConfig(dir);
  assert.strictEqual(cfg.paths.agents, 'AGENTS.md');
  assert.strictEqual(cfg.paths.featureList, 'docs/feature_list.json');
  assert.ok(cfg.commands.gate.includes('gate.sh'));
  assert.strictEqual(cfg.presets.prototype.enabled, false);
  assert.ok(cfg.forbidden.length >= 3);
});

test('merge：对象逐键合并，数组整体替换', () => {
  const out = merge({a: {x: 1, y: 2}, list: [1, 2]}, {a: {y: 9}, list: [7]});
  assert.deepStrictEqual(out, {a: {x: 1, y: 9}, list: [7]});
});

test('配置文件只覆盖显式字段', () => {
  const dir = tmpRepo({
    [CONFIG_FILE]: JSON.stringify({project: {name: 'x-app'}, commands: {test: 'pytest'}}),
  });
  const {config, hadFile} = loadConfig(dir);
  assert.strictEqual(hadFile, true);
  assert.strictEqual(config.project.name, 'x-app');
  assert.strictEqual(config.commands.test, 'pytest');
  assert.strictEqual(config.paths.gate, 'scripts/gate.sh'); // 未声明的字段走默认值
});

test('坏 JSON 抛错而不是静默降级', () => {
  const dir = tmpRepo({[CONFIG_FILE]: '{ not json'});
  assert.throws(() => loadConfig(dir), /不是合法 JSON/);
});

test('validateConfig 拦住空路径与过短的禁止事项', () => {
  const dir = tmpRepo();
  const cfg = defaultConfig(dir);
  cfg.paths.gate = '';
  cfg.forbidden = ['只有一条'];
  const issues = validateConfig(cfg);
  assert.ok(issues.some((i) => i.includes('paths.gate')));
  assert.ok(issues.some((i) => i.includes('forbidden')));
});

test('探测 package.json 的脚本与包管理器', () => {
  const dir = tmpRepo({
    'package.json': JSON.stringify({
      name: 'demo',
      version: '1.2.3',
      scripts: {test: 'node --test', lint: 'eslint .'},
    }),
    'package-lock.json': '{}',
    'tsconfig.json': '{}',
  });
  const facts = detect(dir);
  assert.strictEqual(facts.name, 'demo');
  assert.strictEqual(facts.packageManager, 'npm');
  assert.strictEqual(facts.commands.test, 'npm run test');
  assert.strictEqual(facts.commands.install, 'npm install');
  assert.ok(facts.languages.includes('TypeScript'));
});
