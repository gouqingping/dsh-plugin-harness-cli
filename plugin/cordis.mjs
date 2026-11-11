/**
 * DSH（cordis）适配层：把本 CLI 作为**工具**导入 DSH，让模型直接调用 `init / check / agents / doctor / style`。
 *
 * 三条设计约束：
 * - 单一真源：判定与文案仍在 `src/` 与 `templates/`。这里只做「解析参数 → 起子进程跑 `bin/` →
 *   把 stdout/stderr 与退出码交回」，所以工具行为与命令行永远一致，不存在第二份实现。
 * - 只读的仍然只读：`check` / `doctor` 不写盘；写入只发生在 `init`。
 * - 退出码原样透传：0 通过 / 1 有违规 / 2 工具或配置坏了，与 `harness-style` 对齐。
 *
 * 两个宿主细节：
 * - DSH 桌面端是 Electron，`process.execPath` 指向应用本体而不是 node；子进程必须带
 *   `ELECTRON_RUN_AS_NODE=1` 才会被当作 node 执行。
 * - 目标仓库统一用子进程的 `cwd` 指定，不传 `--root`：`style` 是原样透传给 harness-style 的，
 *   它不认 `--root`，用 cwd 才能让所有子命令（含 style）落在同一个仓库。
 *
 * 依赖：零运行时依赖，只用 `node:` 内置模块。
 *
 * @module dsh-plugin-harness-cli/cordis
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createTodoBridge } = require('./src/todo-bridge.js');
const { loadConfig } = require('./src/config.js');
const {
  collectTasks,
  refreshPlans,
  resetTask,
  readTaskMode,
  writeTaskMode,
} = require('./src/plans.js');

/** Cordis 插件标识（与 `cordis.patch.yml` 里的 `id` 对应）。 */
export const name = 'harness-cli';

/** 需要工具注册表就绪后才 apply。 */
export const inject = ['tools'];

/** 被适配的 CLI 入口。 */
const BIN = fileURLToPath(
  new URL('./bin/dsh-plugin-harness-cli.js', import.meta.url),
);

const DEFAULT_TIMEOUT_MS = 120_000;
const STYLE_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** 退出码的固定含义，与 CLI 文档一致。 */
const EXIT_MEANING = {
  0: '通过',
  1: '有违规（可预期失败）',
  2: '工具或用法有错',
};

/** 模型可见的统一输出结构。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['root', 'command', 'args', 'exitCode', 'ok', 'report'],
  properties: {
    root: {
      type: 'string',
      description: '本次运行的目标仓库根目录（子进程 cwd）。',
    },
    command: {
      type: 'string',
      description:
        '执行的子命令，例如 init / check / page / sql / delete / doctor。',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description: '透传给 CLI 的完整参数。',
    },
    exitCode: {
      type: 'integer',
      description: '0 通过 / 1 有违规 / 2 工具或配置坏了。',
    },
    ok: { type: 'boolean', description: 'exitCode === 0。' },
    report: {
      type: 'string',
      description: 'CLI 的完整输出（stdout + stderr）与退出码说明。',
    },
  },
};

/**
 * 子进程环境：关掉颜色（输出是纯文本），Electron 下让可执行文件以 node 身份运行。
 * @returns {NodeJS.ProcessEnv} 子进程环境变量。
 */
function childEnv() {
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  // Electron 的 process.execPath 是应用本体，只有这个变量能让它按 node 执行脚本。
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

/**
 * 解析目标仓库根目录：显式参数优先，否则用当前 Session 的工作目录。
 * @param {unknown} explicit - 工具参数 `root`。
 * @param {string | undefined} cwd - Session 工作目录。
 * @returns {{root: string} | {error: string}} 解析结果或面向调用者的拒绝原因。
 */
function resolveRoot(explicit, cwd) {
  if (
    explicit !== undefined &&
    explicit !== null &&
    typeof explicit !== 'string'
  ) {
    return { error: '`root` 必须是字符串' };
  }
  const trimmed = typeof explicit === 'string' ? explicit.trim() : '';
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
  if (trimmed.length > 0)
    return { root: path.resolve(base ?? process.cwd(), trimmed) };
  if (base === undefined || base === path.parse(base).root) {
    return {
      error:
        '当前 Session 没有有效的工作目录，请显式传入 `root`（例如目标仓库的绝对路径）',
    };
  }
  return { root: base };
}

/**
 * 目录必须真实存在，否则给出人话错误（而不是让子进程报 ENOENT）。
 * @param {string} root - 目标仓库根目录。
 */
function assertDirectory(root) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error(
      `目标目录不存在：${root}（如果这是任务名，请用 /harness-cli-ui <任务名>，目录会自动创建）`,
    );
  }
  if (!stat.isDirectory()) throw new Error(`目标不是目录：${root}`);
}

/**
 * 起子进程跑 CLI，收集输出与退出码。
 * @param {string[]} args - 透传给 CLI 的参数。
 * @param {{cwd: string, signal?: AbortSignal, timeoutMs?: number}} options - 运行选项。
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>} 运行结果。
 */
function runCli(args, options) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        cwd: options.cwd,
        env: childEnv(),
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        // 取消不是失败：原样抛给 DSH，让会话按「已取消」处理。
        if (error && error.name === 'AbortError') {
          reject(error);
          return;
        }
        const exitCode =
          error === null ? 0 : typeof error.code === 'number' ? error.code : 2;
        const out = String(stdout ?? '');
        let err = String(stderr ?? '');
        // 进程根本没起来（ENOENT / 超时被杀）时 stderr 是空的，用 error.message 补上原因。
        if (
          err.length === 0 &&
          exitCode !== 0 &&
          error &&
          typeof error.message === 'string'
        ) {
          err = `${error.message}\n`;
        }
        resolve({ exitCode, stdout: out, stderr: err });
      },
    );
  });
}

/**
 * 拼出模型看到的报告文本：CLI 原始输出 + 退出码说明。
 *
 * 刻意不加标题行：每个子命令自己会打印「check → <root>」这类抬头，再套一层只会重复。
 * @param {{exitCode: number, stdout: string, stderr: string}} run - 子进程结果。
 * @returns {string} 报告文本。
 */
