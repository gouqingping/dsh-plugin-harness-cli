'use strict';

/**
 * 脚手架生成：把「要写哪些文件、内容是什么、已存在怎么办」算成一份计划，再执行。
 *
 * 三条纪律（与平台 harness 骨架一致）：
 * 1. 已存在的非空文件永不覆盖，除非显式 --force；
 * 2. 空文件视为"占位"，允许补齐；
 * 3. 先算计划再落盘，--dry-run 打印的就是真实发生的动作。
 */

const path = require('path');
const VERSION = require('../package.json').version;
const {loadTemplate} = require('./templates');
const {render} = require('./render');
const {buildContext} = require('./context');
const {renderPlans} = require('./plans');
const {exists, isDir, isEmptyFile, mkdirp, readIfExists, writeFileSafe, toPosix} = require('./util');

const GITIGNORE_MARKER = '# --- dsh-plugin-harness-cli ---';

function renderTemplate(key, ctx) {
  return render(loadTemplate(key), ctx);
}

function featureListJson(config, ctx) {
  return {
    project: config.project.name,
    description:
      '模块级功能清单：id / name / description / status / acceptance / evidence / depends_on。' +
      '本文件是唯一需求来源；Agent 只读，改范围必须由人显式修改本文件。',
    generatedAt: ctx.today,
    apiBaseUrl: '',
    databases: {},
    features: [
      {
        id: 'F-001',
        name: 'Harness 骨架就绪',
        description: '四件套 + 门禁 + 状态文件落盘，互相可达。',
        status: 'done',
        acceptance: [
          'AGENTS.md 能导航到 init.sh / feature_list.json / claude-progress.md',
          'gate.sh 可执行且失败时非零退出',
          'docs/current.md 与 claude-progress.md 存在',
        ],
        evidence: ['docs/current.md::工程初始化'],
        depends_on: [],
      },
      {
        id: 'F-002',
        name: '（下一个真实功能，替换本行）',
        description: '一句话说清输入、输出、边界。',
        status: 'pending',
        acceptance: ['（可验收的标准，一条一句）'],
        evidence: [],
        depends_on: ['F-001'],
      },
    ],
    conventions: [],
    maintenance: [],
  };
}

function taskQueueJson(ctx) {
  return {
    wipLimit: 1,
    updatedAt: new Date().toISOString(),
    items: [],
    note: '队列 / 优先级 / 依赖 / WIP 四要素；同时 in_progress 的数量不得超过 wipLimit（默认 1 = 单 WIP，多会话并行时调大）。',
    generatedBy: 'dsh-plugin-harness-cli',
    generatedAt: ctx.today,
  };
}

function summaryJson(config, ctx) {
  return {
    currentTask: null,
    status: 'initialized',
    goal: '',
    summary: `由 dsh-plugin-harness-cli 初始化 ${config.project.name} 的 Harness 配置。`,
    progress: {completed: ['Harness 骨架'], remaining: [], lastCommit: null},
    keyDecisions: [],
    nextStep: '补全 harness-cli.json 的 positioning 与 dirs，重跑 dsh-plugin-harness-cli agents',
    lastVerification: '',
    generatedBy: `dsh-plugin-harness-cli@${VERSION}`,
    updatedAt: new Date().toISOString(),
    generatedAt: ctx.today,
  };
}

function graphJson(config, ctx) {
  return {
    [`${config.project.name}:bootstrap`]: {
      dependsOn: [],
      affects: [config.paths.docs, config.paths.harness],
      status: 'initialized',
      lastVerified: ctx.today,
      lastVerification: 'dsh-plugin-harness-cli 生成 Harness 骨架',
    },
  };
}

/**
 * kind='state' 的是**状态文件**（进度日志、功能清单、任务队列）：
 * 它们只能由人和 Agent 增量维护，生成器再 --force 也不许覆盖——
 * 覆盖它们等于制造"跨会话状态丢失"，正是这个工具要消灭的失败模式。
 */
function entry(root, rel, content, mode, kind) {
  return {
    rel: toPosix(rel),
    abs: path.join(root, rel),
    content,
    mode,
    kind: kind || 'structural',
  };
}

