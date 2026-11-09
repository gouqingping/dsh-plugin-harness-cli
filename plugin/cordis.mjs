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
import {execFile, spawn} from 'node:child_process';
import http from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {createTodoBridge} = require('./src/todo-bridge.js');

/** Cordis 插件标识（与 `cordis.patch.yml` 里的 `id` 对应）。 */
export const name = 'harness-cli';

/** 需要工具注册表就绪后才 apply。 */
export const inject = ['tools'];

/** 被适配的 CLI 入口。 */
const BIN = fileURLToPath(new URL('./bin/dsh-plugin-harness-cli.js', import.meta.url));

const DEFAULT_TIMEOUT_MS = 120_000;
const STYLE_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** 退出码的固定含义，与 CLI 文档一致。 */
const EXIT_MEANING = {0: '通过', 1: '有违规（可预期失败）', 2: '工具或用法有错'};

/** 模型可见的统一输出结构。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['root', 'command', 'args', 'exitCode', 'ok', 'report'],
  properties: {
    root: {type: 'string', description: '本次运行的目标仓库根目录（子进程 cwd）。'},
    command: {type: 'string', description: '执行的子命令：init / check / agents / doctor / style。'},
    args: {type: 'array', items: {type: 'string'}, description: '透传给 CLI 的完整参数。'},
    exitCode: {type: 'integer', description: '0 通过 / 1 有违规 / 2 工具或配置坏了。'},
    ok: {type: 'boolean', description: 'exitCode === 0。'},
    report: {type: 'string', description: 'CLI 的完整输出（stdout + stderr）与退出码说明。'},
  },
};

/**
 * 子进程环境：关掉颜色（输出是纯文本），Electron 下让可执行文件以 node 身份运行。
 * @returns {NodeJS.ProcessEnv} 子进程环境变量。
 */
function childEnv() {
  const env = {...process.env, NO_COLOR: '1', FORCE_COLOR: '0'};
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
  if (explicit !== undefined && explicit !== null && typeof explicit !== 'string') {
    return {error: '`root` 必须是字符串'};
  }
  const trimmed = typeof explicit === 'string' ? explicit.trim() : '';
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
  if (trimmed.length > 0) return {root: path.resolve(base ?? process.cwd(), trimmed)};
  if (base === undefined || base === path.parse(base).root) {
    return {error: '当前 Session 没有有效的工作目录，请显式传入 `root`（例如目标仓库的绝对路径）'};
  }
  return {root: base};
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
    throw new Error(`目标目录不存在：${root}（如果这是任务名，请用 /harness-cli-ui <任务名>，目录会自动创建）`);
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
        ...(options.signal ? {signal: options.signal} : {}),
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
        if (err.length === 0 && exitCode !== 0 && error && typeof error.message === 'string') {
          err = `${error.message}\n`;
        }
        resolve({exitCode, stdout: out, stderr: err});
      }
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
  lines.push(`退出码 ${run.exitCode}：${EXIT_MEANING[run.exitCode] ?? '未知退出码'}`);
  return `${lines.join('\n')}\n`;
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
 * @returns {object} 可交给 `ctx.tools.register` 的定义。
 */