function buildReport(run) {
  const lines = [];
  const out = run.stdout.replace(/\s+$/, '');
  const err = run.stderr.replace(/\s+$/, '');
  if (out) lines.push(out);
  if (err) lines.push(err);
  lines.push(
    `退出码 ${run.exitCode}：${EXIT_MEANING[run.exitCode] ?? '未知退出码'}`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * 把一个选择结果立即追加成对话里的用户消息，但不唤醒新的模型回合。
 * 这样选择一完成就能在对话里看到，同时主命令仍由当前 handler 继续执行。
 */
function appendChoiceFeedback(exec, selected, custom) {
  const session = exec?.agent?.session;
  if (!session || typeof session.append !== 'function') return false;
  const picked = (Array.isArray(selected) ? selected : [])
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  const typed = typeof custom === 'string' ? custom.trim() : '';
  const text =
    picked.length > 0
      ? `已选择：${picked.join('、')}${typed ? `；补充：${typed}` : ''}`
      : typed
        ? `已输入：${typed}`
        : '已选择：跳过';
  try {
    session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
      { surfaceOp: 'append' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 用宿主的 userQuestions 服务弹选择框，并等用户点选。
 * 没有可用 UI（子会话、无连接的客户端）时返回 null，调用方退化为非交互行为。
 * @param {any} ctx - Cordis 上下文。
 * @param {any} exec - 工具执行上下文（含 agent 与 signal）。
 * @param {{header: string, question: string, options: Array<{label: string, description?: string}>}} ask - 问题。
 * @returns {Promise<string|null>} 选中的标签；取消、超时或没有 UI 时 null。
 */
async function askChoice(ctx, exec, ask, onError) {
  const service =
    ctx && typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined;
  if (!service || typeof service.ask !== 'function') return null;
  try {
    const answer = await service.ask({
      questions: [
        {
          id: 'harness-cli',
          header: ask.header,
          question: ask.question,
          ...(Array.isArray(ask.options) && ask.options.length > 0
            ? {
                options: ask.options.map((item) => ({
                  label: item.label,
                  description: item.description,
                })),
              }
            : {}),
        },
      ],
      ...(exec && exec.agent ? { agent: exec.agent } : {}),
      ...(exec && exec.signal ? { signal: exec.signal } : {}),
    });
    const item = (
      answer && Array.isArray(answer.answers) ? answer.answers : []
    ).find((entry) => entry && entry.id === 'harness-cli');
    if (!item) return null;
    if (Array.isArray(item.selected) && item.selected.length > 0) {
      appendChoiceFeedback(exec, item.selected, item.custom);
      return item.selected[0];
    }
    const custom = typeof item.custom === 'string' ? item.custom.trim() : '';
    appendChoiceFeedback(exec, [], custom);
    return custom.length > 0 ? custom : null;
  } catch (err) {
    if (typeof onError === 'function') onError(err);
    return null;
  }
}

/**
 * 多选版 askChoice：一个问题里勾选多个标签，返回全部选中项。
 * 与单选一样，没有可用 UI 时返回 null，调用方退化为非交互行为。
 * @param {any} ctx - Cordis 上下文。
 * @param {any} exec - 工具执行上下文（含 agent 与 signal）。
 * @param {{header: string, question: string, options: Array<{label: string, description?: string}>}} ask - 问题。
 * @returns {Promise<{selected: string[], custom: string}|null>} 选中标签与补充输入；取消、超时或没有 UI 时 null。
 */
async function askMultiChoice(ctx, exec, ask, onError) {
  const service =
    ctx && typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined;
  if (!service || typeof service.ask !== 'function') return null;
  try {
    const answer = await service.ask({
      questions: [
        {
          id: 'harness-cli',
          header: ask.header,
          question: ask.question,
          multiSelect: true,
          ...(Array.isArray(ask.options) && ask.options.length > 0
            ? {
                options: ask.options.map((item) => ({
                  label: item.label,
                  description: item.description,
                })),
              }
            : {}),
        },
      ],
      ...(exec && exec.agent ? { agent: exec.agent } : {}),
      ...(exec && exec.signal ? { signal: exec.signal } : {}),
    });
    const item = (
      answer && Array.isArray(answer.answers) ? answer.answers : []
    ).find((entry) => entry && entry.id === 'harness-cli');
    if (!item) return null;
    const selected = (Array.isArray(item.selected) ? item.selected : [])
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());
    const custom = typeof item.custom === 'string' ? item.custom.trim() : '';
    appendChoiceFeedback(exec, selected, custom);
    return { selected, custom };
  } catch (err) {
    if (typeof onError === 'function') onError(err);
    return null;
  }
}

/** 去掉 wiki 的模式参数，再按用户的选择补一个。 */
function withWikiMode(argv, mode) {
  return [
    ...argv.filter((arg) => !['--ask', '--keep', '--update'].includes(arg)),
    mode,
  ];
}

/**
 * 构造一个模型可调用的工具定义（原生 ToolDefinition，不依赖 `defineTool`，保持零依赖）。
 * @param {object} spec - 工具规格。
 * @param {string} spec.toolName - 模型可见的工具名。
 * @param {string} spec.command - 子命令名。
 * @param {string} spec.description - 模型可见描述。
 * @param {object} spec.parameters - object 根 JSON Schema。
 * @param {(args: Record<string, unknown>) => string[]} spec.buildArgs - 由参数生成 CLI 参数。
 * @param {number} [spec.timeoutMs] - 子进程超时。
 * @param {Function} [spec.decide] - 执行前的决策钩子（可弹窗，返回新 argv 或取消）。
 * @param {Function} [spec.after] - 执行后的决策钩子（例如 wiki 冲突，可带新 argv 重跑）。
 * @param {any} [ctx] - Cordis 上下文，用于弹窗服务。
 * @returns {object} 可交给 `ctx.tools.register` 的定义。
 */
function buildTool(spec, ctx) {
  return {
    name: spec.toolName,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const input = args ?? {};
      const resolved = resolveRoot(
        input.root,
        exec?.agent?.session?.header?.cwd,
      );
      if (resolved.error) throw new Error(resolved.error);
      assertDirectory(resolved.root);

      let argv = spec.buildArgs(input);
      if (typeof spec.decide === 'function') {
        const decision = await spec.decide({
          ctx,
          exec,
          input,
          root: resolved.root,
          argv,
        });
        if (decision && decision.cancelled) {
          return {
            root: resolved.root,
            command: spec.command,
            args: argv,
            exitCode: 1,
            ok: false,
            report: `${decision.report || '已取消'}\n`,
          };
        }
        if (decision && Array.isArray(decision.argv)) argv = decision.argv;
      }

      let run = await runCli(argv, {
        cwd: resolved.root,
        signal: exec?.signal,
        timeoutMs: spec.timeoutMs,
      });
      if (typeof spec.after === 'function') {
        const next = await spec.after({
          ctx,
          exec,
          input,
          root: resolved.root,
          argv,
          run,
        });
        if (next && Array.isArray(next.argv)) {
          argv = next.argv;
          run = await runCli(argv, {
            cwd: resolved.root,
            signal: exec?.signal,
            timeoutMs: spec.timeoutMs,
          });
        }
      }
      return {
        root: resolved.root,
        command: spec.command,
        args: argv,
        exitCode: run.exitCode,
        ok: run.exitCode === 0,
        report: buildReport(run),
      };
    },
  };
}

/** 覆盖已有文件的确认：force 类操作一律先弹窗，用户点「覆盖」才继续。 */
async function confirmOverwrite(ctx, exec, what) {
  const answer = await askChoice(ctx, exec, {
    header: '覆盖确认',
    question: `${what} 会覆盖已存在的文件，原内容将被替换。确认继续？`,
    options: [
      { label: '覆盖', description: '按本次参数覆盖已存在的文件' },
      { label: '取消', description: '保留原文件，什么都不做' },
    ],
  });
  // 没有可用 UI 时不改变既有行为（模型已显式要求覆盖）
  return answer === null ? true : answer === '覆盖';
}

const DELETE_DESCRIPTION =
  'Delete one task workspace: prototype/<task>/ (progress page, plan, ui design, db design) and docs/specs/<task>/ ' +
  '(proposal, spec, design, tasks, review, database.md, schema.sql, er.mmd), then refresh plans.html and ' +
  'prototype/progress.html. Irreversible. Without `yes` the tool shows a confirmation dialog; if no dialog is ' +
  'available it refuses and asks the user to run the CLI with --yes.';

/** 每个工具共用的 `root` 参数。 */
const ROOT_PROPERTY = {
  type: 'string',
  description: '目标仓库根目录；省略时使用当前 Session 的工作目录。',
};

const CHECK_DESCRIPTION =
  'Read-only gate: validate a repository against the Harness Engineering rules — AGENTS.md sections and links, ' +
  'init.sh / scripts/gate.sh skeleton, docs/feature_list.json (in-progress count within wipLimit, evidence for done ' +
  'items), parallel-task claims (C2xx: every in-progress task claimed, scopes not overlapping), ' +
  'version notes, .gitignore rules, and optional task progress pages. Never writes. ' +
  'Exit code 0 = pass, 1 = violations, 2 = the tool or its configuration is broken. ' +
  'Run it before reporting work as done, or right after `harness_cli_init` to see what still needs filling in.';

const INIT_DESCRIPTION =
  'Scaffold the Harness Engineering skeleton into a repository: AGENTS.md, init.sh, scripts/gate.sh, ' +
  'docs/feature_list.json, claude-progress.md, task_queue.json, docs/current.md, scripts/claim.js (parallel-task ' +
  'claiming) with docs/claims/README.md, a CI skeleton, .gitignore rules, optionally a task-progress-page preset. ' +
  'Existing non-empty files are never overwritten unless `force` is true; ' +
  'state files (feature list, progress log, current.md, task queue) are never overwritten even with `force`. ' +
  'Writes files: pass `dry_run` first to preview the plan.';

const PAGE_DESCRIPTION =
  'Create a task workspace: writes prototype/<task>/progress.html and the four spec documents ' +
  'docs/specs/<task>/{proposal,spec,design,tasks}.md, then refreshes prototype/progress.html. ' +
  'The generated page is a skeleton (DDD domain / SDD contracts / TDD cases / numbered plan) that fails ' +
  '`check` until filled in. Idempotent: an existing page is never overwritten without `force`, and missing ' +
  'spec documents are filled in for an existing task. Task names may be ASCII kebab-case or Chinese (e.g. 登录页面).';

const REVIEW_DESCRIPTION =
  'Review a task before it starts: runs the project gate against docs/specs/<task>/*.md and the task page, then ' +
  'writes docs/specs/<task>/review.md with a fingerprint of the four documents and the failures found. Humans may ' +
  'edit the documents afterwards; the review must be re-run, then the plan confirmed (plan confirm=true by="who"), ' +
  'and only then may progress be written.';

const PLAN_DESCRIPTION =
  'Create or confirm the plan page for one task: prototype/<task>/plan.html. The plan states the goal, the ' +
  'approach (DDD boundary + SDD contracts), the page design (when the task has UI), the flow/interaction ' +
  'design, risks, and acceptance criteria. Confirmation is OPTIONAL and requires a passed review whose ' +
  'fingerprint matches the current docs/specs/<task>/*.md; after confirmation any document edit invalidates it. ' +
  'With confirm=true the tool pops a chooser before confirming. Progress does NOT require confirmation: ' +
  'P21/P22 still fail `check`, but they never block `progress`.';

const PROGRESS_DESCRIPTION =
  'The only write path for task progress. Updates one step percentage (step + pct), and/or the task status ' +
  '(进行中 / 待验收 / 完成), appends a dated progress entry, recomputes the total, and re-syncs ' +
  'prototype/progress.html. It always writes, even when the plan is not confirmed: P21/P22 remain `check` ' +
  'failures to be resolved before delivery, but they never block recording. ' +
  'Every call is recorded, so the page never silently misses a step change.';

const UI_DESCRIPTION =
  'Generate or refresh the UI design for one task: prototype/<task>/ui/index.html (offline static HTML in ' +
  'Ant Design v5 style — antd design tokens, Layout/Sider, PageHeader, Statistic cards, Table with Tag/Progress/' +
  'Pagination, Descriptions, Form, and empty/loading/error states) plus ui/README.md (page goal, component list, ' +
  'states, contract mapping, responsive rules). Creates the task page and spec docs first if they do not exist. ' +
  'All UI must follow antd; a second design system fails the P20 gate. Existing files are kept unless `force`.';

const SQL_DESCRIPTION =
  'Generate or refresh the database design for one task. Ensures docs/specs/<task>/schema.sql (DDL, the single ' +
  'source of truth) and docs/specs/<task>/database.md exist; parses schema.sql; lints it against Google ' +
  'data-modeling rules (snake_case names, primary key on every table, foreign keys with leading indexes, 3NF, ' +
  'numeric money, timestamptz, created_at/updated_at); then regenerates docs/specs/<task>/er.mmd (Mermaid ER) ' +
  'and prototype/<task>/db/index.html (offline ER diagram + relationship/field descriptions). Exit 1 when ' +
  'schema.sql is still empty or has lint errors — fix schema.sql, then call it again until it passes.';

const WIKI_DESCRIPTION =
  'Generate or refresh docs/wiki (13 business-facing documents: one-page overview, deployment, roles, flows, ' +
  'feature list, states and rules, conventions, quality gates, acceptance, risks, glossary, manual, README). ' +
  'The body is plain business language: no commands, code blocks or field names; unknown business facts are ' +
  'marked "待业务确认" and listed as gaps for you to backfill from the workspace. ' +
  'Scans the repository and writes only the managed block of each file; human text outside it is never touched. ' +
  'A pre-existing document without a managed block is "adoptable": mode "auto" adds the block and keeps its ' +
  'original text verbatim; mode "ask" reports it and exits 1. ' +
  'Domain drill-down pages are only created for dirs that declare a business "name" in the config. ' +
  'mode defaults to "ask"; check=true only reports missing/stale/adoptable/conflicting files.';

const AGENTS_DESCRIPTION =
  'Regenerate AGENTS.md from harness-cli.json, which is the single source of truth; never hand-edit AGENTS.md. ' +
  'Reports the resulting line count — over 100 lines warns, over 120 fails (split details into docs/ and leave links). ' +
  'Use it after editing harness-cli.json.';

const DOCTOR_DESCRIPTION =
  'Self-check the tool itself: Node version, template completeness, configuration validity, writability, ' +
  'git repository, and python3 availability. Read-only. Exit code 2 means this tool is broken — fix that first ' +
  'instead of editing project files.';

const STYLE_DESCRIPTION =
  'Google-style code and commit-message gate backed by the bundled harness-style (Python). ' +
  'Arguments are forwarded verbatim: args=["check","--staged"], ["fix","--staged"], ["doctor"], ' +
  '["commit-msg","<msg-file>"], ["init","--lang","py,ts"], ["install-hooks"]. Requires python3 on the machine. ' +
  'Exit code 0 = pass, 1 = violations, 2 = tool or environment problem.';

/** 工具定义：每个工具对应一个 CLI 子命令，DSH 与 Codex 复用同一份。 */
const TOOL_SPECS = [
  {
    toolName: 'harness_cli_check',
    command: 'check',
    description: CHECK_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        root: ROOT_PROPERTY,
        strict: {
          type: 'boolean',
          description: '把警告也当作失败（默认 false）。',
        },
      },
    },
    buildArgs: (input) => [
      'check',
      ...(input.strict === true ? ['--strict'] : []),
    ],
  },
  {
    toolName: 'harness_cli_init',
    command: 'init',
    description: INIT_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        root: ROOT_PROPERTY,
        preset: {
          type: 'string',
          enum: ['prototype'],
          description:
            '额外启用 preset：`prototype` = 一个任务一张进度页，总进度按步骤百分比汇总。',
        },
        force: {
          type: 'boolean',
          description:
            '覆盖已存在的非空结构文件（状态文件仍不覆盖）。默认 false。',
        },
        force_state: {
          type: 'boolean',
          description:
            '连同状态文件（进度日志 / 功能清单 / 任务队列）一起覆盖，慎用。默认 false。',
        },
        dry_run: {
          type: 'boolean',
          description: '只打印将发生的动作，不落盘。',
        },
      },
    },
    buildArgs: (input) => [
      'init',
      ...(typeof input.preset === 'string' ? ['--preset', input.preset] : []),
      ...(input.force === true ? ['--force'] : []),
      ...(input.force_state === true ? ['--force-state'] : []),
      ...(input.dry_run === true ? ['--dry-run'] : []),
    ],
    decide: async ({ ctx, exec, input }) => {
      if (input.force !== true && input.force_state !== true) return null;
      const ok = await confirmOverwrite(ctx, exec, 'init --force');
      return ok
        ? null
        : { cancelled: true, report: '已取消覆盖：现有文件保持不变' };
    },
  },
  {
    toolName: 'harness_cli_page',
    command: 'page',
    description: PAGE_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        root: ROOT_PROPERTY,
        task: {
          type: 'string',
          description:
            '任务名（支持中文，例如 登录页面 或 login-flow），同时是 prototype/ 与 docs/specs/ 下的目录名。',
        },
        user_words: {
          type: 'string',
          description: '用户原话（不要转述），会写进任务页与提案文档。',
        },
        force: {
          type: 'boolean',
          description: '覆盖已存在的任务页（默认 false）。',
        },
        dry_run: {
          type: 'boolean',
          description: '只打印将写入的文件，不落盘。',
        },
      },
    },
    buildArgs: (input) => {
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (task.length === 0)
        throw new Error('`task` 不能为空，例如 "login-flow"');
      return [
        'page',
        task,
        ...(typeof input.user_words === 'string'
          ? ['--user-words', input.user_words]
          : []),
        ...(input.force === true ? ['--force'] : []),
        ...(input.dry_run === true ? ['--dry-run'] : []),
      ];
    },
    decide: async ({ ctx, exec, input }) => {
      if (input.force !== true) return null;
      const ok = await confirmOverwrite(
        ctx,
        exec,
        `page ${typeof input.task === 'string' ? input.task : ''}`,
      );
      return ok
        ? null
        : { cancelled: true, report: '已取消覆盖：现有任务页保持不变' };
    },
  },
  {
    toolName: 'harness_cli_wiki',
    command: 'wiki',
    description: WIKI_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        root: ROOT_PROPERTY,
        mode: {
          type: 'string',
          enum: ['ask', 'auto', 'keep'],
          description:
            'ask = 冲突时报告并退出 1（由你询问用户后再决定）；auto = 覆盖受管区块；keep = 保留人工内容，只补缺失文件。',
        },
        check: {
          type: 'boolean',
          description:
            '只报告缺失 / 过期 / 冲突，不写盘（适合门禁或交付前检查）。',
        },
        dry_run: {
          type: 'boolean',
          description: '只打印将发生的动作，不落盘。',
        },
      },
    },
    buildArgs: (input) => [
      'wiki',
      ...(input.check === true ? ['--check'] : []),
      ...(input.mode === 'auto'
        ? ['--update']
        : input.mode === 'keep'
          ? ['--keep']
          : ['--ask']),
      ...(input.dry_run === true ? ['--dry-run'] : []),
    ],
    after: async ({ ctx, exec, input, argv, run }) => {
      // 只有「默认模式遇到冲突」才需要人决策；--dry-run / --check 与显式模式都不打断
      if (input.check === true || input.dry_run === true) return null;
      if (input.mode === 'auto' || input.mode === 'keep') return null;
      const text = `${run.stdout || ''}${run.stderr || ''}`;
      if (run.exitCode !== 1 || !/待接管|冲突/.test(text)) return null;
      const answer = await askChoice(ctx, exec, {
        header: '业务 wiki 冲突',
        question:
          'docs/wiki 里有文档没有受管区块，或受管区块被改过。要怎么处理？' +
          '（接管 = 补区块并原样保留正文；只补缺失 = 完全不动已有文件）',
        options: [
          {
            label: '接管既有文档',
            description: '补上受管区块，人工正文一字不改，之后可增量更新',
          },
          {
            label: '只补缺失文件',
            description: '已有文件保持原样，只创建缺的文档',
          },
          { label: '取消', description: '什么都不做，退出码保持 1' },
        ],
      });
      if (answer === '接管既有文档')
        return { argv: withWikiMode(argv, '--update') };
      if (answer === '只补缺失文件')
        return { argv: withWikiMode(argv, '--keep') };
      if (answer === '取消') return null;
      return null; // 没有 UI：保持退出码 1，让人在命令行决定
    },
  },
  {
    toolName: 'harness_cli_review',
    command: 'review',
    description: REVIEW_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        root: ROOT_PROPERTY,
        task: { type: 'string', description: '任务名（支持中文）。' },
        agent: {
          type: 'string',
          description: '复盘执行者标识，写进 review.md。',
        },
        dry_run: { type: 'boolean', description: '只打印将发生的事，不落盘。' },
      },
    },
    buildArgs: (input) => {
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      return [
        'review',
        ...(task.length > 0 ? [task] : []),
        ...(typeof input.agent === 'string' ? ['--agent', input.agent] : []),
        ...(input.dry_run === true ? ['--dry-run'] : []),
      ];
    },
  },
  {
    toolName: 'harness_cli_plan',
    command: 'plan',
    description: PLAN_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        root: ROOT_PROPERTY,
        task: {
          type: 'string',
          description: '任务名（支持中文），与任务页目录一致。',
        },
        confirm: {
          type: 'boolean',
          description:
            '把方案标记为「已确认」（会先弹窗让你点选；by 不填则记为「用户（弹窗确认）」）。',
        },
        by: {
          type: 'string',
          description: '确认人（会话/人名），确认时必填。',
        },
        user_words: {
          type: 'string',
          description: '用户原话，写进方案页与提案。',
        },
        goal: {
          type: 'string',
          description: '一句话目标（不填则由原话/任务名推导）。',
        },
        scope: { type: 'string', description: '做什么（范围）。' },
        context: { type: 'string', description: '限界上下文。' },
        non_goals: {
          type: 'array',
          items: { type: 'string' },
          description: '不做什么（非目标）。',
        },
        terms: {
          type: 'array',
          items: { type: 'string' },
          description: '统一语言，格式 "术语=定义"。',
        },
        contracts: {
          type: 'array',
          items: { type: 'string' },
          description: '契约，格式 "S-01|标题|输入|输出|错误语义|验收标准"。',
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: '任务规划，格式 "步骤标题|S-01"。',
        },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: '验收条目。',
        },
        input_json: {
          type: 'string',
          description: '完整内容模型（JSON 字符串），优先级最高。',
        },
        dry_run: {
          type: 'boolean',
          description: '只打印将写入的文件，不落盘。',
        },
      },
    },
    buildArgs: (input) => {
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      const many = (name, list) =>
        Array.isArray(list)
          ? list.flatMap((item) => [`--${name}`, String(item)])
          : [];
      return [
        'plan',
        ...(task.length > 0 ? [task] : []),
        ...(input.confirm === true ? ['--confirm'] : []),
        ...(typeof input.by === 'string' ? ['--by', input.by] : []),
        ...(typeof input.user_words === 'string'
          ? ['--user-words', input.user_words]
          : []),
        ...(typeof input.goal === 'string' ? ['--goal', input.goal] : []),
        ...(typeof input.scope === 'string' ? ['--scope', input.scope] : []),
        ...(typeof input.context === 'string'
          ? ['--context', input.context]
          : []),
        ...many('non-goal', input.non_goals),
        ...many('term', input.terms),
        ...many('contract', input.contracts),
        ...many('step', input.steps),
        ...many('accept', input.acceptance),
        ...(typeof input.input_json === 'string'
          ? ['--input-json', input.input_json]
          : []),
        ...(input.dry_run === true ? ['--dry-run'] : []),
      ];
    },
    after: async ({ exec, input, root, run }) => {
      if (
        run.exitCode !== 0 ||
        input.confirm === true ||
        input.dry_run === true
      )
        return null;
      const report = `${run.stdout || ''}${run.stderr || ''}`;
      const matched = /prototype\/([^/]+)\/plan\.html/.exec(report);
      const task =
        (typeof input.task === 'string' && input.task.trim()) ||
        (matched ? matched[1] : '');
      if (!task) return null;
      await kickOffPlan({ root, task, agent: exec?.agent });
      return null;
    },
    decide: async ({ ctx, exec, input, argv, root }) => {
      if (input.confirm !== true) return null;
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (task) {
        try {
          const { config } = loadConfig(root);
          if (readTaskMode(root, config, task) === 'auto') return null;
        } catch (err) {
          // 读不到模式就回到弹窗，不静默确认。
        }
      }
      const taskLabel = task || '最近的任务';
      const answer = await askChoice(ctx, exec, {
        header: '方案确认',
        question:
          `确认任务「${taskLabel}」的方案？确认后 check 的 P21 才会过；` +
          '取消则保持未确认，进度照样能记录。',
        options: [
          {
            label: '确认',
            description: '把方案标记为已确认，并记下当前文档指纹',
          },
          { label: '取消', description: '保持未确认；不影响记录进度' },
        ],
      });
      if (answer === null) return null; // 没有 UI：维持原行为（由 by 参数决定）
      if (answer !== '确认') {
        return {
          cancelled: true,
          report: '已取消方案确认：方案保持未确认，进度不受影响',
        };
      }
      if (typeof input.by === 'string' && input.by.trim().length > 0)
        return null;
      return { argv: [...argv, '--by', '用户（弹窗确认）'] };
    },
  },
  {
    toolName: 'harness_cli_progress',
    command: 'progress',
    description: PROGRESS_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        root: ROOT_PROPERTY,
        task: { type: 'string', description: '任务名（支持中文）。' },
        step: {
          type: 'integer',
          description: '第几步（从 1 开始），配合 pct 使用。',
        },
        pct: { type: 'integer', description: '该步骤的完成度 0..100。' },
        status: {
          type: 'string',
          enum: ['进行中', '待验收', '完成'],
          description: '任务状态。',
        },
        note: {
          type: 'string',
          description: '进度记录里的一句话说明；省略时自动生成。',
        },
        agent: {
          type: 'string',
          description: '操作人/会话标识，写进进度记录。',
        },
        dry_run: {
          type: 'boolean',
          description: '只打印将发生的动作，不落盘。',
        },
      },
    },
    buildArgs: (input) => {
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (task.length === 0)
        throw new Error('`task` 不能为空，例如 "登录页面"');
      return [
        'progress',
        task,
        ...(input.step !== undefined ? ['--step', String(input.step)] : []),
        ...(input.pct !== undefined ? ['--pct', String(input.pct)] : []),
        ...(typeof input.status === 'string' ? ['--status', input.status] : []),
        ...(typeof input.note === 'string' ? ['--note', input.note] : []),
        ...(typeof input.agent === 'string' ? ['--agent', input.agent] : []),
        ...(input.dry_run === true ? ['--dry-run'] : []),
      ];
    },
  },
  {
    toolName: 'harness_cli_ui',
    command: 'ui',
    description: UI_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        root: ROOT_PROPERTY,
        task: {
          type: 'string',
          description:
            '任务名（支持中文，例如 登录页面 或 login-flow），与任务页目录一致。',
        },
        user_words: {
          type: 'string',
          description: '用户原话；会写进设计稿的说明行。',
        },
        force: {
          type: 'boolean',
          description: '覆盖已存在的设计稿（默认保留人工修改）。',
        },
        dry_run: {
          type: 'boolean',
          description: '只打印将写入的文件，不落盘。',
        },
      },
    },
    buildArgs: (input) => {
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (task.length === 0)
        throw new Error('`task` 不能为空，例如 "login-flow"');
      return [
        'ui',
        task,
        ...(typeof input.user_words === 'string'
          ? ['--user-words', input.user_words]
          : []),
        ...(input.force === true ? ['--force'] : []),
        ...(input.dry_run === true ? ['--dry-run'] : []),
      ];
    },
    decide: async ({ ctx, exec, input }) => {
      if (input.force !== true) return null;
      const ok = await confirmOverwrite(
        ctx,
        exec,
        `ui ${typeof input.task === 'string' ? input.task : ''}`,
      );
      return ok
        ? null
        : { cancelled: true, report: '已取消覆盖：现有设计稿保持不变' };
    },
  },
  {
    toolName: 'harness_cli_sql',
    command: 'sql',
    description: SQL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        root: ROOT_PROPERTY,
        task: {
          type: 'string',
          description:
            '任务名（支持中文，例如 登录页面 或 login-flow），与任务页目录一致。',
        },
        dry_run: {
          type: 'boolean',
          description: '只打印将写入的文件，不落盘。',
        },
      },
    },
    buildArgs: (input) => {
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (task.length === 0)
        throw new Error('`task` 不能为空，例如 "login-flow"');
      return ['sql', task, ...(input.dry_run === true ? ['--dry-run'] : [])];
    },
  },
  {
    toolName: 'harness_cli_delete',
    command: 'delete',
    description: DELETE_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        root: ROOT_PROPERTY,
        task: {
          type: 'string',
          description: '要删除的任务名（支持中文），与任务页目录一致。',
        },
        yes: {
          type: 'boolean',
          description: '已确认删除。不填会先弹窗让用户选；用户取消则不删。',
        },
      },
    },
    buildArgs: (input) => {
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (task.length === 0)
        throw new Error('`task` 不能为空，例如 "login-flow"');
      return ['delete', task, ...(input.yes === true ? ['--yes'] : [])];
    },
    decide: async ({ ctx, exec, input, root }) => {
      if (input.yes === true) return null;
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      const answer = await askChoice(ctx, exec, {
        header: '删除任务',
        question:
          `删除任务「${task}」？会一并删除它的任务页、方案页、UI 设计稿、数据模型、规范文档与复盘，无法恢复。` +
          `（目录：prototype/${task}/、docs/specs/${task}/）`,
        options: [
          { label: '删除', description: '上述目录一并删除，随后刷新任务总览' },
          { label: '取消', description: '什么都不做' },
        ],
      });
      if (answer === '删除') return { argv: ['delete', task, '--yes'] };
      return {
        cancelled: true,
        report:
          answer === null
            ? `没有可用的确认弹窗：请让用户执行 dsh-plugin-harness-cli delete ${task} --yes，或给 yes=true 明确确认`
            : '已取消删除：任务保持原样',
      };
    },
  },
  {
    toolName: 'harness_cli_agents',
    command: 'agents',
    description: AGENTS_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        root: ROOT_PROPERTY,
        force: {
          type: 'boolean',
          description: '覆盖已存在的 AGENTS.md（默认只在缺失时写入）。',
        },
        dry_run: {
          type: 'boolean',
          description: '只打印将写入的内容，不落盘。',
        },
      },
    },
    buildArgs: (input) => [
      'agents',
      ...(input.force === true ? ['--force'] : []),
      ...(input.dry_run === true ? ['--dry-run'] : []),
    ],
  },
  {
    toolName: 'harness_cli_doctor',
    command: 'doctor',
    description: DOCTOR_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: { root: ROOT_PROPERTY },
    },
    buildArgs: () => ['doctor'],
  },
  {
    toolName: 'harness_cli_style',
    command: 'style',
    description: STYLE_DESCRIPTION,
    timeoutMs: STYLE_TIMEOUT_MS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['args'],
      properties: {
        root: ROOT_PROPERTY,
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            '原样转发给 harness-style 的参数，例如 ["check","--staged"]。',
        },
      },
    },
    buildArgs: (input) => {
      const rest = Array.isArray(input.args) ? input.args : [];
      if (rest.length === 0)
        throw new Error('`args` 不能为空，例如 ["check", "--staged"]');
      for (const item of rest) {
        if (typeof item !== 'string')
          throw new Error('`args` 的每一项都必须是字符串');
      }
      return ['style', ...rest];
    },
  },
];

