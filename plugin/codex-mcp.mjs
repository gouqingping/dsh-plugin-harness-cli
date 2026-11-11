#!/usr/bin/env node

/**
 * Codex MCP 适配层。
 *
 * 只处理 MCP 行协议与工具封装；命令定义、参数生成和业务执行仍来自 `cordis.mjs`，
 * 因此 DSH 与 Codex 不会各有一套 Harness 规则。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {buildReport, runCli, TOOL_SPECS} from './cordis.mjs';

const SERVER_NAME = 'dsh-plugin-harness-cli';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const PACKAGE = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

const READ_ONLY = new Set(['check', 'doctor']);
const DESTRUCTIVE = new Set(['delete']);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({jsonrpc: '2.0', id, result});
}

function sendError(id, code, message) {
  send({jsonrpc: '2.0', id, error: {code, message}});
}

function toolError(message) {
  return {
    content: [{type: 'text', text: message}],
    isError: true,
  };
}

function withRequiredRoot(spec) {
  const required = Array.isArray(spec.parameters.required) ? spec.parameters.required : [];
  return {
    name: spec.toolName,
    title: spec.toolName,
    description: spec.description,
    inputSchema: {
      ...spec.parameters,
      required: [...new Set([...required, 'root'])],
      properties: {
        ...spec.parameters.properties,
        root: {
          ...spec.parameters.properties.root,
          description: '目标仓库的绝对路径（必需）；Codex MCP 不默认使用插件安装目录。',
        },
      },
    },
    annotations: {
      readOnlyHint: READ_ONLY.has(spec.command),
      destructiveHint: DESTRUCTIVE.has(spec.command),
      idempotentHint: READ_ONLY.has(spec.command),
      openWorldHint: false,
    },
  };
}

function resolveRequiredRoot(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {error: 'root is required. Pass the absolute path of the target repository.'};
  }
  if (!path.isAbsolute(value.trim())) {
    return {error: `root must be an absolute path: ${value}`};
  }
  const root = path.resolve(value.trim());
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return {error: `target directory does not exist: ${root}`};
  }
  if (!stat.isDirectory()) return {error: `target is not a directory: ${root}`};
  return {root};
}

async function callTool(params) {
  if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
    return {rpcError: 'tools/call requires a tool name'};
  }

  const spec = TOOL_SPECS.find((item) => item.toolName === params.name);
  if (!spec) return {rpcError: `Unknown tool: ${params.name}`};

  const input = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const resolved = resolveRequiredRoot(input.root);
  if (resolved.error) return {result: toolError(resolved.error)};

  try {
    const argv = spec.buildArgs(input);
    const run = await runCli(argv, {
      cwd: resolved.root,
      timeoutMs: spec.timeoutMs,
    });
    return {
      result: {
        content: [{type: 'text', text: buildReport(run)}],
        structuredContent: {
          root: resolved.root,
          command: spec.command,
          args: argv,
          exitCode: run.exitCode,
          ok: run.exitCode === 0,
        },
        isError: run.exitCode !== 0,
      },
    };
  } catch (error) {
    return {
      result: toolError(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function handleRequest(message) {
  const {id, method, params} = message;

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion:
        typeof params?.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
      capabilities: {tools: {listChanged: false}},
      serverInfo: {name: SERVER_NAME, version: PACKAGE.version},
      instructions:
        'Use the harness_cli_* tools to initialize and check a project. Always pass the absolute target repository root. ' +
        'Prefer dry_run first, ask the user whether to use manual mode or automatic loop before changing a project, ' +
        'and obtain explicit confirmation before force, confirm, or delete operations.',
    });
    return;
  }

  if (method === 'ping') {
    sendResult(id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, {tools: TOOL_SPECS.map(withRequiredRoot)});
    return;
  }

  if (method === 'tools/call') {
    const called = await callTool(params);
    if (called.rpcError) {
      sendError(id, JSON_RPC.INVALID_PARAMS, called.rpcError);
    } else {
      sendResult(id, called.result);
    }
    return;
  }

  if (id !== undefined) sendError(id, JSON_RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
}

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.on('line', (line) => {
  if (line.trim().length === 0) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    sendError(null, JSON_RPC.PARSE_ERROR, `Invalid JSON: ${error.message}`);
    return;
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    sendError(null, JSON_RPC.INVALID_REQUEST, 'Request must be a JSON object');
    return;
  }

  if (message.method === undefined) return;
  void handleRequest(message).catch((error) => {
    if (message.id !== undefined) {
      sendError(message.id, JSON_RPC.INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    }
  });
});
