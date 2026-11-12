'use strict';

/**
 * Codex 插件契约：清单、技能、市场索引与本地 MCP 服务必须形成一条可安装、可调用的链路。
 *
 * 这里重点验证消费者看到的行为：MCP 工具可列出、可执行，缺 root 不会误写插件目录。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const {execFileSync, spawn} = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'plugin', 'bin', 'dsh-plugin-harness-cli.js');
const MCP_SERVER = path.join(ROOT, 'plugin', 'codex-mcp.mjs');
const EXPECTED_TOOLS = [
  'harness_cli_agents',
  'harness_cli_check',
  'harness_cli_delete',
  'harness_cli_doctor',
  'harness_cli_init',
  'harness_cli_page',
  'harness_cli_plan',
  'harness_cli_progress',
  'harness_cli_review',
  'harness_cli_sql',
  'harness_cli_style',
  'harness_cli_ui',
  'harness_cli_ux',
  'harness_cli_wiki',
];

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hcli-codex-'));
}

function createMcpClient(t) {
  const child = spawn(process.execPath, [MCP_SERVER], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('error', (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  child.on('close', (code) => {
    const error = new Error(`MCP server exited before replying (code ${code})`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  const lines = readline.createInterface({input: child.stdout, crlfDelay: Infinity});
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  t.after(() => {
    lines.close();
    child.kill();
  });

  return {
    request(method, params) {
      const id = nextId++;
      const response = new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject});
      });
      child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
      return response;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method, params})}\n`);
    },
    stderr() {
      return stderr;
    },
  };
}

test('Codex 清单、技能、MCP 与 Git 市场相互引用', () => {
  const pkg = readJson('package.json');
  const core = readJson('plugin/package.json');
  const plugin = readJson('.codex-plugin/plugin.json');
  const mcp = readJson('.mcp.json');
  const marketplace = readJson('.agents/plugins/marketplace.json');

  assert.strictEqual(plugin.name, 'dsh-plugin-harness-cli');
  assert.strictEqual(plugin.version, pkg.version);
  assert.strictEqual(core.version, pkg.version);
  assert.strictEqual(plugin.license, pkg.license);
  assert.strictEqual(core.license, pkg.license);
  assert.strictEqual(plugin.skills, './skills/');
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'skills/harness-cli/SKILL.md')), true);
  assert.match(plugin.interface.privacyPolicyURL, /\/PRIVACY\.md$/);
  assert.match(plugin.interface.termsOfServiceURL, /\/TERMS\.md$/);
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'PRIVACY.md')), true);
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'TERMS.md')), true);

  const server = mcp.mcpServers['harness-cli'];
  assert.ok(server);
  assert.strictEqual(server.command, 'node');
  assert.deepStrictEqual(server.args, ['./plugin/codex-mcp.mjs']);
  assert.strictEqual(fs.existsSync(MCP_SERVER), true);

  const entry = marketplace.plugins.find((item) => item.name === plugin.name);
  assert.ok(entry, '市场索引必须包含当前插件');
  assert.deepStrictEqual(entry.source, {source: 'local', path: '.'});

  for (const required of ['.codex-plugin/**', '.agents/**', '.mcp.json', 'skills/**']) {
    assert.ok(pkg.files.includes(required), `根包 files 必须包含 ${required}`);
  }
  assert.strictEqual(pkg.main, 'plugin/cordis.mjs', 'Codex 支持不能改变 DSH 主入口');
});

test('Codex MCP 暴露 14 个与 DSH 同名的工具，并要求显式 root', async (t) => {
  const client = createMcpClient(t);
  const initialized = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {name: 'harness-cli-test', version: '1.0.0'},
  });
  client.notify('notifications/initialized');

  assert.match(initialized.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(initialized.capabilities.tools);
  assert.strictEqual(initialized.serverInfo.name, 'dsh-plugin-harness-cli');

  const listed = await client.request('tools/list', {});
  assert.deepStrictEqual(listed.tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  for (const tool of listed.tools) {
    assert.deepStrictEqual(tool.inputSchema.type, 'object');
    assert.ok(tool.inputSchema.required.includes('root'), `${tool.name} 必须显式要求 root`);
    assert.match(tool.inputSchema.properties.root.description, /绝对|absolute/i);
  }

  const missingRoot = await client.request('tools/call', {
    name: 'harness_cli_check',
    arguments: {},
  });
  assert.strictEqual(missingRoot.isError, true);
  assert.match(missingRoot.content[0].text, /root/);
  assert.strictEqual(client.stderr(), '');
});

test('Codex MCP 调用真实 check，返回 CLI 门禁结果', async (t) => {
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'init', '--preset', 'prototype', '--root', dir], {
    cwd: dir,
    stdio: 'pipe',
  });

  const client = createMcpClient(t);
  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {name: 'harness-cli-test', version: '1.0.0'},
  });
  client.notify('notifications/initialized');

  const result = await client.request('tools/call', {
    name: 'harness_cli_check',
    arguments: {root: dir},
  });

  assert.strictEqual(result.isError, false);
  assert.match(result.content[0].text, /合计 \d+ 项/);
  assert.match(result.content[0].text, /退出码 0/);
  assert.strictEqual(client.stderr(), '');
});