/** 生成文件计划（不落盘）。 */
function buildPlan(root, config, opts = {}) {
  const ctx = buildContext(config, opts);
  const paths = config.paths;
  const plan = [];

  plan.push(entry(root, 'harness-cli.json', `${JSON.stringify(config, null, 2)}\n`));
  plan.push(entry(root, paths.agents, renderTemplate('agents', ctx)));
  plan.push(entry(root, paths.init, renderTemplate('init', ctx), 0o755));
  plan.push(entry(root, paths.gate, renderTemplate('gate', ctx), 0o755));
  plan.push(
    entry(root, paths.featureList, `${JSON.stringify(featureListJson(config, ctx), null, 2)}\n`, undefined, 'state')
  );
  plan.push(entry(root, paths.progress, renderTemplate('progress', ctx), undefined, 'state'));
  plan.push(entry(root, paths.taskQueue, `${JSON.stringify(taskQueueJson(ctx), null, 2)}\n`, undefined, 'state'));
  plan.push(entry(root, path.join(paths.docs, 'current.md'), renderTemplate('current', ctx), undefined, 'state'));
  plan.push(entry(root, path.join(paths.docs, 'summary.json'), `${JSON.stringify(summaryJson(config, ctx), null, 2)}\n`));
  plan.push(entry(root, path.join(paths.docs, 'graph.json'), `${JSON.stringify(graphJson(config, ctx), null, 2)}\n`));
  plan.push(entry(root, paths.adr, renderTemplate('adr', ctx)));
  if (paths.versionInfo) {
    plan.push(
      entry(
        root,
        path.join(paths.versionInfo, `v${config.project.version}.md`),
        renderTemplate('versionInfo', ctx)
      )
    );
  }
  plan.push(entry(root, path.join(paths.harness, `${ctx.ciIdentifier}.yaml`), renderTemplate('ci', ctx)));
  plan.push(entry(root, 'README.md', renderTemplate('readme', ctx)));
  plan.push(entry(root, 'plans.html', renderPlans(root, config)));

  for (const sub of ['specs', 'plans']) {
    plan.push({rel: toPosix(path.join(paths.docs, 'superpowers', sub, '.gitkeep')), abs: null, content: '', mode: undefined, isDirMarker: true});
  }

  // 规范文档的落盘处（DDD 的 design / SDD 的 spec / 任务规划 tasks）
  plan.push(entry(root, path.join(paths.specs, 'README.md'), renderTemplate('specsReadme', ctx)));

  // 并行 loop 的认领台：生成脚本 + 约定文档（claims.enabled=false 时整条链路跳过）
  if (ctx.claims.enabled) {
    plan.push(entry(root, paths.claimScript, renderTemplate('claimScript', ctx), 0o755));
    plan.push(entry(root, path.join(paths.claims, 'README.md'), renderTemplate('claimsReadme', ctx)));
  }

  const proto = ctx.prototype;
  if (proto.enabled) {
    plan.push(entry(root, path.join(proto.dir, 'README.md'), renderPrototypeReadme(ctx)));
    plan.push(entry(root, path.join(proto.dir, proto.templatePage), renderTemplate('progressHtml', ctx)));
    plan.push(entry(root, path.join(proto.dir, proto.indexPage), renderTemplate('progressIndex', ctx)));
    plan.push(entry(root, paths.prototypeCheck, renderTemplate('prototypeCheck', ctx), 0o755));
  }

  return plan;
}

/** README 与进度页模板共用 prototype-README.md.tmpl。 */
function renderPrototypeReadme(ctx) {
  return renderTemplate('prototypeReadme', ctx);
}

/** 执行计划：返回每一项的最终动作，供 CLI 打印。 */
function applyPlan(root, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const force = Boolean(opts.force);
  const results = [];

  for (const item of plan) {
    const rel = item.rel;
    if (item.isDirMarker) {
      const dir = path.dirname(path.join(root, item.rel));
      const action = isDir(dir) ? 'keep' : 'create';
      if (!dryRun && action === 'create') mkdirp(dir);
      results.push({rel: `${toPosix(path.relative(root, dir))}/`, action});
      continue;
    }

    const missing = !exists(item.abs);
    const empty = !missing && isEmptyFile(item.abs);
    const isState = item.kind === 'state';
    let action;
    if (missing || empty) action = 'create';
    else if (force && (!isState || opts.forceState)) action = 'overwrite';
    else action = 'keep';

    if (action !== 'keep' && !dryRun) {
      const content = item.mode === undefined ? item.content : item.content.replace(/\n$/, '\n');
      writeFileSafe(item.abs, content, item.mode);
    }
    results.push({rel, action});
  }

  // .gitignore 单独处理：已存在时只追加缺失的规则块
  results.push(applyGitignore(root, dryRun, force, opts));
  return results;
}

function applyGitignore(root, dryRun, force, opts) {
  const file = path.join(root, '.gitignore');
  const block = loadTemplate('gitignore');
  const current = readIfExists(file);
  if (current !== null && current.includes(GITIGNORE_MARKER) && !force) {
    return {rel: '.gitignore', action: 'keep'};
  }
  const content = current === null || current.trim() === '' ? block : `${current.replace(/\n$/, '')}\n\n${block}`;
  if (!dryRun) writeFileSafe(file, content);
  return {rel: '.gitignore', action: current === null ? 'create' : 'append'};
}

module.exports = {
  buildPlan,
  applyPlan,
  GITIGNORE_MARKER,
  featureListJson,
  taskQueueJson,
  summaryJson,
  graphJson,
};