function buildTool(spec) {
  return {
    name: spec.toolName,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{type: 'text', text: value.report}],
    },
    async execute(args, exec) {
      const input = args ?? {};
      const resolved = resolveRoot(input.root, exec?.agent?.session?.header?.cwd);
      if (resolved.error) throw new Error(resolved.error);
      assertDirectory(resolved.root);
      const argv = spec.buildArgs(input);
      const run = await runCli(argv, {
        cwd: resolved.root,
        signal: exec?.signal,
        timeoutMs: spec.timeoutMs,
      });
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
  'design, risks, and acceptance criteria. Confirmation requires a passed review whose fingerprint matches the ' +
  'current docs/specs/<task>/*.md; after confirmation any document edit invalidates it. Work must not start ' +
  'before confirmation: `progress` refuses to write and the P21/P22 gates fail.';

const PROGRESS_DESCRIPTION =
  'The only write path for task progress. Updates one step percentage (step + pct), and/or the task status ' +
  '(进行中 / 待验收 / 完成), appends a dated progress entry, recomputes the total, and re-syncs ' +
  'prototype/progress.html. Refuses when the plan is not confirmed (run plan with confirm first). ' +
  'Every call is recorded, so the page never silently misses a step change.';

const UI_DESCRIPTION =
  'Generate or refresh the UI design for one task: prototype/<task>/ui/index.html (offline static HTML in ' +
  'Ant Design v5 style — antd design tokens, Layout/Sider, PageHeader, Statistic cards, Table with Tag/Progress/' +
  'Pagination, Descriptions, Form, and empty/loading/error states) plus ui/README.md (page goal, component list, ' +
  'states, contract mapping, responsive rules). Creates the task page and spec docs first if they do not exist. ' +
  'All UI must follow antd; a second design system fails the P20 gate. Existing files are kept unless `force`.';

const WIKI_DESCRIPTION =
  'Generate or refresh docs/wiki (13 business-facing documents: one-page overview, deployment, roles, flows, ' +
  'feature list, states and rules, conventions, quality gates, acceptance, risks, glossary, manual, README). ' +
  'Scans the repository and writes only the managed block of each file; human text outside it is never touched. ' +
  'Existing files are updated, missing ones created. When a managed block was edited by hand the run reports a ' +
  'conflict and exits 1: ask the user, then re-run with mode "auto" (overwrite) or "keep" (keep human text). ' +
  'mode defaults to "ask"; check=true only reports missing/stale/conflicting files.';

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

/** 五个工具的定义。 */
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
    buildArgs: (input) => ['check', ...(input.strict === true ? ['--strict'] : [])],
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
          description: '额外启用 preset：`prototype` = 一个任务一张进度页，总进度按步骤百分比汇总。',
        },
        force: {
          type: 'boolean',
          description: '覆盖已存在的非空结构文件（状态文件仍不覆盖）。默认 false。',
        },
        force_state: {
          type: 'boolean',
          description: '连同状态文件（进度日志 / 功能清单 / 任务队列）一起覆盖，慎用。默认 false。',
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
          description: '任务名（支持中文，例如 登录页面 或 login-flow），同时是 prototype/ 与 docs/specs/ 下的目录名。',
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
      if (task.length === 0) throw new Error('`task` 不能为空，例如 "login-flow"');
      return [
        'page',
        task,
        ...(typeof input.user_words === 'string' ? ['--user-words', input.user_words] : []),
        ...(input.force === true ? ['--force'] : []),
        ...(input.dry_run === true ? ['--dry-run'] : []),
      ];
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
          description: '只报告缺失 / 过期 / 冲突，不写盘（适合门禁或交付前检查）。',
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
      ...(input.mode === 'auto' ? ['--update'] : input.mode === 'keep' ? ['--keep'] : ['--ask']),
      ...(input.dry_run === true ? ['--dry-run'] : []),
    ],
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
        task: {type: 'string', description: '任务名（支持中文）。'},
        agent: {type: 'string', description: '复盘执行者标识，写进 review.md。'},
        dry_run: {type: 'boolean', description: '只打印将发生的事，不落盘。'},
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
        task: {type: 'string', description: '任务名（支持中文），与任务页目录一致。'},
        confirm: {type: 'boolean', description: '把方案标记为「已确认」（需要同时给 by）。'},
        by: {type: 'string', description: '确认人（会话/人名），确认时必填。'},
        user_words: {type: 'string', description: '用户原话，写进方案页与提案。'},
        goal: {type: 'string', description: '一句话目标（不填则由原话/任务名推导）。'},
        scope: {type: 'string', description: '做什么（范围）。'},
        context: {type: 'string', description: '限界上下文。'},
        non_goals: {type: 'array', items: {type: 'string'}, description: '不做什么（非目标）。'},
        terms: {type: 'array', items: {type: 'string'}, description: '统一语言，格式 "术语=定义"。'},
        contracts: {
          type: 'array',
          items: {type: 'string'},
          description: '契约，格式 "S-01|标题|输入|输出|错误语义|验收标准"。',
        },
        steps: {type: 'array', items: {type: 'string'}, description: '任务规划，格式 "步骤标题|S-01"。'},
        acceptance: {type: 'array', items: {type: 'string'}, description: '验收条目。'},
        input_json: {type: 'string', description: '完整内容模型（JSON 字符串），优先级最高。'},
        dry_run: {type: 'boolean', description: '只打印将写入的文件，不落盘。'},
      },
    },
    buildArgs: (input) => {
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      const many = (name, list) => (Array.isArray(list) ? list.flatMap((item) => [`--${name}`, String(item)]) : []);
      return [
        'plan',
        ...(task.length > 0 ? [task] : []),
        ...(input.confirm === true ? ['--confirm'] : []),
        ...(typeof input.by === 'string' ? ['--by', input.by] : []),
        ...(typeof input.user_words === 'string' ? ['--user-words', input.user_words] : []),
        ...(typeof input.goal === 'string' ? ['--goal', input.goal] : []),
        ...(typeof input.scope === 'string' ? ['--scope', input.scope] : []),
        ...(typeof input.context === 'string' ? ['--context', input.context] : []),
        ...many('non-goal', input.non_goals),
        ...many('term', input.terms),
        ...many('contract', input.contracts),
        ...many('step', input.steps),
        ...many('accept', input.acceptance),
        ...(typeof input.input_json === 'string' ? ['--input-json', input.input_json] : []),
        ...(input.dry_run === true ? ['--dry-run'] : []),
      ];
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
        task: {type: 'string', description: '任务名（支持中文）。'},
        step: {type: 'integer', description: '第几步（从 1 开始），配合 pct 使用。'},
        pct: {type: 'integer', description: '该步骤的完成度 0..100。'},
        status: {type: 'string', enum: ['进行中', '待验收', '完成'], description: '任务状态。'},
        note: {type: 'string', description: '进度记录里的一句话说明；省略时自动生成。'},
        agent: {type: 'string', description: '操作人/会话标识，写进进度记录。'},
        dry_run: {type: 'boolean', description: '只打印将发生的动作，不落盘。'},
      },
    },
    buildArgs: (input) => {
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (task.length === 0) throw new Error('`task` 不能为空，例如 "登录页面"');
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
          description: '任务名（支持中文，例如 登录页面 或 login-flow），与任务页目录一致。',
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
      if (task.length === 0) throw new Error('`task` 不能为空，例如 "login-flow"');
      return [
        'ui',
        task,
        ...(typeof input.user_words === 'string' ? ['--user-words', input.user_words] : []),
        ...(input.force === true ? ['--force'] : []),
        ...(input.dry_run === true ? ['--dry-run'] : []),
      ];
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
      properties: {root: ROOT_PROPERTY},
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
          items: {type: 'string'},
          description: '原样转发给 harness-style 的参数，例如 ["check","--staged"]。',
        },
      },
    },
    buildArgs: (input) => {
      const rest = Array.isArray(input.args) ? input.args : [];
      if (rest.length === 0) throw new Error('`args` 不能为空，例如 ["check", "--staged"]');
      for (const item of rest) {
        if (typeof item !== 'string') throw new Error('`args` 的每一项都必须是字符串');
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
  const tokens = String(rawInput ?? '')
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
      if (value === undefined) return {error: '`--root` 缺少路径参数'};
      parsed.root = value.replace(/^["']|["']$/g, '');
    } else if (token === '--preset') {
      const value = tokens[++index];
      if (value === undefined) return {error: '`--preset` 缺少取值'};
      parsed.preset = value;
    } else if (token === '--user-words') {
      const value = tokens[++index];
      if (value === undefined) return {error: '`--user-words` 缺少取值'};
      parsed.userWords = value.replace(/^["']|["']$/g, '');
    } else if (!token.startsWith('-') && parsed.root === undefined) {
      parsed.root = token;
    } else if (!token.startsWith('-') && parsed.task === undefined) {
      parsed.task = token.replace(/^["']|["']$/g, '');
    } else {
      return {error: `无法识别的参数：${token}`};
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
  if (resolved.error) return {kind: 'error', text: resolved.error};
  try {
    assertDirectory(resolved.root);
  } catch (error) {
    return {kind: 'error', text: error.message};
  }
  const argv = [
    command,
    ...(command === 'check' && parsed.strict === true ? ['--strict'] : []),
    ...(command === 'init' && typeof parsed.preset === 'string' ? ['--preset', parsed.preset] : []),
    ...(command === 'init' && parsed.force === true ? ['--force'] : []),
    ...(command === 'init' && parsed.dryRun === true ? ['--dry-run'] : []),
  ];
  const run = await runCli(argv, {cwd: resolved.root, signal});
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
    return {ok: true};
  } catch (error) {
    if (!explicit) return {error: error.message};
    try {
      fs.mkdirSync(root, {recursive: true});
      return {ok: true};
    } catch (err) {
      return {error: `无法创建目录 ${root}：${err.message}`};
    }
  }
}

/**
 * 在当前对话里自动发起一条 user 消息（下一轮处理）。
 * @param {any} agent - CommandInvocation.agent。
 * @param {string} idPrefix - 消息 id 前缀。
 * @param {string} text - 消息正文。
 * @returns {boolean} 是否成功入队。
 */
function enqueueFollowup(agent, idPrefix, text) {
  if (!agent || typeof agent.followup !== 'function') return false;
  try {
    agent.followup({
      id: `${idPrefix}-${Date.now()}`,
      role: 'user',
      content: [{type: 'text', text}],
      source: {kind: 'user'},
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
  const tokens = String(rawInput ?? '')
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
      if (value === undefined) return {error: '`--root` 缺少路径参数'};
      parsed.root = value.replace(/^["']|["']$/g, '');
    } else if (token === '--confirm') {
      parsed.confirm = true;
    } else if (token === '--user-words') {
      const value = tokens[++index];
      if (value === undefined) return {error: '`--user-words` 缺少取值'};
      parsed.userWords = value.replace(/^["']|["']$/g, '');
    } else if (token === '--by') {
      const value = tokens[++index];
      if (value === undefined) return {error: '`--by` 缺少取值'};
      parsed.by = value.replace(/^["']|["']$/g, '');
    } else if (token === '--step') {
      const value = tokens[++index];
      if (value === undefined) return {error: '`--step` 缺少取值'};
      parsed.step = Number(value);
    } else if (token === '--pct') {
      const value = tokens[++index];
      if (value === undefined) return {error: '`--pct` 缺少取值'};
      parsed.pct = Number(value);
    } else if (token === '--status') {
      const value = tokens[++index];
      if (value === undefined) return {error: '`--status` 缺少取值'};
      parsed.status = value;
    } else if (token === '--note') {
      const value = tokens[++index];
      if (value === undefined) return {error: '`--note` 缺少取值'};
      parsed.note = value.replace(/^["']|["']$/g, '');
    } else if (token === '--agent') {
      const value = tokens[++index];
      if (value === undefined) return {error: '`--agent` 缺少取值'};
      parsed.agent = value.replace(/^["']|["']$/g, '');
    } else if (!token.startsWith('-') && parsed.task === undefined) {
      parsed.task = token.replace(/^["']|["']$/g, '');
    } else if (!token.startsWith('-') && parsed.root === undefined) {
      // 第二个位置参数当根目录，兼容 /harness-cli-ui <任务名> <目录>
      parsed.root = token;
    } else {
      return {error: `无法识别的参数：${token}`};
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
  {name: 'harness-cli-init', usage: '/harness-cli-init [root] [--force] [--dry-run]', description: '生成 Harness 骨架（默认启用任务页能力）'},
  {name: 'harness-cli-check', usage: '/harness-cli-check [root] [--strict]', description: '只读校验项目配置与流程证据'},
  {name: 'harness-cli-review', usage: '/harness-cli-review [任务名] [--agent <标识>]', description: 'Agent 复盘：核对 docs/specs 与任务页，写 review.md（省略任务名=最近的任务）'},
  {name: 'harness-cli-plan', usage: '/harness-cli-plan [任务名] [--confirm --by "确认人"]', description: '建任务并补全 docs/specs 与页面；确认前必须复盘通过（省略任务名=最近的任务）'},
  {name: 'harness-cli-progress', usage: '/harness-cli-progress <任务名> --step N --pct 0..100 [--status 进行中|待验收|完成] [--note "说明"]', description: '唯一进度写入口：改步骤/状态 → 追加记录 → 同步总览'},
  {name: 'harness-cli-ui', usage: '/harness-cli-ui [任务名] [--force]', description: '生成 antd UI 设计稿，有缺口时自动发起「UI 设计补全」对话'},
  {name: 'harness-cli-wiki', usage: '/harness-cli-wiki [root] [--update|--keep|--check]', description: '生成 docs/wiki，有缺口时自动发起「反推补全」对话'},
  {name: 'harness-cli-doctor', usage: '/harness-cli-doctor [root]', description: '工具自检：环境 / 模板 / 配置 / 可写 / 风格 / git'},
  {name: 'harness-cli-plans', usage: '/harness-cli-plans [--serve] [--port 7788] [--stop]', description: '生成 / 打开任务总览 plans.html（--serve 起本机服务，按钮才可直接落盘）'},
  {name: 'harness-cli-help', usage: '/harness-cli-help [命令或工具名]', description: '查看所有工具与斜杠命令的用法'},
];

/** 任务标准流程（帮助里反复用到，单独一份）。 */
const WORKFLOW_TEXT = [
  '任务标准流程（顺序不能颠倒）：',
  '  0. 开工前先问用户：手动（每步等确认）还是自动 loop（自动推进、所有确认 / 选择走推荐项）',
  '  1. /harness-cli-init                    生成骨架（默认带任务页能力）',
  '  2. /harness-cli-ui <任务>               建任务页 + 四份规范文档 + 方案页；需要界面时生成 antd 设计稿',
  '  3. 人改 docs/specs/<任务>/*.md       proposal / spec / design / tasks（可直接改）',
  '  4. /harness-cli-review <任务>           Agent 复盘：文档与页面一致才通过，写 review.md（含文档指纹）',
  '  5. /harness-cli-plan <任务> --confirm --by "确认人"   最终确认（复盘通过 + 指纹未变）',
  '  6. /harness-cli-progress <任务> --step N --pct 0..100 推进度（自动追加记录 + 同步总览）',
  '  7. /harness-cli-check 或项目门禁 gate.sh             校验 / 交付前门禁',
  '  8. /harness-cli-plans --serve                         打开总览操作台（删除 / 重跑 / 编辑 / UI 预览）',
].join('\n');

/**
 * 生成帮助文本。
 * @param {string} topic - 可选：命令名 / 工具名，只显示那一条。
 * @returns {string} 帮助文本。
 */
function buildHelpText(topic) {
  const key = String(topic || '').trim();
  const tools = TOOL_SPECS.map((spec) => ({name: spec.toolName, description: spec.description}));
  const commands = COMMAND_MANUAL;

  if (key.length > 0) {
    const command = commands.find(
      (item) => item.name === key || item.name === `harness-${key}` || item.name === `harness-cli-${key}`
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
    const tool = tools.find((item) => item.name === key || item.name === `harness_cli_${key}`);
    if (tool) {
      const spec = TOOL_SPECS.find((item) => item.toolName === tool.name);
      const params = Object.keys((spec.parameters && spec.parameters.properties) || {}).join(', ') || '无';
      return [`${tool.name}（对应子命令 ${spec.command}）`, `  参数：${params}`, `  说明：${tool.description}`, ''].join('\n');
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
    `模型工具（${tools.length}，参数 root 省略时用当前会话工作目录）`,
    ...tools.map((item) => {
      const spec = TOOL_SPECS.find((entry) => entry.toolName === item.name);
      const params = Object.keys((spec.parameters && spec.parameters.properties) || {}).join(', ') || '无';
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
      const req = http.get({host: '127.0.0.1', port, path: '/', timeout: 800}, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve(res.statusCode === 200 && text.includes('data-plans')));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });

  return (async () => {
    while (Date.now() < deadline) {
      if (await attempt()) return true;
      await new Promise((done) => setTimeout(done, 120));
    }
    return false;
  })();
}

/** 读取 plans 服务状态（pid / port）。 */
function readPlansState(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.harness', 'plans-server.json'), 'utf8'));
  } catch (err) {
    return null;
  }
}

function registerCommands(ctx) {
  ctx.commands.register({
    name: 'harness-cli-check',
    description: '只读校验当前仓库的 Harness 配置（AGENTS.md / 四件套 / 单 WIP / 证据）',
    input: {hint: '[root] [--strict]'},
    handler: async (invocation) => {
      const parsed = parseCommandInput(invocation?.rawInput);
      if (parsed.error) return {kind: 'error', text: parsed.error};
      return runCommand('check', parsed, invocation?.agent?.session?.header?.cwd, invocation?.signal);
    },
  });
  ctx.commands.register({
    name: 'harness-cli-init',
    description:
      '生成 Harness 骨架（AGENTS.md / 四件套 / 门禁 / 版本说明），默认同时启用任务页与 UI 设计约定；已存在的文件不覆盖',
    input: {hint: '[root] [--preset prototype] [--force] [--dry-run]'},
    handler: async (invocation) => {
      const parsed = parseCommandInput(invocation?.rawInput);
      if (parsed.error) return {kind: 'error', text: parsed.error};
      // 平台侧默认把任务页能力打开：装完插件就跑 /harness-cli-init 的团队，不应该再手工补 prototype/
      const withPreset = {...parsed, preset: parsed.preset || 'prototype'};
      return runCommand('init', withPreset, invocation?.agent?.session?.header?.cwd, invocation?.signal);
    },
  });
  ctx.commands.register({
    name: 'harness-cli-review',
    description: '复盘任务：检查 docs/specs 与任务页，写 review.md（人改文档后必须重新复盘）',
    input: {hint: '[任务名] [--agent <标识>]（省略=最近的任务）'},
    handler: async (invocation) => {
      const parsed = parseTaskInput(invocation?.rawInput);
      if (parsed.error) return {kind: 'error', text: parsed.error};
      const resolved = resolveRoot(parsed.root, invocation?.agent?.session?.header?.cwd);
      if (resolved.error) return {kind: 'error', text: resolved.error};
      const ready = ensureRootDir(resolved.root, parsed.root);
      if (ready.error) return {kind: 'error', text: ready.error};
      const argv = [
        'review',
        ...(parsed.task ? [parsed.task] : []),
        ...(typeof parsed.agent === 'string' ? ['--agent', parsed.agent] : []),
      ];
      const run = await runCli(argv, {cwd: resolved.root, signal: invocation?.signal});
      return {kind: run.exitCode === 0 ? 'success' : 'error', text: buildReport(run)};
    },
  });
  ctx.commands.register({
    name: 'harness-cli-plan',
    description: '生成 / 确认任务方案页（prototype/<task>/plan.html）：先定方案再开工',
    input: {hint: '[任务名] [--confirm --by "确认人"]（省略=最近的任务）'},
    handler: async (invocation) => {
      const parsed = parseTaskInput(invocation?.rawInput);
      if (parsed.error) return {kind: 'error', text: parsed.error};
      const resolved = resolveRoot(parsed.root, invocation?.agent?.session?.header?.cwd);
      if (resolved.error) return {kind: 'error', text: resolved.error};
      const ready = ensureRootDir(resolved.root, parsed.root);
      if (ready.error) return {kind: 'error', text: ready.error};
      const argv = [
        'plan',
        ...(parsed.task ? [parsed.task] : []),
        ...(parsed.confirm === true ? ['--confirm'] : []),
        ...(typeof parsed.by === 'string' ? ['--by', parsed.by] : []),
        ...(typeof parsed.userWords === 'string' ? ['--user-words', parsed.userWords] : []),
      ];
      const run = await runCli(argv, {cwd: resolved.root, signal: invocation?.signal});
      return {kind: run.exitCode === 0 ? 'success' : 'error', text: buildReport(run)};
    },
  });
  ctx.commands.register({
    name: 'harness-cli-progress',
    description: '更新任务进度（唯一写入口）：改步骤百分比 / 状态，自动追加记录并同步总览',
    input: {hint: '<task> [--step N --pct 0..100] [--status 进行中|待验收|完成] [--note "说明"]'},
    handler: async (invocation) => {
      const parsed = parseTaskInput(invocation?.rawInput);
      if (parsed.error) return {kind: 'error', text: parsed.error};
      if (!parsed.task) return {kind: 'error', text: '用法：/harness-cli-progress <任务名> [--step N --pct X]'};
      const resolved = resolveRoot(parsed.root, invocation?.agent?.session?.header?.cwd);
      if (resolved.error) return {kind: 'error', text: resolved.error};
      const ready = ensureRootDir(resolved.root, parsed.root);
      if (ready.error) return {kind: 'error', text: ready.error};
      const argv = [
        'progress',
        parsed.task,
        ...(parsed.step !== undefined ? ['--step', String(parsed.step)] : []),
        ...(parsed.pct !== undefined ? ['--pct', String(parsed.pct)] : []),
        ...(typeof parsed.status === 'string' ? ['--status', parsed.status] : []),
        ...(typeof parsed.note === 'string' ? ['--note', parsed.note] : []),
        ...(typeof parsed.agent === 'string' ? ['--agent', parsed.agent] : []),
      ];
      const run = await runCli(argv, {cwd: resolved.root, signal: invocation?.signal});
      return {kind: run.exitCode === 0 ? 'success' : 'error', text: buildReport(run)};
    },
  });
  ctx.commands.register({
    name: 'harness-cli-ui',
    description: '给任务生成 / 更新 UI 设计稿（Ant Design v5 风格，prototype/<task>/ui/）',
    input: {hint: '[任务名] [--user-words "原话"] [--force]（省略=最近的任务）'},
    handler: async (invocation) => {
      const parsed = parseTaskInput(invocation?.rawInput);
      if (parsed.error) return {kind: 'error', text: parsed.error};
      const resolved = resolveRoot(parsed.root, invocation?.agent?.session?.header?.cwd);
      if (resolved.error) return {kind: 'error', text: resolved.error};
      const ready = ensureRootDir(resolved.root, parsed.root);
      if (ready.error) return {kind: 'error', text: ready.error};
      const argv = [
        'ui',
        ...(parsed.task ? [parsed.task] : []),
        ...(typeof parsed.userWords === 'string' ? ['--user-words', parsed.userWords] : []),
        ...(parsed.force === true ? ['--force'] : []),
        ...(parsed.dryRun === true ? ['--dry-run'] : []),
      ];
      // 省略任务名时由 CLI 自动挑「上一次的任务」
      const run = await runCli(argv, {cwd: resolved.root, signal: invocation?.signal});
      const report = buildReport(run);
      const gaps = /UI 设计仍需补全：(\d+) 处/.exec(report);
      if (!gaps || Number(gaps[1]) === 0) {
        return {kind: run.exitCode === 0 ? 'success' : 'error', text: report};
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

      if (enqueueFollowup(invocation?.agent, 'harness-cli-ui', prompt)) {
        return {kind: 'success', text: `${report}\n已在当前对话自动发起「UI 设计补全」任务。\n`};
      }
      return {kind: 'success', text: `${report}\n${prompt}\n`};
    },
  });
  ctx.commands.register({
    name: 'harness-cli-wiki',
    description: '生成 docs/wiki 并自动发起「反推补全」：推不出的位置交给当前对话继续补，直到 0 缺口',
    input: {hint: '[root] [--update|--keep|--check]'},
    handler: async (invocation) => {
      const parsed = parseCommandInput(invocation?.rawInput);
      if (parsed.error) return {kind: 'error', text: parsed.error};
      const resolved = resolveRoot(parsed.root, invocation?.agent?.session?.header?.cwd);
      if (resolved.error) return {kind: 'error', text: resolved.error};
      try {
        assertDirectory(resolved.root);
      } catch (error) {
        return {kind: 'error', text: error.message};
      }
      const argv = [
        'wiki',
        ...(parsed.checkNow === true ? ['--check'] : []),
        ...(parsed.update === true ? ['--update'] : parsed.keep === true ? ['--keep'] : []),
      ];
      const run = await runCli(argv, {cwd: resolved.root, signal: invocation?.signal});
      const report = buildReport(run);

      // 只读检查（--check）不发起补全任务
      if (parsed.checkNow === true) {
        return {kind: run.exitCode === 0 ? 'success' : 'error', text: report};
      }

      const gaps = /仍需人工确认：(\d+) 处/.exec(report);
      if (!gaps || Number(gaps[1]) === 0) {
        return {kind: run.exitCode === 0 ? 'success' : 'error', text: report};
      }

      const gapsFile = /清单：([^\s）)]+)/.exec(report);
      const prompt = [
        '反推 docs/wiki 并补全（由 /harness-cli-wiki 自动发起，不要只回复摘要）：',
        `1. 读 ${gapsFile ? gapsFile[1] : 'docs/wiki/.harness-wiki-gaps.json'}：本次有 ${gaps[1]} 处无法从仓库直接推导；`,
        '2. 反推当前工作区（源码 / README / docs/specs / 任务页 / 门禁脚本），直接编辑对应 docs/wiki 文件补全；',
        '3. 重跑 /harness-cli-wiki，直到输出「仍需人工确认：0 处」为止。',
      ].join('\n');

      if (enqueueFollowup(invocation?.agent, 'harness-cli-wiki', prompt)) {
        return {kind: 'success', text: `${report}\n已在当前对话自动发起「反推补全」任务。\n`};
      }
      return {kind: 'success', text: `${report}\n${prompt}\n`};
    },
  });
  ctx.commands.register({
    name: 'harness-cli-plans',
    description: '任务总览 plans.html：--serve 起本机服务（按钮可直接删除 / 重跑 / 保存），--stop 停止',
    input: {hint: '[--serve] [--port 7788] [--stop]'},
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput ?? '');
      const tokens = raw.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
      let root;
      let port;
      let mode = 'open';
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--serve') mode = 'serve';
        else if (token === '--stop') mode = 'stop';
        else if (token === '--port') {
          const value = tokens[++index];
          if (value === undefined) return {kind: 'error', text: '`--port` 缺少取值'};
          port = Number(value);
        } else if (token === '--root' || token === '-r') {
          const value = tokens[++index];
          if (value === undefined) return {kind: 'error', text: '`--root` 缺少路径参数'};
          root = value.replace(/^["']|["']$/g, '');
        } else {
          return {kind: 'error', text: `无法识别的参数：${token}`};
        }
      }

      const resolved = resolveRoot(root, invocation?.agent?.session?.header?.cwd);
      if (resolved.error) return {kind: 'error', text: resolved.error};
      const ready = ensureRootDir(resolved.root, root);
      if (ready.error) return {kind: 'error', text: ready.error};

      if (mode === 'stop') {
        const run = await runCli(['plans', '--stop'], {cwd: resolved.root, signal: invocation?.signal});
        return {kind: run.exitCode === 0 ? 'success' : 'error', text: buildReport(run)};
      }

      if (mode !== 'serve') {
        const run = await runCli(['plans'], {cwd: resolved.root, signal: invocation?.signal});
        return {kind: run.exitCode === 0 ? 'success' : 'error', text: buildReport(run)};
      }

      const target = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 7788;
      const state = readPlansState(resolved.root);
      if (state && state.port === target && (await waitForPlans(target, 500))) {
        return {
          kind: 'success',
          text: `plans 服务已在运行：http://127.0.0.1:${target}/（pid ${state.pid}）\n`,
        };
      }

      const child = spawn(
        process.execPath,
        [BIN, 'plans', '--serve', '--port', String(target), '--root', resolved.root],
        {cwd: resolved.root, detached: true, stdio: 'ignore', env: childEnv()}
      );
      child.unref();

      const ok = await waitForPlans(target);
      if (!ok) {
        return {
          kind: 'error',
          text:
            `plans 服务没能在端口 ${target} 上启动（可能被占用，或启动失败）。\n` +
            `换端口：/harness-cli-plans --serve --port 7789；看错误：在项目里跑 dsh-plugin-harness-cli plans --serve --port ${target}\n`,
        };
      }
      return {
        kind: 'success',
        text:
          `plans 服务已启动：http://127.0.0.1:${target}/\n` +
          '页面上的删除 / 重跑 / 保存会直接改仓库文件；停止服务：/harness-cli-plans --stop\n',
      };
    },
  });
  ctx.commands.register({
    name: 'harness-cli-doctor',
    description: '工具自检：Node / 模板 / 配置 / 可写 / git / python3',
    input: {hint: '[root]'},
    handler: async (invocation) => {
      const parsed = parseCommandInput(invocation?.rawInput);
      if (parsed.error) return {kind: 'error', text: parsed.error};
      return runCommand('doctor', parsed, invocation?.agent?.session?.header?.cwd, invocation?.signal);
    },
  });
  ctx.commands.register({
    name: 'harness-cli-help',
    description: '查看所有 harness-cli 工具与斜杠命令的操作说明',
    input: {hint: '[命令或工具名]'},
    handler: async (invocation) => ({
      kind: 'success',
      text: buildHelpText(invocation?.rawInput),
    }),
  });
}

/**
 * 注册工具与命令。
 * @param {any} ctx - Cordis context（`tools` 必存在，`commands` 可选）。
 */
export function apply(ctx) {
  for (const spec of TOOL_SPECS) ctx.tools.register(buildTool(spec));
  if (typeof ctx.inject === 'function') ctx.inject(['commands'], (scoped) => registerCommands(scoped));
  else if (ctx.commands !== undefined) registerCommands(ctx);

  // DSH 的 todo_write 每次写 `todo/write` 会话事件；这里把它桥到任务页进度。
  // 事件处理是幂等的：只有 todo 状态与页面百分比不同才调用 progress。
  if (typeof ctx.on === 'function') {
    const bridge = createTodoBridge();
    ctx.on('session/event', (session, event) => {
      return bridge.handle(session, event).then((result) => {
        if (result && result.ok === false && !result.skipped) {
          const message = `[harness-cli] DSH todo 同步失败：${result.error || '未知错误'}`;
          if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message);
          else console.warn(message);
        }
        return result;
      });
    });
  }
}

export {parseCommandInput, parseTaskInput, resolveRoot, runCli, TOOL_SPECS, COMMAND_MANUAL, buildHelpText};