/**
 * 解析斜杠命令的输入：`[root] [--root <dir>] [--strict] [--force] [--dry-run] [--preset <name>]`。
 * @param {string} rawInput - 命令名之后的文本。
 * @returns {{root?: string, strict?: boolean, force?: boolean, dryRun?: boolean, preset?: string, error?: string}} 解析结果。
 */
function parseCommandInput(rawInput) {
  const tokens =
    String(rawInput ?? '')
      .trim()
      .match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--force') {
      parsed.force = true;
    } else if (token === '--dry-run') {
      parsed.dryRun = true;
    } else if (token === '--strict') {
      parsed.strict = true;
    } else if (token === '--update' || token === '--auto') {
      parsed.update = true;
    } else if (token === '--keep') {
      parsed.keep = true;
    } else if (token === '--check') {
      parsed.checkNow = true;
    } else if (token === '--root' || token === '-r') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--root` 缺少路径参数' };
      parsed.root = value.replace(/^["']|["']$/g, '');
    } else if (token === '--preset') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--preset` 缺少取值' };
      parsed.preset = value;
    } else if (token === '--user-words') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--user-words` 缺少取值' };
      parsed.userWords = value.replace(/^["']|["']$/g, '');
    } else if (!token.startsWith('-') && parsed.root === undefined) {
      parsed.root = token;
    } else if (!token.startsWith('-') && parsed.task === undefined) {
      parsed.task = token.replace(/^["']|["']$/g, '');
    } else {
      return { error: `无法识别的参数：${token}` };
    }
  }
  return parsed;
}

/**
 * 跑一次命令并返回给人看的文本（斜杠命令共用）。
 * @param {'check' | 'init' | 'doctor'} command - 子命令。
 * @param {Record<string, unknown>} parsed - 已解析的命令输入。
 * @param {string | undefined} cwd - Session 工作目录。
 * @param {AbortSignal | undefined} signal - 取消信号。
 * @returns {Promise<{kind: 'success' | 'error', text: string}>} 命令结果。
 */
async function runCommand(command, parsed, cwd, signal) {
  const resolved = resolveRoot(parsed.root, cwd);
  if (resolved.error) return { kind: 'error', text: resolved.error };
  try {
    assertDirectory(resolved.root);
  } catch (error) {
    return { kind: 'error', text: error.message };
  }
  const argv = [
    command,
    ...(command === 'check' && parsed.strict === true ? ['--strict'] : []),
    ...(command === 'init' && typeof parsed.preset === 'string'
      ? ['--preset', parsed.preset]
      : []),
    ...(command === 'init' && parsed.force === true ? ['--force'] : []),
    ...(command === 'init' && parsed.dryRun === true ? ['--dry-run'] : []),
  ];
  const run = await runCli(argv, { cwd: resolved.root, signal });
  return {
    kind: run.exitCode === 0 ? 'success' : 'error',
    text: buildReport(run),
  };
}

/**
 * 目标目录不存在时：显式给了 --root 就主动创建（用户已经指明路径），否则报错并提示用法，
 * 避免把「任务名」误当成目录名建出来。
 * @param {string} root - 已解析的绝对路径。
 * @param {string | undefined} explicit - 调用方是否显式给了 --root。
 * @returns {{ok: true} | {error: string}}
 */
function ensureRootDir(root, explicit) {
  try {
    assertDirectory(root);
    return { ok: true };
  } catch (error) {
    if (!explicit) return { error: error.message };
    try {
      fs.mkdirSync(root, { recursive: true });
      return { ok: true };
    } catch (err) {
      return { error: `无法创建目录 ${root}：${err.message}` };
    }
  }
}

/**
 * 把自动消息直接送入当前执行流；只有不具备 steer 的旧宿主才兼容回退到下一轮队列。
 * @param {any} agent - CommandInvocation.agent。
 * @param {string} idPrefix - 消息 id 前缀。
 * @param {string} text - 消息正文。
 * @returns {boolean} 是否成功发送。
 */
function dispatchAgentMessage(agent, idPrefix, text) {
  const send =
    agent && typeof agent.steer === 'function'
      ? agent.steer.bind(agent)
      : agent && typeof agent.followup === 'function'
        ? agent.followup.bind(agent)
        : null;
  if (!send) return false;
  try {
    send({
      id: `${idPrefix}-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 解析「任务名在前」的命令输入：`<任务名> [--root <dir>] [--user-words "原话"] [--force] [--dry-run]`。
 * 与 parseCommandInput 的区别：第一个位置参数是任务名，不是仓库根目录。
 * @param {string} rawInput - 命令名之后的文本。
 * @returns {{task?: string, root?: string, userWords?: string, force?: boolean, dryRun?: boolean, error?: string}}
 */
