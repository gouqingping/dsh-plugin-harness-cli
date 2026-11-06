'use strict';

/**
 * 收录自查：对照 dsh-plugin.org 的收录要求，断言仓库根目录的可验证项。
 * 远端项（公开仓库 / topic / NPM 发布）无法在本地判断，见 docs/MARKETPLACE.md。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

test('收录：根 package.json 声明包名 / 版本 / 许可证 / bundle patch', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.name, 'dsh-plugin-harness-cli');
  assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  assert.strictEqual(pkg.license, 'CC0-1.0');
  assert.ok(pkg.files.includes('plugin/**'), 'files 应包含 plugin/**');
  assert.ok(pkg.dsh && pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string');
  assert.ok(exists(pkg.dsh.bundle.patch), 'bundle patch 文件必须存在');
  assert.match(read(pkg.dsh.bundle.patch), /insert:/);
  assert.match(read(pkg.dsh.bundle.patch), /dsh-plugin-harness-cli/);
});

test('收录：入口导出 apply(ctx) 与 inject', async () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.main, 'plugin/cordis.mjs');
  assert.ok(exists(pkg.main));
  const mod = await import(pathToFileURL(path.join(ROOT, pkg.main)).href);
  assert.strictEqual(typeof mod.apply, 'function');
  assert.ok(Array.isArray(mod.inject));
  assert.ok(mod.inject.includes('tools'));
});

test('收录：README 含安装命令、一句话价值、兼容与权限说明', () => {
  const readme = read('README.md');
  assert.match(readme, /dsh plugin --profile web add dsh-plugin-harness-cli/);
  assert.match(readme, /dsh plugin --profile web add github:[A-Za-z0-9_.-]+\/dsh-plugin-harness-cli/);
  assert.match(readme, /一句话价值/);
  assert.match(readme, /兼容|运行要求/);
  assert.match(readme, /权限|外部服务/);
  assert.match(readme, /CC0-1\.0/);
});

test('收录：许可证文件与 CLI 入口存在', () => {
  assert.ok(exists('LICENSE'));
  assert.match(read('LICENSE'), /CC0 1\.0 Universal/);
  assert.ok(exists('plugin/bin/dsh-plugin-harness-cli.js'));
});