function parseTaskInput(rawInput) {
  const tokens =
    String(rawInput ?? '')
      .trim()
      .match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--force') {
      parsed.force = true;
    } else if (token === '--dry-run') {
      parsed.dryRun = true;
    } else if (token === '--root' || token === '-r') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--root` 缺少路径参数' };
      parsed.root = value.replace(/^["']|["']$/g, '');
    } else if (token === '--confirm') {
      parsed.confirm = true;
    } else if (token === '--user-words') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--user-words` 缺少取值' };
      parsed.userWords = value.replace(/^["']|["']$/g, '');
    } else if (token === '--by') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--by` 缺少取值' };
      parsed.by = value.replace(/^["']|["']$/g, '');
    } else if (token === '--step') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--step` 缺少取值' };
      parsed.step = Number(value);
    } else if (token === '--pct') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--pct` 缺少取值' };
      parsed.pct = Number(value);
    } else if (token === '--status') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--status` 缺少取值' };
      parsed.status = value;
    } else if (token === '--note') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--note` 缺少取值' };
      parsed.note = value.replace(/^["']|["']$/g, '');
    } else if (token === '--agent') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--agent` 缺少取值' };
      parsed.agent = value.replace(/^["']|["']$/g, '');
    } else if (!token.startsWith('-') && parsed.task === undefined) {
      parsed.task = token.replace(/^["']|["']$/g, '');
    } else if (!token.startsWith('-') && parsed.root === undefined) {
      // 第二个位置参数当根目录，兼容 /harness-cli-ui <任务名> <目录>
      parsed.root = token;
    } else {
      return { error: `无法识别的参数：${token}` };
    }
  }
  return parsed;
}

/**
 * 解析「多个任务名」的输入：`<任务名...> [--root <dir>]`。
 * 用于 restart：一次重跑多个任务；省略任务名时由弹窗多选。
 * @param {string} rawInput - 命令名之后的文本。
 * @returns {{tasks: string[], root?: string, error?: string}} 解析结果。
 */
function parseTaskListInput(rawInput) {
  const tokens =
    String(rawInput ?? '')
      .trim()
      .match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const parsed = { tasks: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--root' || token === '-r') {
      const value = tokens[++index];
      if (value === undefined) return { error: '`--root` 缺少路径参数' };
      parsed.root = value.replace(/^["']|["']$/g, '');
    } else if (!token.startsWith('-')) {
      parsed.tasks.push(token.replace(/^["']|["']$/g, ''));
    } else {
      return { error: `无法识别的参数：${token}` };
    }
  }
  return parsed;
}

/**
 * 注册斜杠命令；`commands` 服务缺席时静默跳过（工具仍可用）。
 * @param {any} ctx - 带 `commands` 服务的 context。
 */
/** 斜杠命令手册：`/harness-cli-help` 的输出来源之一（与注册项保持同名，单测会校验）。 */
const COMMAND_MANUAL = [
  {
    name: 'harness-cli',
    usage: '/harness-cli [子指令] [参数...]',
    description:
      'Harness-CLI 指令总入口：省略子指令时弹窗选择；也可直接写子指令名',
  },
];

/** 聚合指令的子指令菜单：中文标签 → 子指令名（对应内部 leaf 定义）。 */
const SUBCOMMANDS = [
  { label: '初始化', sub: 'init' },
  { label: '校验', sub: 'check' },
  { label: '自检', sub: 'doctor' },
  { label: '建任务', sub: 'page' },
  { label: '方案', sub: 'plan' },
  { label: '复盘', sub: 'review' },
  { label: '推进度', sub: 'progress' },
  { label: '继续任务', sub: 'continue' },
  { label: '重跑任务', sub: 'restart' },
  { label: 'UI 设计', sub: 'ui' },
  { label: '数据库设计', sub: 'sql' },
  { label: '删除任务', sub: 'delete' },
  { label: '业务 wiki', sub: 'wiki' },
  { label: '任务总览', sub: 'plans' },
  { label: '入口地图', sub: 'agents' },
  { label: '帮助', sub: 'help' },
];

/** 任务标准流程（帮助里反复用到，单独一份）。 */
const WORKFLOW_TEXT = [
  '任务标准流程（顺序不能颠倒）：',
  '  0. 开工前先问用户：手动（每步等确认）还是自动 loop（自动推进、所有确认 / 选择走推荐项）',
  '  1. /harness-cli init                    生成骨架（默认带任务页能力）',
  '  2. /harness-cli ui <任务>               建任务页 + 四份规范文档 + 方案页；需要界面时生成 antd 设计稿',
  '  3. /harness-cli sql [任务...]           多选任务：按 Google 数模规范设计 schema 与 ER 数模图',
  '  4. 人改 docs/specs/<任务>/*.md       proposal / spec / design / tasks（可直接改）',
  '  5. /harness-cli review <任务>           Agent 复盘：文档与页面一致才通过，写 review.md（含文档指纹）',
  '  6. /harness-cli plan <任务> --confirm --by "确认人"   确认方案（可选；确认时弹窗点选，不确认也能记进度）',
  '  7. /harness-cli progress <任务> --step N --pct 0..100 推进度（自动追加记录 + 同步总览；P21 交给 check 在交付前拦）',
  '  8. /harness-cli continue [任务]                       选择未完成任务，从当前进度继续（不重做已完成步骤）',
  '  9. /harness-cli restart [任务...]                     多选任务重跑：进度归零、方案待确认，再从 Step 1 开始',
  ' 10. /harness-cli check 或项目门禁 gate.sh              校验 / 交付前门禁',
  ' 11. /harness-cli plans --serve                          打开总览操作台（删除 / 重跑 / 编辑 / UI 预览）',
  ' 12. /harness-cli delete [任务...]                       多选任务删除（含数据模型），进行中的任务立即停止（不可恢复）',
].join('\n');

/**
 * 生成帮助文本。
 * @param {string} topic - 可选：命令名 / 工具名，只显示那一条。
 * @returns {string} 帮助文本。
 */
function buildHelpText(topic) {
  const key = String(topic || '').trim();
  const tools = TOOL_SPECS.map((spec) => ({
    name: spec.toolName,
    description: spec.description,
  }));
  const commands = COMMAND_MANUAL;

  if (key.length > 0) {
    const command = commands.find(
      (item) =>
        item.name === key ||
        item.name === `harness-${key}` ||
        item.name === `harness-cli-${key}`,
    );
    if (command) {
      return [
        `/${command.name}`,
        `  用法：${command.usage}`,
        `  说明：${command.description}`,
        '',
        WORKFLOW_TEXT,
        '',
      ].join('\n');
    }
    const tool = tools.find(
      (item) => item.name === key || item.name === `harness_cli_${key}`,
    );
    if (tool) {
      const spec = TOOL_SPECS.find((item) => item.toolName === tool.name);
      const params =
        Object.keys((spec.parameters && spec.parameters.properties) || {}).join(
          ', ',
        ) || '无';
      return [
        `${tool.name}（对应子命令 ${spec.command}）`,
        `  参数：${params}`,
        `  说明：${tool.description}`,
        '',
      ].join('\n');
    }
    return `没有找到「${key}」。可用命令：${commands.map((item) => '/' + item.name).join(' ')}${'\n'}`;
  }

  const lines = [
    'harness-cli 操作说明',
    '',
    '做什么：把「项目怎么协作」写成文件，并让机器检查；任务从文档定稿 → 复盘 → 确认 → 推进度。',
    '',
    WORKFLOW_TEXT,
    '',
    `斜杠命令（${commands.length}）`,
    ...commands.map((item) => `  ${item.usage}\n      ${item.description}`),
    '',
    `子指令（${SUBCOMMANDS.length}）：`,
    ...SUBCOMMANDS.map((item) => `  /harness-cli ${item.sub}    ${item.label}`),
    '',
    `模型工具（${tools.length}，参数 root 省略时用当前会话工作目录）`,
    ...tools.map((item) => {
      const spec = TOOL_SPECS.find((entry) => entry.toolName === item.name);
      const params =
        Object.keys((spec.parameters && spec.parameters.properties) || {}).join(
          ', ',
        ) || '无';
      return `  ${item.name}（子命令 ${spec.command}）参数：${params}`;
    }),
    '',
    '命令行等价（在目标仓库目录）：',
    '  dsh-plugin-harness-cli init | page | plan | review | progress | ui | check | doctor | wiki | plans | style',
    '',
    '规则要点：',
    '  · 任务名支持中文（登录页面）与英文 kebab-case（login-flow）',
    '  · 方案未确认不能推进度；确认后 docs/specs 再改会失效（P22），需重新 review + confirm',
    '  · 进度只走 progress：自动追加记录、重算总进度、同步 prototype/progress.html',
    '  · 所有 UI 统一 antd v5；混入第二套设计体系会被 P20 拦',
    '  · 退出码：0 通过 / 1 有违规（含前置条件不满足）/ 2 工具或用法有错',
    '',
  ];
  return lines.join('\n');
}

/** 等待本机 plans 服务就绪（页面里带 data-plans 标记才算我们的服务）。 */
function waitForPlans(port, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  const attempt = () =>
    new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/', timeout: 800 },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () =>
            resolve(res.statusCode === 200 && text.includes('data-plans')),
          );
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });

  return (async () => {
    while (Date.now() < deadline) {
      if (await attempt()) return true;
      await new Promise((done) => setTimeout(done, 120));
    }
    return false;
  })();
}

/** 等新的 plans 子进程把自己的 pid 写进状态文件（避免把旧服务当成就绪）。 */
function waitForPlansPid(root, pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      const state = readPlansState(root);
      if (state && state.pid === pid) return true;
      await new Promise((done) => setTimeout(done, 100));
    }
    return false;
  })();
}

/** 读取 plans 服务状态（pid / port）。 */
function readPlansState(root) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, '.harness', 'plans-server.json'), 'utf8'),
    );
  } catch (err) {
    return null;
  }
}

/** 从参数或执行结果里取任务名（page/plan 完之后要拿它去问 UI）。 */
function firstTaskName(rest, text) {
  const head =
    String(rest || '')
      .trim()
      .split(/\s+/)[0] || '';
  if (isValidTaskName(head)) return head;
  const matched = /prototype\/([^/]+)\/(?:plan|progress)\.html/.exec(
    String(text || ''),
  );
  return matched ? matched[1] : '';
}

/** 与 CLI 的 isTaskName 保持一致：字母/数字/中文开头，只含字母数字中文中划线。 */
function isValidTaskName(value) {
  const name = String(value || '').trim();
  if (name.length === 0 || name.length > 64) return false;
  if (name.startsWith('.')) return false;
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(name);
}

/** ISO 时间 → 分钟级显示（选择框描述里用，避免整串毫秒占地方）。 */
function isoMinute(value) {
  const text = String(value || '');
  return text.length >= 16
    ? text.slice(0, 16).replace('T', ' ')
    : text || '尚未更新';
}

/** 任务 → 选择框选项：标签就是任务名，描述带状态与总进度。 */
function taskChoice(task) {
  return {
    label: task.name,
    description: `${task.status} · 总进度 ${task.total}% · ${isoMinute(task.updated)}`,
  };
}

/**
 * 读取任务列表（与 plans.html 同源）。
 * 配置坏了给可操作的错误，而不是静默当成「没有任务」。
 * @param {string} root - 仓库根目录。
 * @returns {{config: object, tasks: Array<object>} | {error: string}} 任务列表或错误。
 */
function readTaskList(root) {
  try {
    const { config } = loadConfig(root);
    return { config, tasks: collectTasks(root, config) };
  } catch (err) {
    return { error: `读取任务列表失败：${err.message}` };
  }
}

/** 找不到任务时列出可选项。 */
function taskListHint(tasks) {
  if (tasks.length === 0)
    return '仓库里还没有任务：先 /harness-cli page <任务名> 建一个。';
  return `现有任务：${tasks.map((task) => `${task.name}（${task.status}）`).join('、')}`;
}

/** 「继续任务」派发给 Agent 的执行说明：从当前进度接着做，不重做已完成步骤。 */
function continueTaskPrompt(task) {
  return [
    `继续任务「${task.name}」（由 /harness-cli continue 发起，不要只回复摘要）：`,
    `当前状态：${task.status}，总进度 ${task.total}%，最后更新 ${isoMinute(task.updated)}。`,
    `1. 读 prototype/${task.name}/progress.html 与 docs/specs/${task.name}/tasks.md，确认已完成到哪一步；`,
    '2. 从下一步继续，不要从 Step 1 重做，也不要改动已完成的步骤；',
    `3. 若方案还没确认，先跑 /harness-cli review ${task.name} 并完成方案确认，再继续实现；`,
    '4. 每完成一步调用 harness_cli_progress（step=N, pct=100）；失败的步骤如实说明原因；',
    '5. 需要用户拍板时用 ask_user_question 弹窗，不要自己替用户决定；',
    '6. 全部步骤完成后跑 harness_cli_check，再汇报结果。',
  ].join('\n');
}

/** 「数据库设计」派发给 Agent 的执行说明：按 Google 数模规范写 schema 并生成数模图。 */
function sqlTasksPrompt(tasks) {
  return [
    '数据库设计（由 /harness-cli sql 发起，不要只回复摘要）：',
    '为以下任务完成数据模型设计（Google 数模规范）：',
    ...tasks.map(
      (task, index) =>
        `  ${index + 1}. ${task.name}（${task.status} · ${task.total}%）`,
    ),
    '',
    '规范要点（完整版见 docs/specs/<任务>/database.md）：',
    '- 表名 / 字段名 snake_case，表名单数，避开 SQL 保留字；',
    '- 每张表必须有主键；外键列名 <被引用表>_id，并为外键建索引；',
    '- 至少 3NF；1:N 用外键，M:N 用中间表，1:1 用唯一约束；',
    '- 金额 numeric(19,4)，时间 timestamptz，布尔 boolean；核心表带 created_at / updated_at；',
    '- 业务规则写进 DDL（NOT NULL / UNIQUE / CHECK / FK），不用触发器实现业务逻辑；',
    '- 每张表写 COMMENT ON TABLE，每个字段写 COMMENT ON COLUMN（或行尾 -- 说明），关系要写清基数与业务含义。',
    '',
    '对每个任务：',
    '0. 如果 docs/specs/<任务>/schema.sql 或 database.md 已存在：按本次设计覆盖 / 更新，不要因为已存在就跳过；',
    '1. 读 docs/specs/<任务>/{proposal,spec,design,tasks}.md，提取实体、属性、关系与生命周期；',
    '2. 写 docs/specs/<任务>/schema.sql（真实 CREATE TABLE / 约束 / 索引 / COMMENT，不要只留注释）；',
    '3. 补全 docs/specs/<任务>/database.md 的「实体与关系 / 表设计 / 字段说明 / 索引 / 迁移」；',
    '4. 调用 harness_cli_sql（task=<任务>）生成 er.mmd、db/index.html 与整体数模图；',
    '5. 修掉 lint 的 error，确认 db/index.html 的「关系说明 / 字段说明」完整，再跑 harness_cli_check。',
  ].join('\n');
}

/** 「重跑任务」派发给 Agent 的执行说明：任务已重置，重新复盘确认后从 Step 1 开始。 */
function restartTasksPrompt(tasks) {
  return [
    '重跑任务（由 /harness-cli restart 发起，不要只回复摘要）：',
    '已重置：进度归零、方案回到「待确认」、复盘作废；文档与 UI 设计稿保留。',
    '要重跑的任务：',
    ...tasks.map(
      (task, index) =>
        `  ${index + 1}. ${task.name}（重跑前：${task.status} · ${task.total}%）`,
    ),
    '',
    '请逐个任务执行（把 <任务> 换成对应任务名）：',
    '1. 读 docs/specs/<任务>/{proposal,spec,design,tasks}.md，确认要做什么；',
    '2. 跑 /harness-cli review <任务>，再完成方案确认（/harness-cli plan <任务> --confirm --by "确认人"）；方案未确认前不要开始实现；',
    '3. 按 tasks.md 从 Step 1 开始执行，每完成一步调用 harness_cli_progress（step=N, pct=100）；失败的步骤如实说明原因；',
    '4. 需要用户拍板时用 ask_user_question 弹窗，不要自己替用户决定；',
    '5. 全部完成后跑 harness_cli_check，再汇报结果。',
  ].join('\n');
}

/**
 * page / plan 执行前先收集 UI 选项，选择结束后再开始任何文件写入。
 * 没有可用选择框时返回 false，保持非交互环境的旧行为：只执行主命令。
 */
async function askUiBeforeExecution(ctx, invocation, subName, rest) {
  const task = firstTaskName(rest, '');
  const picked = await askChoice(
    ctx,
    { agent: invocation?.agent, signal: invocation?.signal },
    {
      header: 'UI 设计',
      question: task
        ? `「${task}」要不要同时生成 UI 设计稿？`
        : `「${subName === 'page' ? '新任务' : '当前任务'}」要不要同时生成 UI 设计稿？`,
      options: [
        {
          label: '生成 UI 设计稿',
          description: '选择完成后，与主命令一起执行',
        },
        { label: '先不用', description: '只执行主命令' },
      ],
    },
  );
  return picked === '生成 UI 设计稿';
}

/**
 * page / plan 开工前先确定操作模式：
 * - 已有任务模式标记就复用，避免每次 plan 都重复问；
 * - 没有 UI / 用户取消时返回 null，不写标记（后续方案确认保持手动弹窗）。
 * @returns {Promise<'auto' | 'manual' | null>}
 */
async function askModeBeforeExecution(ctx, invocation, subName, rest) {
  const task = firstTaskName(rest, '');
  const resolved = resolveRoot(
    undefined,
    invocation?.agent?.session?.header?.cwd,
  );
  if (!resolved.error && task) {
    try {
      const { config } = loadConfig(resolved.root);
      const existing = readTaskMode(resolved.root, config, task);
      if (existing !== null) return existing;
    } catch (err) {
      // 配置坏了由后续主命令报；这里不拦模式选择。
    }
  }
  const picked = await askChoice(
    ctx,
    { agent: invocation?.agent, signal: invocation?.signal },
    {
      header: '操作模式',
      question: task
        ? `「${task}」开工用哪种模式？`
        : `「${subName === 'page' ? '新任务' : '当前任务'}」开工用哪种模式？`,
      options: [
        { label: '手动', description: '所有操作都等确认；方案确认时弹窗点选' },
        {
          label: '自动 loop',
          description: '自动推进；方案确认时自动选择「确认」',
        },
      ],
    },
  );
  if (picked === '自动 loop') return 'auto';
  if (picked === '手动') return 'manual';
  return null;
}

/**
 * page / plan 执行前先问「要不要数模设计」；再问 UI。返回 true 表示要一起做。
 * 没有可用选择框时返回 false，保持非交互环境的旧行为：只执行主命令。
 */
async function askDbBeforeExecution(ctx, invocation, subName, rest) {
  const task = firstTaskName(rest, '');
  const picked = await askChoice(
    ctx,
    { agent: invocation?.agent, signal: invocation?.signal },
    {
      header: '数模设计',
      question: task
        ? `「${task}」要不要同时创建数模设计？`
        : `「${subName === 'page' ? '新任务' : '当前任务'}」要不要同时创建数模设计？`,
      options: [
        {
          label: '创建数模设计',
          description:
            '按 Google 数模规范生成 schema.sql / database.md 与数模图',
        },
        { label: '先不用', description: '只执行主命令' },
      ],
    },
  );
  return picked === '创建数模设计';
}

/**
 * 后台起一个 plans 服务：端口传 0，由系统分配空闲端口，避免和别人抢 7788。
 * @returns {Promise<{ok: boolean, port: number}>} 实际监听端口（拿不到就是 0）。
 */
async function startPlansDetached(root) {
  // 测试里不真的起服务（避免残留进程）
  if (process.env.HARNESS_CLI_NO_AUTO_PLANS === '1')
    return { ok: true, port: 0 };
  try {
    const child = spawn(
      process.execPath,
      [BIN, 'plans', 'serve', '0', '--root', root],
      {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: childEnv(),
      },
    );
    child.unref();
    const ok = await waitForPlansPid(root, child.pid);
    const state = readPlansState(root);
    return {
      ok,
      port: ok && state && Number.isInteger(state.port) ? state.port : 0,
    };
  } catch (err) {
    return { ok: false, port: 0 };
  }
}

/**
 * plan 成功后自动开工：起操作台 + 直接发送执行消息。
 * @returns {{plansStarted: boolean, dispatched: boolean}}
 */
async function kickOffPlan({ root, task, agent }) {
  const plans = await startPlansDetached(root);
  const plansStarted = plans.ok;
  const plansPort = plans.port;
  const prompt = [
    `方案已就绪。现在开始执行任务「${task}」，不要只回复摘要：`,
    `1. 读 docs/specs/${task}/tasks.md 与 prototype/${task}/plan.html，按 Step 1..N 顺序开工；`,
    `2. 每完成一步调用 harness_cli_progress（step=N, pct=100）；失败的步骤如实说明原因；`,
    '3. 需要用户拍板时用 ask_user_question 弹窗，不要自己替用户决定；',
    '4. 全部步骤完成后跑 harness_cli_check，再汇报结果。',
  ].join('\n');
  const dispatched = dispatchAgentMessage(agent, 'harness-cli-kickoff', prompt);
  return { plansStarted, plansPort, dispatched };
}

/** plan 自动开工结果的统一文案。 */
function kickOffReport(kicked) {
  const consoleText = kicked.plansPort
    ? `已在 http://127.0.0.1:${kicked.plansPort}/ 启动`
    : kicked.plansStarted
      ? '已启动'
      : '启动失败，跑 /harness-cli plans serve';
  return (
    `自动开工：${kicked.dispatched ? '执行请求已直接发送到当前对话' : '未能发送执行请求，请说「开始执行」'}\n` +
    `操作台：${consoleText}\n`
  );
}

function registerCommands(ctx) {
  /**
   * 指令菜单里只保留一条 `harness-cli`：
   * 宿主没有分组能力，十几条独立指令会把菜单塞满，所以这里只收集定义、不上架，
   * 由聚合指令按子指令名分发（子指令行为与原来逐条注册时完全一致）。
   */
  const leaves = [];
  const define = (definition) => {
    leaves.push(definition);
    return () => {};
  };
  define({
    name: 'harness-cli-check',
    description:
      '只读校验当前仓库的 Harness 配置（AGENTS.md / 四件套 / 单 WIP / 证据）',
    input: { hint: '[root] [--strict]' },
    handler: async (invocation) => {
      const parsed = parseCommandInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      return runCommand(
        'check',
        parsed,
        invocation?.agent?.session?.header?.cwd,
        invocation?.signal,
      );
    },
  });
  define({
    name: 'harness-cli-init',
    description:
      '生成 Harness 骨架（AGENTS.md / 四件套 / 门禁 / 版本说明），默认同时启用任务页与 UI 设计约定；已存在的文件不覆盖',
    input: { hint: '[root] [--preset prototype] [--force] [--dry-run]' },
    handler: async (invocation) => {
      const parsed = parseCommandInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      // 平台侧默认把任务页能力打开：装完插件就跑 /harness-cli init 的团队，不应该再手工补 prototype/
      const withPreset = { ...parsed, preset: parsed.preset || 'prototype' };
      return runCommand(
        'init',
        withPreset,
        invocation?.agent?.session?.header?.cwd,
        invocation?.signal,
      );
    },
  });
  define({
    name: 'harness-cli-review',
    description:
      '复盘任务：检查 docs/specs 与任务页，写 review.md（人改文档后必须重新复盘）',
    input: { hint: '[任务名] [--agent <标识>]（省略=最近的任务）' },
    handler: async (invocation) => {
      const parsed = parseTaskInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      const resolved = resolveRoot(
        parsed.root,
        invocation?.agent?.session?.header?.cwd,
      );
      if (resolved.error) return { kind: 'error', text: resolved.error };
      const ready = ensureRootDir(resolved.root, parsed.root);
      if (ready.error) return { kind: 'error', text: ready.error };
      const argv = [
        'review',
        ...(parsed.task ? [parsed.task] : []),
        ...(typeof parsed.agent === 'string' ? ['--agent', parsed.agent] : []),
      ];
      const run = await runCli(argv, {
        cwd: resolved.root,
        signal: invocation?.signal,
      });
      return {
        kind: run.exitCode === 0 ? 'success' : 'error',
        text: buildReport(run),
      };
    },
  });
  define({
    name: 'harness-cli-plan',
    description:
      '生成 / 确认任务方案页（prototype/<task>/plan.html）：先定方案再开工',
    input: { hint: '[任务名] [--confirm --by "确认人"]（省略=最近的任务）' },
    handler: async (invocation) => {
      const parsed = parseTaskInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      const resolved = resolveRoot(
        parsed.root,
        invocation?.agent?.session?.header?.cwd,
      );
      if (resolved.error) return { kind: 'error', text: resolved.error };
      const ready = ensureRootDir(resolved.root, parsed.root);
      if (ready.error) return { kind: 'error', text: ready.error };
      const argv = [
        'plan',
        ...(parsed.task ? [parsed.task] : []),
        ...(parsed.confirm === true ? ['--confirm'] : []),
        ...(typeof parsed.by === 'string' ? ['--by', parsed.by] : []),
        ...(typeof parsed.userWords === 'string'
          ? ['--user-words', parsed.userWords]
          : []),
      ];
      const run = await runCli(argv, {
        cwd: resolved.root,
        signal: invocation?.signal,
      });
      const report = buildReport(run);
      if (run.exitCode !== 0 || parsed.confirm === true) {
        return { kind: run.exitCode === 0 ? 'success' : 'error', text: report };
      }
      // plan 生成成功后自动开工：起操作台 + 让 Agent 按步骤执行（A+B）
      const matched = /prototype\/([^/]+)\/plan\.html/.exec(report);
      const task = parsed.task || (matched ? matched[1] : '');
      if (!task) return { kind: 'success', text: report };
      if (invocation?.deferKickoff === true)
        return { kind: 'success', text: report };
      const kicked = await kickOffPlan({
        root: resolved.root,
        task,
        agent: invocation?.agent,
      });
      return {
        kind: 'success',
        text: `${report}\n${kickOffReport(kicked)}`,
      };
    },
  });
  define({
    name: 'harness-cli-progress',
    description:
      '更新任务进度（唯一写入口）：改步骤百分比 / 状态，自动追加记录并同步总览',
    input: {
      hint: '<task> [--step N --pct 0..100] [--status 进行中|待验收|完成] [--note "说明"]',
    },
    handler: async (invocation) => {
      const parsed = parseTaskInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      if (!parsed.task)
        return {
          kind: 'error',
          text: '用法：/harness-cli-progress <任务名> [--step N --pct X]',
        };
      const resolved = resolveRoot(
        parsed.root,
        invocation?.agent?.session?.header?.cwd,
      );
      if (resolved.error) return { kind: 'error', text: resolved.error };
      const ready = ensureRootDir(resolved.root, parsed.root);
      if (ready.error) return { kind: 'error', text: ready.error };
      const argv = [
        'progress',
        parsed.task,
        ...(parsed.step !== undefined ? ['--step', String(parsed.step)] : []),
        ...(parsed.pct !== undefined ? ['--pct', String(parsed.pct)] : []),
        ...(typeof parsed.status === 'string'
          ? ['--status', parsed.status]
          : []),
        ...(typeof parsed.note === 'string' ? ['--note', parsed.note] : []),
        ...(typeof parsed.agent === 'string' ? ['--agent', parsed.agent] : []),
      ];
      const run = await runCli(argv, {
        cwd: resolved.root,
        signal: invocation?.signal,
      });
      return {
        kind: run.exitCode === 0 ? 'success' : 'error',
        text: buildReport(run),
      };
    },
  });
  define({
    name: 'harness-cli-continue',
    description: '继续未完成任务：选择后从当前进度接着执行，不重做已完成步骤',
    input: { hint: '[任务名]（省略=弹窗选择未完成任务）' },
    handler: async (invocation) => {
      const parsed = parseTaskInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      const resolved = resolveRoot(
        parsed.root,
        invocation?.agent?.session?.header?.cwd,
      );
      if (resolved.error) return { kind: 'error', text: resolved.error };
      try {
        assertDirectory(resolved.root);
      } catch (error) {
        return { kind: 'error', text: error.message };
      }
      const loaded = readTaskList(resolved.root);
      if (loaded.error) return { kind: 'error', text: loaded.error };
      const unfinished = loaded.tasks.filter((task) => task.status !== '完成');

      let task = parsed.task
        ? loaded.tasks.find((item) => item.name === parsed.task)
        : undefined;
      if (parsed.task && !task) {
        return {
          kind: 'error',
          text: `没有找到任务「${parsed.task}」。${taskListHint(loaded.tasks)}\n`,
        };
      }
      if (task && task.status === '完成') {
        return {
          kind: 'success',
          text: `任务「${task.name}」已经是「完成」状态，没有可继续的步骤。要整体重跑：/harness-cli restart ${task.name}\n`,
        };
      }

      if (!task) {
        if (unfinished.length === 0) {
          return {
            kind: 'success',
            text:
              loaded.tasks.length === 0
                ? '仓库里还没有任务：先 /harness-cli page <任务名> 建一个。\n'
                : '所有任务都已完成，没有可继续的任务。要重跑：/harness-cli restart\n',
          };
        }
        let askError = null;
        const picked = await askChoice(
          ctx,
          { agent: invocation?.agent, signal: invocation?.signal },
          {
            header: '继续任务',
            question: '选择要继续的未完成任务（会从当前进度接着做）：',
            options: unfinished.map(taskChoice),
          },
          (err) => {
            askError = err;
          },
        );
        if (picked === null) {
          if (askError)
            return {
              kind: 'success',
              text: `已取消（${askError.message}）。\n`,
            };
          return {
            kind: 'success',
            text:
              '没有可用的选择框。直接写：/harness-cli continue <任务名>\n' +
              `未完成任务：\n${unfinished
                .map(
                  (item) =>
                    `  · ${item.name}（${item.status} · ${item.total}%）`,
                )
                .join('\n')}\n`,
          };
        }
        task =
          unfinished.find((item) => item.name === picked) ||
          unfinished.find(
            (item) => item.name === picked.replace(/（推荐）$/, ''),
          );
        if (!task)
          return {
            kind: 'error',
            text: `选择的任务不在未完成列表里：${picked}\n`,
          };
      }

      const prompt = continueTaskPrompt(task);
      if (
        dispatchAgentMessage(invocation?.agent, 'harness-cli-continue', prompt)
      ) {
        return {
          kind: 'success',
          text: `已继续任务「${task.name}」（${task.status} · ${task.total}%）：执行请求已直接发送到当前对话。\n`,
        };
      }
      return {
        kind: 'success',
        text: `未能自动发送执行请求（当前宿主不支持 steer）。把下面这段交给 Agent：\n\n${prompt}\n`,
      };
    },
  });
  define({
    name: 'harness-cli-restart',
    description:
      '多选任务重跑：进度归零、方案回到待确认，再从 Step 1 重新执行（文档保留）',
    input: { hint: '[任务名...]（省略=弹窗多选全部任务）' },
    handler: async (invocation) => {
      const parsed = parseTaskListInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      const resolved = resolveRoot(
        parsed.root,
        invocation?.agent?.session?.header?.cwd,
      );
      if (resolved.error) return { kind: 'error', text: resolved.error };
      try {
        assertDirectory(resolved.root);
      } catch (error) {
        return { kind: 'error', text: error.message };
      }
      const loaded = readTaskList(resolved.root);
      if (loaded.error) return { kind: 'error', text: loaded.error };
      if (loaded.tasks.length === 0) {
        return {
          kind: 'success',
          text: '仓库里还没有任务：先 /harness-cli page <任务名> 建一个，再重跑。\n',
        };
      }

      const requested = parsed.tasks.slice();
      if (requested.length > 0) {
        const missing = requested.filter(
          (name) => !loaded.tasks.some((item) => item.name === name),
        );
        if (missing.length > 0) {
          return {
            kind: 'error',
            text: `没有找到任务：${missing.join('、')}。${taskListHint(loaded.tasks)}\n`,
          };
        }
      } else {
        let askError = null;
        const answer = await askMultiChoice(
          ctx,
          { agent: invocation?.agent, signal: invocation?.signal },
          {
            header: '重跑任务',
            question:
              '勾选要重跑的任务（可多选）：进度会归零、方案回到待确认，文档与 UI 设计稿保留。',
            options: loaded.tasks.map(taskChoice),
          },
          (err) => {
            askError = err;
          },
        );
        if (answer === null) {
          if (askError)
            return {
              kind: 'success',
              text: `已取消（${askError.message}）。\n`,
            };
          return {
            kind: 'success',
            text:
              '没有可用的多选框。直接写：/harness-cli restart <任务名> [任务名...]\n' +
              `现有任务：\n${loaded.tasks
                .map(
                  (item) =>
                    `  · ${item.name}（${item.status} · ${item.total}%）`,
                )
                .join('\n')}\n`,
          };
        }
        // 多选时 custom 是补充项：允许用户直接输入任务名，逗号 / 空格分隔。
        const customNames = answer.custom.split(/[\s,，、]+/).filter(Boolean);
        requested.push(...answer.selected, ...customNames);
        if (requested.length === 0) {
          return { kind: 'success', text: '没有选择任务，未做任何修改。\n' };
        }
      }

      const names = [...new Set(requested)];
      const tasks = names
        .map((name) => loaded.tasks.find((item) => item.name === name))
        .filter(Boolean);
      const unknown = names.filter(
        (name) => !loaded.tasks.some((item) => item.name === name),
      );
      if (tasks.length === 0) {
        return {
          kind: 'error',
          text: `选择的任务都不存在：${unknown.join('、')}\n`,
        };
      }

      const failed = [];
      for (const item of tasks) {
        try {
          resetTask(resolved.root, loaded.config, item.name);
        } catch (err) {
          failed.push({ name: item.name, error: err.message });
        }
      }
      const reset = tasks.filter(
        (item) => !failed.some((entry) => entry.name === item.name),
      );
      if (reset.length > 0) {
        try {
          refreshPlans(resolved.root, loaded.config);
        } catch {
          // 总览刷新失败不影响重跑本身；下一次 check / progress 会再同步。
        }
      }

      const lines = [];
      if (reset.length > 0) {
        lines.push(
          `已重跑 ${reset.length} 个任务：${reset
            .map((item) => `${item.name}（${item.status} · ${item.total}%）`)
            .join('、')}`,
        );
        lines.push(
          '进度已归零、方案回到待确认、复盘已作废；文档与 UI 设计稿保留。',
        );
      }
      if (failed.length > 0) {
        lines.push(
          `有 ${failed.length} 个任务重置失败：${failed
            .map((item) => `${item.name}（${item.error}）`)
            .join('、')}`,
        );
      }
      if (unknown.length > 0)
        lines.push(`忽略不存在的任务：${unknown.join('、')}`);

      if (reset.length > 0) {
        const prompt = restartTasksPrompt(reset);
        if (
          dispatchAgentMessage(invocation?.agent, 'harness-cli-restart', prompt)
        ) {
          lines.push('执行请求已直接发送到当前对话（从 Step 1 重新开始）。');
        } else {
          lines.push(
            `未能自动发送执行请求（当前宿主不支持 steer）。把下面这段交给 Agent：\n\n${prompt}`,
          );
        }
      }

      return {
        kind: failed.length === 0 ? 'success' : 'error',
        text: `${lines.join('\n')}\n`,
      };
    },
  });
  define({
    name: 'harness-cli-sql',
    description:
      '数据库设计：多选任务，按 Google 数模规范生成 / 校验 schema 与 ER 数模图',
    input: { hint: '[任务名...]（省略=弹窗多选全部任务）' },
    handler: async (invocation) => {
      const parsed = parseTaskListInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      const resolved = resolveRoot(
        parsed.root,
        invocation?.agent?.session?.header?.cwd,
      );
      if (resolved.error) return { kind: 'error', text: resolved.error };
      try {
        assertDirectory(resolved.root);
      } catch (error) {
        return { kind: 'error', text: error.message };
      }
      const loaded = readTaskList(resolved.root);
      if (loaded.error) return { kind: 'error', text: loaded.error };
      if (loaded.tasks.length === 0) {
        return {
          kind: 'success',
          text: '仓库里还没有任务：先 /harness-cli page <任务名> 建一个，再做数据库设计。\n',
        };
      }

      let names = parsed.tasks.slice();
      if (names.length > 0) {
        const missing = names.filter(
          (name) => !loaded.tasks.some((item) => item.name === name),
        );
        if (missing.length > 0) {
          return {
            kind: 'error',
            text: `没有找到任务：${missing.join('、')}。${taskListHint(loaded.tasks)}\n`,
          };
        }
      } else {
        let askError = null;
        const answer = await askMultiChoice(
          ctx,
          { agent: invocation?.agent, signal: invocation?.signal },
          {
            header: '数据库设计',
            question:
              '勾选要做数据库设计的任务（可多选）：会按 Google 数模规范生成 schema.sql、database.md 与数模图。',
            options: loaded.tasks.map(taskChoice),
          },
          (err) => {
            askError = err;
          },
        );
        if (answer === null) {
          if (askError)
            return {
              kind: 'success',
              text: `已取消（${askError.message}）。\n`,
            };
          return {
            kind: 'success',
            text:
              '没有可用的多选框。直接写：/harness-cli sql <任务名> [任务名...]\n' +
              `现有任务：\n${loaded.tasks
                .map(
                  (item) =>
                    `  · ${item.name}（${item.status} · ${item.total}%）`,
                )
                .join('\n')}\n`,
          };
        }
        const customNames = answer.custom.split(/[\s,，、]+/).filter(Boolean);
        names.push(...answer.selected, ...customNames);
      }

      names = [...new Set(names)];
      const tasks = names
        .map((name) => loaded.tasks.find((item) => item.name === name))
        .filter(Boolean);
      if (tasks.length === 0) {
        return { kind: 'success', text: '没有选择任务，未做任何修改。\n' };
      }

      const reports = [];
      for (const task of tasks) {
        const run = await runCli(['sql', task.name], {
          cwd: resolved.root,
          signal: invocation?.signal,
        });
        reports.push({ task, run });
      }
      const failed = reports.filter((item) => item.run.exitCode === 2);
      // 「覆盖执行」：即使 schema.sql / db/index.html 已存在，也重新派发设计并刷新全部产物。
      const designTasks = reports
        .filter((item) => item.run.exitCode !== 2)
        .map((item) => item.task);

      const lines = [
        `数据库设计 → ${tasks.map((task) => task.name).join('、')}`,
        `  覆盖执行：${designTasks.length} 个；工具失败：${failed.length} 个（已有 schema 会按任务文档重新核对 / 覆盖）`,
        '',
      ];
      for (const item of reports) {
        lines.push(`## ${item.task.name}`);
        lines.push(buildReport(item.run).trim());
        lines.push('');
      }

      if (designTasks.length > 0) {
        const prompt = sqlTasksPrompt(designTasks);
        if (
          dispatchAgentMessage(invocation?.agent, 'harness-cli-sql', prompt)
        ) {
          lines.push(
            '设计请求已直接发送到当前对话（已有 schema / database.md 按本次设计覆盖或更新）。',
          );
        } else {
          lines.push(
            `未能自动发送执行请求（当前宿主不支持 steer）。把下面这段交给 Agent：\n\n${prompt}`,
          );
        }
      }

      return {
        kind: failed.length > 0 ? 'error' : 'success',
        text: `${lines.join('\n')}\n`,
      };
    },
  });
  define({
    name: 'harness-cli-ui',
    description:
      '给任务生成 / 更新 UI 设计稿（Ant Design v5 风格，prototype/<task>/ui/）',
    input: {
      hint: '[任务名] [--user-words "原话"] [--force]（省略=最近的任务）',
    },
    handler: async (invocation) => {
      const parsed = parseTaskInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      const resolved = resolveRoot(
        parsed.root,
        invocation?.agent?.session?.header?.cwd,
      );
      if (resolved.error) return { kind: 'error', text: resolved.error };
      const ready = ensureRootDir(resolved.root, parsed.root);
      if (ready.error) return { kind: 'error', text: ready.error };
      const argv = [
        'ui',
        ...(parsed.task ? [parsed.task] : []),
        ...(typeof parsed.userWords === 'string'
          ? ['--user-words', parsed.userWords]
          : []),
        // /harness-cli ui 默认覆盖：已存在的设计稿重新生成，而不是 KEEP。
        '--force',
        ...(parsed.dryRun === true ? ['--dry-run'] : []),
      ];
      // 省略任务名时由 CLI 自动挑「上一次的任务」
      const run = await runCli(argv, {
        cwd: resolved.root,
        signal: invocation?.signal,
      });
      const report = buildReport(run);
      const gaps = /UI 设计仍需补全：(\d+) 处/.exec(report);
      if (!gaps || Number(gaps[1]) === 0) {
        return { kind: run.exitCode === 0 ? 'success' : 'error', text: report };
      }

      const gapsFile = /清单：([^\s）)]+)/.exec(report);
      const picked = /prototype\/([^/]+)\/ui\//.exec(report);
      const taskName = picked ? picked[1] : parsed.task || '当前任务';
      const prompt = [
        '补全 UI 设计（由 /harness-cli-ui 自动发起，不要只回复摘要）：',
        `1. 读 ${gapsFile ? gapsFile[1] : `prototype/${taskName}/ui/.ui-gaps.json`}：本次有 ${gaps[1]} 处缺口；`,
        `2. 反推 docs/specs/${taskName}/spec.md 与 design.md，补全 prototype/${taskName}/ui/README.md 的页面目标、信息架构与契约对应；`,
        '3. 需要时调整 ui/index.html 的组件与状态（只用 antd 令牌与组件）；',
        '4. 重跑 /harness-cli-ui，直到「UI 设计仍需补全：0 处」，再跑 /harness-cli-review 与 /harness-cli-plan --confirm。',
      ].join('\n');

      if (dispatchAgentMessage(invocation?.agent, 'harness-cli-ui', prompt)) {
        return {
          kind: 'success',
          text: `${report}\n已将「UI 设计补全」消息直接发送到当前对话。\n`,
        };
      }
      return { kind: 'success', text: `${report}\n${prompt}\n` };
    },
  });
  define({
    name: 'harness-cli-wiki',
    description:
      '生成 docs/wiki 并自动发起「反推补全」：推不出的位置交给当前对话继续补，直到 0 缺口',
    input: { hint: '[root] [--update|--keep|--check]' },
    handler: async (invocation) => {
      const parsed = parseCommandInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      const resolved = resolveRoot(
        parsed.root,
        invocation?.agent?.session?.header?.cwd,
      );
      if (resolved.error) return { kind: 'error', text: resolved.error };
      try {
        assertDirectory(resolved.root);
      } catch (error) {
        return { kind: 'error', text: error.message };
      }
      const argv = [
        'wiki',
        ...(parsed.checkNow === true ? ['--check'] : []),
        ...(parsed.update === true
          ? ['--update']
          : parsed.keep === true
            ? ['--keep']
            : []),
      ];
      const run = await runCli(argv, {
        cwd: resolved.root,
        signal: invocation?.signal,
      });
      const report = buildReport(run);

      // 只读检查（--check）不发起补全任务
      if (parsed.checkNow === true) {
        return { kind: run.exitCode === 0 ? 'success' : 'error', text: report };
      }

      const gaps = /仍需人工确认：(\d+) 处/.exec(report);
      if (!gaps || Number(gaps[1]) === 0) {
        return { kind: run.exitCode === 0 ? 'success' : 'error', text: report };
      }

      const gapsFile = /清单：([^\s）)]+)/.exec(report);
      const prompt = [
        '反推 docs/wiki 并补全（由 /harness-cli-wiki 自动发起，不要只回复摘要）：',
        `1. 读 ${gapsFile ? gapsFile[1] : 'docs/wiki/.harness-wiki-gaps.json'}：本次有 ${gaps[1]} 处无法从仓库直接推导；`,
        '2. 反推当前工作区（README / 功能清单 / 任务页 / 规范文档 / 业务配置），把「待业务确认」换成事实；',
        '3. 用业务白话写：不写命令、代码块、字段名与文件路径，技术细节留在项目 README；',
        '4. 重跑 /harness-cli-wiki，直到输出「仍需人工确认：0 处」为止。',
      ].join('\n');

      if (dispatchAgentMessage(invocation?.agent, 'harness-cli-wiki', prompt)) {
        return {
          kind: 'success',
          text: `${report}\n已将「反推补全」消息直接发送到当前对话。\n`,
        };
      }
      return { kind: 'success', text: `${report}\n${prompt}\n` };
    },
  });
  define({
    name: 'harness-cli-plans',
    description:
      '任务总览 plans.html：serve [端口] 起本机服务（省略端口=随机安全端口），stop 停止',
    input: { hint: '[serve [端口] | stop]' },
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput ?? '');
      const tokens = raw.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
      let root;
      let port;
      let mode = 'open';
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === 'serve' || token === '--serve') {
          mode = 'serve';
        } else if (token === 'stop' || token === '--stop') {
          mode = 'stop';
        } else if (token === '--port') {
          const value = tokens[++index];
          if (value === undefined)
            return { kind: 'error', text: '`--port` 缺少取值' };
          port = Number(value);
        } else if (
          /^\d+$/.test(token) &&
          mode === 'serve' &&
          port === undefined
        ) {
          port = Number(token);
        } else if (token === '--root' || token === '-r') {
          const value = tokens[++index];
          if (value === undefined)
            return { kind: 'error', text: '`--root` 缺少路径参数' };
          root = value.replace(/^["']|["']$/g, '');
        } else {
          return { kind: 'error', text: `无法识别的参数：${token}` };
        }
      }

      const resolved = resolveRoot(
        root,
        invocation?.agent?.session?.header?.cwd,
      );
      if (resolved.error) return { kind: 'error', text: resolved.error };
      const ready = ensureRootDir(resolved.root, root);
      if (ready.error) return { kind: 'error', text: ready.error };

      if (mode === 'stop') {
        const run = await runCli(['plans', 'stop'], {
          cwd: resolved.root,
          signal: invocation?.signal,
        });
        return {
          kind: run.exitCode === 0 ? 'success' : 'error',
          text: buildReport(run),
        };
      }

      if (mode !== 'serve') {
        const run = await runCli(['plans'], {
          cwd: resolved.root,
          signal: invocation?.signal,
        });
        return {
          kind: run.exitCode === 0 ? 'success' : 'error',
          text: buildReport(run),
        };
      }

      // 省略端口 = 0：由系统分配空闲端口，避免固定端口被占
      const target =
        Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0;
      // 强制接管：CLI 的 serve 会先结束上一次的服务、再清掉占用该端口的进程
      const child = spawn(
        process.execPath,
        [BIN, 'plans', 'serve', String(target), '--root', resolved.root],
        {
          cwd: resolved.root,
          detached: true,
          stdio: 'ignore',
          env: childEnv(),
        },
      );
      child.unref();

      const ok = await waitForPlansPid(resolved.root, child.pid);
      const state = readPlansState(resolved.root);
      if (!ok || !state || !Number.isInteger(state.port)) {
        return {
          kind: 'error',
          text:
            `plans 服务没能在端口 ${target === 0 ? '（随机）' : target} 上启动（启动失败，或被占用且无法结束）。\n` +
            '看错误：在项目里跑 dsh-plugin-harness-cli plans serve\n',
        };
      }
      return {
        kind: 'success',
        text:
          `plans 服务已启动：http://127.0.0.1:${state.port}/\n` +
          '页面上的删除 / 重跑 / 保存会直接改仓库文件；停止服务：/harness-cli plans stop\n',
      };
    },
  });
  define({
    name: 'harness-cli-delete',
    description:
      '删除任务（可多选）：任务页 / 方案 / UI / 数据模型 / 规范文档 / 复盘全部删除；进行中的任务立即停止',
    input: { hint: '[任务名...]（省略=弹窗多选全部任务）' },
    handler: async (invocation) => {
      const parsed = parseTaskListInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      const resolved = resolveRoot(
        parsed.root,
        invocation?.agent?.session?.header?.cwd,
      );
      if (resolved.error) return { kind: 'error', text: resolved.error };
      try {
        assertDirectory(resolved.root);
      } catch (error) {
        return { kind: 'error', text: error.message };
      }
      const loaded = readTaskList(resolved.root);
      if (loaded.error) return { kind: 'error', text: loaded.error };
      if (loaded.tasks.length === 0) {
        return {
          kind: 'success',
          text: '仓库里还没有任务，没有可删除的内容。\n',
        };
      }

      let names = parsed.tasks.slice();
      if (names.length > 0) {
        const missing = names.filter(
          (name) => !loaded.tasks.some((item) => item.name === name),
        );
        if (missing.length > 0) {
          return {
            kind: 'error',
            text: `没有找到任务：${missing.join('、')}。${taskListHint(loaded.tasks)}\n`,
          };
        }
        const answer = await askChoice(
          ctx,
          { agent: invocation?.agent, signal: invocation?.signal },
          {
            header: '删除任务',
            question:
              `删除 ${names.length} 个任务：${names.join('、')}？` +
              '任务页、方案、UI、数据模型、规范文档与复盘都会删除，无法恢复；进行中的任务会立即停止。',
            options: [
              { label: '删除', description: '确认删除，并刷新任务总览' },
              { label: '取消', description: '什么都不做' },
            ],
          },
        );
        if (answer !== '删除') {
          return {
            kind: 'success',
            text:
              answer === null
                ? `没有可用的确认弹窗：请在命令行执行 dsh-plugin-harness-cli delete ${names.join(' ')} --yes\n`
                : '已取消删除：任务保持原样。\n',
          };
        }
      } else {
        let askError = null;
        const answer = await askMultiChoice(
          ctx,
          { agent: invocation?.agent, signal: invocation?.signal },
          {
            header: '删除任务',
            question:
              '勾选要删除的任务（可多选）：任务页、方案、UI、数据模型、规范文档与复盘都会删除，不可恢复；' +
              '进行中的任务会立即停止。',
            options: loaded.tasks.map(taskChoice),
          },
          (err) => {
            askError = err;
          },
        );
        if (answer === null) {
          if (askError)
            return {
              kind: 'success',
              text: `已取消（${askError.message}）。\n`,
            };
          return {
            kind: 'success',
            text:
              '没有可用的多选框。直接写：/harness-cli delete <任务名> [任务名...]\n' +
              `现有任务：\n${loaded.tasks
                .map(
                  (item) =>
                    `  · ${item.name}（${item.status} · ${item.total}%）`,
                )
                .join('\n')}\n`,
          };
        }
        const customNames = answer.custom.split(/[\s,，、]+/).filter(Boolean);
        names.push(...answer.selected, ...customNames);
        if (names.length === 0)
          return { kind: 'success', text: '没有选择任务，未做任何修改。\n' };
      }

      names = [...new Set(names)];
      const selected = names
        .map((name) => loaded.tasks.find((item) => item.name === name))
        .filter(Boolean);
      const unknown = names.filter(
        (name) => !loaded.tasks.some((item) => item.name === name),
      );
      if (selected.length === 0) {
        return {
          kind: 'error',
          text: `选择的任务都不存在：${unknown.join('、')}\n`,
        };
      }

      // 「进行中」的任务先停：把停止指令直接送进当前对话，再删文件。
      // 删除后 prototype/ 与 docs/specs/ 都不存在，后续 progress 会自然失败，不会继续写已删除的任务。
      const inProgress = selected.filter((task) => task.status === '进行中');
      let stopped = false;
      if (inProgress.length > 0) {
        const stopText = [
          `立即停止任务：${inProgress.map((task) => task.name).join('、')}`,
          '用户已通过 /harness-cli delete 删除这些任务。',
          '不要再对它们调用 harness_cli_progress，也不要写入 prototype/<任务> 或 docs/specs/<任务>；',
          '当前正在进行的步骤就地停止，并说明「已停止」以及已完成 / 未完成的部分。',
          '不要重新创建这些任务。',
        ].join('\n');
        stopped = dispatchAgentMessage(
          invocation?.agent,
          'harness-cli-delete-stop',
          stopText,
        );
      }

      const run = await runCli(
        ['delete', ...selected.map((task) => task.name), '--yes'],
        {
          cwd: resolved.root,
          signal: invocation?.signal,
        },
      );
      const lines = [];
      if (inProgress.length > 0) {
        lines.push(
          `已停止进行中的任务：${inProgress.map((task) => task.name).join('、')}` +
            (stopped
              ? '（停止指令已发送到当前对话）'
              : '（当前宿主不支持 steer，停止指令未发送）'),
        );
      }
      if (unknown.length > 0)
        lines.push(`忽略不存在的任务：${unknown.join('、')}`);
      lines.push(buildReport(run).trim());
      return {
        kind: run.exitCode === 0 ? 'success' : 'error',
        text: `${lines.join('\n')}\n`,
      };
    },
  });
  define({
    name: 'harness-cli-doctor',
    description: '工具自检：Node / 模板 / 配置 / 可写 / git / python3',
    input: { hint: '[root]' },
    handler: async (invocation) => {
      const parsed = parseCommandInput(invocation?.rawInput);
      if (parsed.error) return { kind: 'error', text: parsed.error };
      return runCommand(
        'doctor',
        parsed,
        invocation?.agent?.session?.header?.cwd,
        invocation?.signal,
      );
    },
  });
  define({
    name: 'harness-cli-help',
    description: '查看所有 harness-cli 工具与斜杠命令的操作说明',
    input: { hint: '[命令或工具名]' },
    handler: async (invocation) => ({
      kind: 'success',
      text: buildHelpText(invocation?.rawInput),
    }),
  });

  // 唯一的指令菜单入口：/harness-cli [子指令] [参数...]
  ctx.commands.register({
    name: 'harness-cli',
    description:
      'Harness-CLI 指令：初始化 / 校验 / 自检 / 建任务 / 方案 / 复盘 / 推进度 / 继续任务 / 重跑任务 / UI 设计 / 数据库设计 / 删除任务 / 业务 wiki / 总览',
    input: { hint: '请输入自定义语义' },
    handler: async (invocation) => {
      const tokens =
        String(invocation?.rawInput ?? '')
          .trim()
          .match(/"[^"]*"|'[^']*'|\S+/g) || [];
      // 兼容两种传法：rawInput 只有参数，或把 `/harness-cli` 本名也带进来
      if (tokens.length > 0 && /^\/?harness-cli$/i.test(tokens[0]))
        tokens.shift();
      let sub = (tokens.shift() || '').replace(/^\/+/, '');
      const fromMenu = sub.length === 0;
      const subOf = (value) => {
        const hit = SUBCOMMANDS.find(
          (item) => item.label === value || item.sub === value,
        );
        return hit ? hit.sub : value;
      };
      const labelOf = (value) => {
        const hit = SUBCOMMANDS.find(
          (item) => item.label === value || item.sub === value,
        );
        return hit ? hit.label : value;
      };

      if (!sub) {
        // 直接在命令里弹选择框：宿主把「活着的请求」渲染成输入框旁的问答卡片
        let askError = null;
        const picked = await askChoice(
          ctx,
          { agent: invocation?.agent, signal: invocation?.signal },
          {
            header: 'Harness-CLI 指令',
            question: '选择要执行的 Harness-CLI 指令：',
            options: SUBCOMMANDS.map((item) => ({
              label: item.label,
              description: `/harness-cli ${item.sub}`,
            })),
          },
          (err) => {
            askError = err;
          },
        );
        if (picked === null) {
          const reason =
            askError && askError.message ? `（${askError.message}）` : '';
          return {
            kind: 'error',
            text:
              `选择框没有弹出来${reason}。也可以直接写子指令：` +
              SUBCOMMANDS.map((item) => `/harness-cli ${item.sub}`).join('、'),
          };
        }
        const byLabel = SUBCOMMANDS.find((item) => item.label === picked);
        if (!byLabel) return { kind: 'success', text: '已取消' };
        sub = byLabel.sub;
      }

      const subName = subOf(sub);
      let rest = tokens.join(' ').trim();
      const TASK_SUBS = ['page', 'plan', 'review', 'progress', 'ui', 'delete'];
      const WORDS_SUBS = ['page', 'plan', 'ui'];

      // 需要任务名的子指令：从菜单选完后再弹一次输入框，让用户补任务名与参数。
      // delete / sql 不在这里：它们自己弹「全部任务多选」，菜单选完就不要再问一次任务名。
      const needsTask = ['page', 'plan', 'review', 'progress', 'ui'];
      if (fromMenu && rest.length === 0 && needsTask.includes(subName)) {
        const hint =
          subName === 'progress'
            ? '可带参数，例如：登录页面 --step 1 --pct 50'
            : '可带参数，例如：登录页面 --force';
        let askError = null;
        const typed = await askChoice(
          ctx,
          { agent: invocation?.agent, signal: invocation?.signal },
          {
            header: '任务名',
            question: `「${labelOf(subName)}」需要任务名（${hint}）：`,
            options: [],
          },
          (err) => {
            askError = err;
          },
        );
        if (typed === null && askError !== null) {
          return {
            kind: 'success',
            text: `已取消（${askError.message}）。也可以直接写：/harness-cli ${subName} <任务名>`,
          };
        }
        if (typed !== null) rest = typed.trim();
      }

      // 把「任务名 + 需求原话」拆开：整句被当成任务名时，另要一个合法名字，原话进 --user-words
      if (TASK_SUBS.includes(subName) && rest.length > 0) {
        const parts = rest.match(/"[^"]*"|'[^']*'|\S+/g) || [];
        const head = parts[0] || '';
        const hasWords = parts.includes('--user-words');
        if (head.length > 0 && !isValidTaskName(head)) {
          const original = rest.replace(/^["']|["']$/g, '').trim();
          let askError = null;
          const typed = await askChoice(
            ctx,
            { agent: invocation?.agent, signal: invocation?.signal },
            {
              header: '任务名',
              question: `「${original}」不是合法任务名（只能用字母 / 数字 / 中文 / 中划线，不能有空格或标点）。给它起个短名字：`,
              options: [],
            },
            (err) => {
              askError = err;
            },
          );
          if (typed === null || !isValidTaskName(typed)) {
            const reason =
              askError && askError.message ? `（${askError.message}）` : '';
            return {
              kind: 'error',
              text:
                `任务名不合法${reason}。用法：/harness-cli ${subName} <任务名>` +
                (WORDS_SUBS.includes(subName)
                  ? ` --user-words "${original}"`
                  : ''),
            };
          }
          const name = typed.trim();
          rest = WORDS_SUBS.includes(subName)
            ? `${name} --user-words "${original}"`
            : name;
        } else if (
          !hasWords &&
          WORDS_SUBS.includes(subName) &&
          !parts.slice(1).some((item) => item.startsWith('-'))
        ) {
          // 只有「任务名 + 纯文字」才自动转成需求原话；带其他参数时保持原样，别把参数吃掉
          const extras = parts.slice(1);
          if (extras.length > 0) {
            rest = `${head} --user-words "${extras.join(' ').replace(/"/g, '\\"')}"`;
          }
        }
      }

      // 从菜单选「任务总览」：自动带 serve，并弹窗问端口（非必填，留空=随机端口）
      if (fromMenu && subName === 'plans' && rest.length === 0) {
        rest = 'serve';
        let askError = null;
        const typed = await askChoice(
          ctx,
          { agent: invocation?.agent, signal: invocation?.signal },
          {
            header: '端口（非必填）',
            question: 'plans 操作台端口：直接跳过就用系统分配的随机端口。',
            options: [],
          },
          (err) => {
            askError = err;
          },
        );
        const port = typeof typed === 'string' ? typed.trim() : '';
        if (port.length > 0) {
          if (!/^\d+$/.test(port) || Number(port) > 65535) {
            return {
              kind: 'error',
              text: `端口不合法：${port}（只能是 0..65535 的数字，留空=随机）`,
            };
          }
          rest = `serve ${Number(port)}`;
        }
      }

      // page / plan：先定操作模式，再问数模设计，最后问 UI 设计；选择完成前不执行任何主命令
      const mode =
        (subName === 'page' || subName === 'plan') &&
        (await askModeBeforeExecution(ctx, invocation, subName, rest));
      // 自动 loop 下直接带 --by，避免「先 confirm 再选模式」时 CLI 因缺 --by 失败。
      if (
        mode === 'auto' &&
        subName === 'plan' &&
        /(^|\s)--confirm(\s|$)/.test(` ${rest}`) &&
        !/(^|\s)--by(\s|$)/.test(` ${rest}`)
      ) {
        rest = `${rest} --by "自动 loop"`;
      }
      const includeDb =
        (subName === 'page' || subName === 'plan') &&
        (await askDbBeforeExecution(ctx, invocation, subName, rest));
      const includeUi =
        (subName === 'page' || subName === 'plan') &&
        (await askUiBeforeExecution(ctx, invocation, subName, rest));

      // page / agents 只有 CLI 与工具、没有独立斜杠命令：这里直接跑 CLI
      let result;
      if (subName === 'page' || subName === 'agents') {
        const resolvedRoot = resolveRoot(
          undefined,
          invocation?.agent?.session?.header?.cwd,
        );
        if (resolvedRoot.error)
          return { kind: 'error', text: resolvedRoot.error };
        const argv =
          subName === 'page'
            ? ['page', ...(rest ? rest.split(/\s+/) : [])]
            : ['agents'];
        const run = await runCli(argv, {
          cwd: resolvedRoot.root,
          signal: invocation?.signal,
        });
        result = {
          kind: run.exitCode === 0 ? 'success' : 'error',
          text: buildReport(run),
        };
      } else {
        const leaf = leaves.find(
          (definition) => definition.name === `harness-cli-${subName}`,
        );
        if (!leaf) {
          return {
            kind: 'error',
            text: `未知子指令：${sub}。可用：${SUBCOMMANDS.map((item) => item.sub).join(' / ')}`,
          };
        }
        // 子指令的 handler 与原来逐条注册时完全一致，只是参数换成聚合指令后面的部分
        result = await leaf.handler({
          ...invocation,
          rawInput: rest,
          deferKickoff: subName === 'plan' && (includeDb || includeUi),
        });
      }

      // 主命令成功后把模式落到任务目录；后续 plan --confirm 据此自动确认。
      if (mode && result && result.kind === 'success') {
        const task = firstTaskName(rest, result.text);
        const resolvedRoot = resolveRoot(
          undefined,
          invocation?.agent?.session?.header?.cwd,
        );
        if (task && !resolvedRoot.error) {
          try {
            const { config } = loadConfig(resolvedRoot.root);
            writeTaskMode(resolvedRoot.root, config, task, mode);
          } catch (err) {
            // 模式写入失败不拦主命令；方案确认会回到弹窗。
          }
        }
      }

      // 数模设计选择已经完成：主命令成功后，先执行 sql（生成 schema 骨架并派发设计）
      if (includeDb && result && result.kind === 'success') {
        const task = firstTaskName(rest, result.text);
        if (task) {
          const sql = leaves.find(
            (definition) => definition.name === 'harness-cli-sql',
          );
          if (sql) {
            const sqlResult = await sql.handler({
              ...invocation,
              rawInput: task,
            });
            result = {
              ...result,
              kind: sqlResult.kind === 'error' ? 'error' : result.kind,
              text: `${result.text}\n已执行 /harness-cli sql ${task}\n${sqlResult.text}`,
            };
          }
        }
      }

      // UI 选择已经完成：主命令成功后，在同一次处理里继续执行 ui
      if (includeUi && result && result.kind === 'success') {
        const task = firstTaskName(rest, result.text);
        if (task) {
          const ui = leaves.find(
            (definition) => definition.name === 'harness-cli-ui',
          );
          if (ui) {
            const uiResult = await ui.handler({
              ...invocation,
              rawInput: task,
            });
            result = {
              ...result,
              kind: uiResult.kind === 'error' ? 'error' : result.kind,
              text: `${result.text}\n已执行 /harness-cli ui ${task}\n${uiResult.text}`,
            };
          }
        }
      }

      if (
        subName === 'plan' &&
        (includeDb || includeUi) &&
        result?.kind === 'success'
      ) {
        const task = firstTaskName(rest, result.text);
        const parsed = parseTaskInput(rest);
        if (task && parsed.confirm !== true) {
          const resolvedRoot = resolveRoot(
            parsed.root,
            invocation?.agent?.session?.header?.cwd,
          );
          if (!resolvedRoot.error) {
            const kicked = await kickOffPlan({
              root: resolvedRoot.root,
              task,
              agent: invocation?.agent,
            });
            result = {
              ...result,
              text: `${result.text}\n${kickOffReport(kicked)}`,
            };
          }
        }
      }

      // 让「到底跑了哪条指令」在对话里显式可见（聚合入口只显示 /harness-cli）
      if (result && typeof result.text === 'string' && fromMenu) {
        return {
          ...result,
          text: `已执行 /harness-cli ${subName}${rest ? ` ${rest}` : ''}\n\n${result.text}`,
        };
      }
      return result;
    },
  });
}

/**
 * 注册工具与命令。
 * @param {any} ctx - Cordis context（`tools` 必存在，`commands` 可选）。
 */
export function apply(ctx) {
  for (const spec of TOOL_SPECS) ctx.tools.register(buildTool(spec, ctx));
  if (typeof ctx.inject === 'function')
    ctx.inject(['commands'], (scoped) => registerCommands(scoped));
  else if (ctx.commands !== undefined) registerCommands(ctx);

  // DSH 的 todo_write 每次写 `todo/write` 会话事件；这里把它桥到任务页进度。
  // 事件处理是幂等的：只有 todo 状态与页面百分比不同才调用 progress。
  if (typeof ctx.on === 'function') {
    const bridge = createTodoBridge();
    ctx.on('session/event', (session, event) => {
      return bridge.handle(session, event).then((result) => {
        // warn：按设计没有写入，但用户需要知道为什么（例如方案还没确认）
        const message =
          result && result.warn
            ? `[harness-cli] ${result.warn}`
            : result && result.ok === false && !result.skipped
              ? `[harness-cli] DSH todo 同步失败：${result.error || '未知错误'}`
              : '';
        if (message) {
          if (ctx.logger && typeof ctx.logger.warn === 'function')
            ctx.logger.warn(message);
          else console.warn(message);
        }
        return result;
      });
    });
  }
}

export {
  buildReport,
  parseCommandInput,
  parseTaskInput,
  resolveRoot,
  runCli,
  TOOL_SPECS,
  COMMAND_MANUAL,
  buildHelpText,
};
