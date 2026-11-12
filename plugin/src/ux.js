'use strict';

/**
 * ux：把「任务文档 + UI 设计 + 项目需求」整理成一份覆盖整个项目的用户体验与需求分析报告。
 *
 * 设计取舍（与工具其他部分一致）：
 * - 全项目口径：`prototype/ux.html` 永远分析仓库里的全部任务，不会因为某次只选了部分任务而缩水；
 *   任务参数只决定 `--apply` 回写谁（单任务报告每次都会刷新）。
 * - 维度优先：用户与场景 → 需求拆解 → 任务关联 → 体验流程 → 异常与恢复 → 状态与反馈 →
 *   可用性 → 文档完整性；每个维度先给分析结论，再列缺口。
 * - 缺口可关闭：缺口有稳定编号，每次重跑按文档重算，修好的自动消失；
 *   推不出的可用 `ux --resolve <编号>` 逐条确认关闭，报告只列未关闭项。
 * - 关联同步：任务之间有关联（显式「关联任务：…」或文档里互相提及）时，`--apply` 会一并
 *   刷新关联任务的 UX 复核区块，并在报告里给出关联一致性与同步提示。
 * - 不编造：报告只汇总仓库里已经写下的事实；没有依据的写「待确认」，不猜。
 */

const crypto = require('crypto');
const path = require('path');
const {loadTemplate} = require('./templates');
const {render} = require('./render');
const {readIfExists, writeFileSafe, toPosix, today} = require('./util');
const {collectTasks} = require('./plans');
const {
  readProposal,
  readSpec,
  readDesign,
  sections,
  findSection,
  paragraphs,
} = require('./wikidocs');
const {uiGaps} = require('./ui');
const {upsertBlock} = require('./sync');

const UX_BEGIN = '<!-- ux-report:begin -->';
const UX_END = '<!-- ux-report:end -->';
const REQUIREMENTS_BEGIN = '<!-- ux-requirements:begin -->';
const REQUIREMENTS_END = '<!-- ux-requirements:end -->';
const REPORT_FILE = 'index.html';
const REPORT_JSON = 'report.json';
const GAP_FILE = '.ux-gaps.json';
const RESOLVED_FILE = '.ux-resolved.json';
const REQUIREMENTS_REL = 'ux/requirements.md';

// 「待填写」是正常的业务状态，不能当成占位符：只认带冒号/括号的占位写法
const PLACEHOLDER = /待补[：:（(]|待填[：:（(]|待填$|待业务确认|TODO|TBD/m;
const ROLE_RE = /(用户|客户|管理员|运营|访客|员工|学生|教师|医生|财务|销售|供应商|采购|仓库|审批人|客服)/g;
const ROLE_LINE_RE = /发起人|角色|用户|客户|管理员|运营|访客|员工|学生|教师|医生|财务|销售|供应商|采购|仓库|审批人|客服/;
const RELATION_LABEL_RE = /(关联任务|相关任务|依赖任务|前置任务|上下游任务)[：:]\s*([^\n]+)/g;

/** 分析维度：顺序即优先级，待确认清单与报告章节都按这个顺序排。 */
const DIMENSIONS = [
  {key: 'users', label: '用户与场景', priority: 1},
  {key: 'requirements', label: '需求拆解', priority: 2},
  {key: 'relations', label: '任务关联', priority: 3},
  {key: 'flow', label: '体验流程', priority: 4},
  {key: 'recovery', label: '异常与恢复', priority: 5},
  {key: 'states', label: '状态与反馈', priority: 6},
  {key: 'usability', label: '可用性', priority: 7},
  {key: 'docs', label: '文档完整性', priority: 8},
];
const DIMENSION_BY_KEY = new Map(DIMENSIONS.map((item) => [item.key, item]));
const LEVEL_ORDER = {'高': 0, '中': 1, '低': 2};

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 递归转义：报告是 HTML，所有来自仓库/用户的文本都必须先转义。 */
function deepEscape(value) {
  if (typeof value === 'string') return escapeHtml(value);
  if (Array.isArray(value)) return value.map(deepEscape);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepEscape(item);
    return out;
  }
  return value;
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = String(item || '').trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function clip(value, max = 120) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 把自定义需求拆成可逐条分析的需求句。 */
function splitRequirements(text) {
  return uniq(
    String(text || '')
      .split(/[\n。；;]+/)
      .map((line) => line.replace(/^[\s>*+\-\d.、)）]+/, '').trim())
      .filter((line) => line.length >= 2)
  );
}

/** 需求分类：功能 / 体验 / 约束。 */
function classifyRequirement(text) {
  if (/不能|不得|必须|仅|只允许|不超过|合规|权限|安全|性能|并发|预算|工期/.test(text)) return '约束';
  if (/快|顺畅|简单|清晰|友好|自动|一步|少|提示|引导|体验|流畅|容易/.test(text)) return '体验';
  return '功能';
}

function rolesIn(text) {
  const matches = String(text || '').match(ROLE_RE) || [];
  return uniq(matches).slice(0, 6);
}

function parseFlow(text) {
  const secs = sections(text || '');
  const roleLines = paragraphs(findSection(secs, [/参与角色/]));
  const flowLines = findSection(secs, [/业务流程图/]);
  const mainLine =
    (paragraphs(flowLines).find((line) => /^主流程|主流程[：:]/.test(line)) || '') ||
    (flowLines.join('\n').match(/主流程[：:]\s*([^\n]+)/) || [])[1] ||
    '';
  const main = clip(mainLine.replace(/^主流程[：:]\s*/, ''), 160);
  const usable = (lines) => lines.filter((line) => !PLACEHOLDER.test(line));
  return {
    roles: usable(roleLines),
    main,
    hasMain: main !== '' && !PLACEHOLDER.test(main),
    exceptions: usable(paragraphs(findSection(secs, [/异常路径/]))).slice(0, 8),
    states: usable(paragraphs(findSection(secs, [/状态流转/]))).slice(0, 8),
    hasDiagram: /```mermaid/.test(text || ''),
    hasPlaceholder: PLACEHOLDER.test(text || ''),
  };
}

function parseUi(text) {
  const secs = sections(text || '');
  const usable = (lines) => lines.filter((line) => !PLACEHOLDER.test(line));
  return {
    goal: usable(paragraphs(findSection(secs, [/页面目标/]))).slice(0, 3),
    states: usable(paragraphs(findSection(secs, [/状态与交互|状态/]))).slice(0, 6),
    accessibility: usable(paragraphs(findSection(secs, [/响应式与可访问性|可访问/]))).slice(0, 4),
    hasPlaceholder: PLACEHOLDER.test(text || ''),
  };
}

/** 七个可用性检查项：只判断「文档里能不能找到依据」，不替用户打分。 */
const HEURISTICS = [
  {name: '目标可感知', hint: '写清为什么做、谁受益'},
  {name: '流程闭环', hint: '主流程与异常路径都有'},
  {name: '错误可恢复', hint: '错误提示与恢复动作写清楚'},
  {name: '状态可见', hint: '加载 / 空 / 失败 / 锁定都有去向'},
  {name: '口径一致', hint: '统一语言与界面文案同一套说法'},
  {name: '少一步、可防错', hint: '校验前置、危险操作二次确认'},
  {name: '可访问与响应式', hint: '键盘可达、对比度、窄屏可用'},
];

function evaluateHeuristics({proposal, spec, design, flow, ui, customText}) {
  const acceptance = (proposal.acceptance || []).join(' ');
  const scope = (proposal.scopeIn || []).join(' ');
  const exceptions = (flow.exceptions || []).join(' ');
  const uiText = [ui.goal, ui.states, ui.accessibility].flat().join(' ');
  const all = `${acceptance} ${scope} ${exceptions} ${customText || ''}`;
  const checks = [
    (proposal.why || []).length > 0 || Boolean(customText),
    Boolean(flow.main) && (flow.exceptions || []).length > 0,
    /错误|失败|提示|校验|锁定|超时|重试/.test(all),
    (flow.states || []).length > 0,
    (design.terms || []).length > 0,
    /校验|确认|二次|防错|必填|限制|上限/.test(all),
    /响应式|可访问|键盘|对比度|窄屏/.test(uiText),
  ];
  return HEURISTICS.map((item, index) => ({
    name: item.name,
    hint: item.hint,
    ok: checks[index],
  }));
}

function emptyProposal() {
  return {why: [], scopeIn: [], scopeOut: [], acceptance: []};
}

/** 缺口稳定编号：任务 + 维度 + 缺口描述，改文档后仍可追踪同一条。 */
function gapId(task, dimension, item) {
  const digest = crypto
    .createHash('sha1')
    .update(`${task}\u0000${dimension}\u0000${item}`)
    .digest('hex');
  return `G-${digest.slice(0, 8)}`;
}

function protoDirOf(config) {
  return ((config.presets || {}).prototype || {}).dir || 'prototype';
}

function requirementsFileOf(root, config) {
  return path.join(root, config.paths.docs || 'docs', REQUIREMENTS_REL);
}

function resolutionsFileOf(root, config) {
  return path.join(root, protoDirOf(config), RESOLVED_FILE);
}

/** 读取项目级需求的受管区块；没有区块时把整篇当需求列表。 */
function readProjectRequirements(root, config) {
  const text = readIfExists(requirementsFileOf(root, config));
  if (text === null) return [];
  const start = text.indexOf(REQUIREMENTS_BEGIN);
  const stop = text.indexOf(REQUIREMENTS_END);
  const body = start !== -1 && stop > start ? text.slice(start + REQUIREMENTS_BEGIN.length, stop) : text;
  const lines = body
    .split(/\r?\n/)
    .map((line) => (line.match(/^\s*[-*]\s+(.+)$/) || [])[1])
    .filter(Boolean);
  return uniq(lines.flatMap((line) => splitRequirements(line)));
}

/**
 * 把本次 `--user-words` 并入 `docs/ux/requirements.md`，项目需求因此不会随某次运行丢失。
 * @returns {string|null} 写入的相对路径；没有新需求时返回 null。
 */
function saveUxRequirements(root, config, facts) {
  const added = uniq(facts.newRequirements || []);
  if (added.length === 0) return null;
  const merged = uniq([...(facts.storedRequirements || []), ...added]);
  const body = merged.map((text) => `- ${text}`).join('\n');
  const file = requirementsFileOf(root, config);
  const existing = readIfExists(file);
  if (existing === null) {
    const text = [
      '# 项目级 UX 需求',
      '',
      '> 由 `ux` 维护，一行一条，可直接手改；`ux --user-words "..."` 会追加到这里。',
      '> 整体报告会一直带上这些需求，不会因为某次只分析了部分任务而丢掉。',
      '',
      REQUIREMENTS_BEGIN,
      body,
      REQUIREMENTS_END,
      '',
    ].join('\n');
    writeFileSafe(file, text);
  } else {
    writeFileSafe(file, upsertBlock(existing, REQUIREMENTS_BEGIN, REQUIREMENTS_END, body));
  }
  return toPosix(path.relative(root, file));
}

function readResolutions(root, config) {
  const text = readIfExists(resolutionsFileOf(root, config));
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.resolved) ? parsed.resolved : [];
  } catch (error) {
    return [];
  }
}

function writeResolutions(root, config, entries) {
  const file = resolutionsFileOf(root, config);
  if (entries.length === 0 && readIfExists(file) === null) return;
  writeFileSafe(
    file,
    `${JSON.stringify({updatedAt: new Date().toISOString(), resolved: entries}, null, 2)}\n`
  );
}

/** 判断一条缺口是否属于某个任务（关联缺口会同时出现在两边的报告里）。 */
function appliesTo(gap, name) {
  return gap.task === name || (Array.isArray(gap.related) && gap.related.includes(name));
}

function relatedTaskNames(facts, name) {
  const out = [];
  for (const relation of facts.relations || []) {
    if (relation.from === name) out.push(relation.to);
    else if (relation.to === name) out.push(relation.from);
  }
  return uniq(out);
}

/**
 * 任务关联：显式「关联任务：…」优先，其次把文档里互相提及的任务记为「文档提及」。
 * @param {Array<object>} taskFacts - 每个任务解析后的文档事实。
 * @returns {Array<object>} 关联边（A → B，只保留一条）。
 */
function buildRelations(taskFacts) {
  const names = taskFacts.map((item) => item.name);
  const edges = new Map();
  const add = (from, to, kind, evidence) => {
    if (from === to || !names.includes(to)) return;
    const pair = [from, to].sort().join('\u0000');
    const prev = edges.get(pair);
    if (prev && (prev.kind === 'explicit' || kind !== 'explicit')) return;
    edges.set(pair, {
      from,
      to,
      kind,
      kindLabel: kind === 'explicit' ? '显式关联' : '文档提及',
      evidence,
      tone: kind === 'explicit' ? 'mid' : 'low',
    });
  };

  for (const item of taskFacts) {
    const text = [item.docs.proposal, item.docs.spec, item.docs.design, item.docs.flow, item.uiText]
      .filter(Boolean)
      .join('\n');
    const explicit = new Set();
    for (const match of text.matchAll(RELATION_LABEL_RE)) {
      for (const name of names) {
        if (name === item.name || !match[2].includes(name)) continue;
        explicit.add(name);
        add(item.name, name, 'explicit', clip(match[0], 100));
      }
    }
    for (const name of names) {
      if (name === item.name || explicit.has(name)) continue;
      const hit = text
        .split(/\r?\n/)
        .find((line) => line.includes(name) && !line.includes(item.name + ' · '));
      if (hit === undefined) continue;
      // 避免「登录」把「登录页面」也算成一条独立关联
      const longer = names.find(
        (other) => other !== name && other !== item.name && other.length > name.length && other.includes(name)
      );
      if (longer && text.includes(longer)) continue;
      add(item.name, name, 'mention', clip(hit, 100));
    }
  }
  return [...edges.values()];
}

function gapRow(facts, dimension, level, item, hint, blocking) {
  const meta = DIMENSION_BY_KEY.get(dimension) || {label: dimension, priority: 99};
  return {
    id: gapId(facts.task, dimension, item),
    level,
    tone: level === '高' ? 'high' : level === '中' ? 'mid' : 'low',
    dimension,
    dimensionLabel: meta.label,
    priority: meta.priority,
    task: facts.task,
    related: facts.related || [],
    item,
    hint,
    blocking: Boolean(blocking),
  };
}

function sortGaps(list) {
  return list.slice().sort(
    (a, b) =>
      a.priority - b.priority ||
      (LEVEL_ORDER[a.level] === undefined ? 9 : LEVEL_ORDER[a.level]) -
        (LEVEL_ORDER[b.level] === undefined ? 9 : LEVEL_ORDER[b.level]) ||
      a.task.localeCompare(b.task) ||
      a.id.localeCompare(b.id)
  );
}

function buildRelationsForTask(taskRows) {
  const relations = buildRelations(taskRows);
  const byTask = new Map();
  for (const row of taskRows) {
    const related = [];
    for (const relation of relations) {
      if (relation.from === row.name) related.push({name: relation.to, kind: relation.kind});
      else if (relation.to === row.name) related.push({name: relation.from, kind: relation.kind});
    }
    byTask.set(row.name, uniq(related.map((item) => item.name)));
  }
  return {relations, byTask};
}

/**
 * 把事实行收拢成报告数据：维度结论、缺口、摘要与下一步都从这里统一算。
 * 整体报告与单任务报告共用，避免两边口径漂移。
 */
function finalizeFacts(parts) {
  const {
    config,
    tasks,
    requirements,
    users,
    scenarios,
    flows,
    exceptions,
    states,
    heuristics,
    gaps,
    resolvedGaps,
    risks,
    relations,
    relatedByTask,
    projectRequirements,
    storedRequirements,
    newRequirements,
    selected,
    title,
    scopeLabel,
    reportPath,
    globalPath,
    isGlobal,
    resolutions,
    generatedAt,
  } = parts;

  const analysis = buildAnalysis({
    tasks,
    requirements,
    users,
    scenarios,
    flows,
    exceptions,
    states,
    heuristics,
    gaps,
    relations,
  });
  const usabilityTodo = heuristics.filter((row) => row.tone === 'todo').length;
  const dimensions = DIMENSIONS.map((meta) => {
    const open = gaps.filter((gap) => gap.dimension === meta.key);
    const closed = resolvedGaps.filter((gap) => gap.dimension === meta.key);
    const blocking = open.filter((gap) => gap.blocking).length;
    // 可用性没有「缺口」，但检查项待补时维度状态不能算已分析
    const todoCount = meta.key === 'usability' ? usabilityTodo : 0;
    const pending = open.length + todoCount;
    return {
      key: meta.key,
      label: meta.label,
      priority: meta.priority,
      conclusion: analysis[meta.key] || '',
      gapCount: open.length,
      todoCount,
      blocking,
      resolvedCount: closed.length,
      status: blocking > 0 ? '阻断' : pending > 0 ? '待补' : '已分析',
      tone: blocking > 0 ? 'high' : pending > 0 ? 'todo' : 'pass',
    };
  });

  const summary = {
    tasks: tasks.length,
    requirements: requirements.length,
    gaps: gaps.length,
    blocking: gaps.filter((gap) => gap.blocking).length,
    resolved: resolvedGaps.length,
    highRisks: uniq(risks.filter((risk) => risk.level === '高').map((risk) => risk.text)).length,
    pass: heuristics.filter((row) => row.tone === 'pass').length,
    todo: heuristics.filter((row) => row.tone === 'todo').length,
    custom: projectRequirements ? 1 : 0,
    relations: relations.length,
    dimensionsDone: dimensions.filter((item) => item.status === '已分析').length,
    dimensionsTotal: dimensions.length,
  };

  const facts = {
    generatedAt,
    today: today(),
    title,
    scopeLabel,
    reportPath,
    globalPath: globalPath || '',
    isGlobal: Boolean(isGlobal),
    hasCustom: projectRequirements !== null,
    customText: projectRequirements ? projectRequirements.text : '',
    requirementsPath: toPosix(path.join(config.paths.docs || 'docs', REQUIREMENTS_REL)),
    project: {
      name: config.project.name,
      positioning: config.project.positioning || '',
      stack: (config.project.stack || []).join('、'),
      runtime: config.project.runtime || '',
      version: config.project.version || '',
    },
    tasks,
    taskRows: tasks.map((task) => ({
      name: task.name,
      status: task.status,
      progress: task.progress,
      goal: task.goal,
      relatedText: (task.related || []).join('、'),
    })),
    requirements,
    users,
    scenarios,
    flows,
    exceptions,
    states,
    heuristics,
    gaps,
    resolvedGaps,
    blockingGaps: gaps.filter((gap) => gap.blocking),
    risks,
    relations,
    relatedByTask: Object.fromEntries(relatedByTask),
    dimensions,
    analysis,
    projectRequirements,
    storedRequirements,
    newRequirements,
    selected,
    resolutions,
    custom: projectRequirements,
    summary,
    nextSteps: [],
  };
  facts.nextSteps = buildNextSteps(facts);
  return facts;
}

function buildAnalysis({tasks, requirements, users, scenarios, flows, exceptions, states, heuristics, gaps, relations}) {
  const taskNames = tasks.map((task) => task.name);
  const ownerTasks = (rows) => new Set(rows.map((row) => row.task).filter((name) => taskNames.includes(name)));
  const total = tasks.length;
  const roleCovered = ownerTasks(users).size;
  const scenarioCovered = ownerTasks(scenarios).size;
  const flowCovered = flows.filter((row) => row.hasMain).length;
  const diagramCovered = flows.filter((row) => row.hasDiagram).length;
  const recoveryCovered = ownerTasks(exceptions).size;
  const stateCovered = ownerTasks(states).size;
  const uiCovered = tasks.filter((task) => task.hasUi).length;
  const placeholderTasks = tasks.filter((task) => task.hasPlaceholder).length;
  const requirementKinds = {功能: 0, 体验: 0, 约束: 0};
  for (const row of requirements) requirementKinds[row.kind] = (requirementKinds[row.kind] || 0) + 1;
  const projectRequirements = requirements.filter((row) => row.task === '项目需求');
  const missingAcceptance = gaps.filter(
    (gap) => gap.dimension === 'requirements' && gap.item.includes('验收')
  ).length;
  const explicit = relations.filter((row) => row.kind === 'explicit').length;
  const mentions = relations.length - explicit;
  const pass = heuristics.filter((row) => row.tone === 'pass').length;
  const todo = heuristics.length - pass;

  if (total === 0) {
    return {
      users:
        users.length > 0
          ? `当前只有项目需求：识别到 ${users.length} 条角色线索（${users.map((row) => row.text).join('、')}）；建任务后会把角色落到具体流程。`
          : '当前只有项目需求，还没点明目标用户；补「谁在什么场景下用」。',
      requirements: `拆出 ${requirements.length} 条项目需求（功能 ${requirementKinds['功能'] || 0} / 体验 ${requirementKinds['体验'] || 0} / 约束 ${requirementKinds['约束'] || 0}）；建任务后按任务继续拆。`,
      relations: '还没有任务，暂时没有任务关联。',
      flow: '还没有任务流程可分析。',
      recovery: '还没有任务的异常路径可分析。',
      states: '还没有任务的状态流转可分析。',
      usability: `可用性检查 ${heuristics.length} 项：通过 ${pass} 项 / 待补 ${todo} 项。`,
      docs: '还没有任务文档；先 page 建任务。',
    };
  }

  return {
    users:
      `识别到 ${users.length} 条角色线索，覆盖 ${roleCovered}/${total} 个任务` +
      (roleCovered < total ? `；${total - roleCovered} 个任务还没写「参与角色」。` : '。') +
      (scenarioCovered < total ? `另有 ${total - scenarioCovered} 个任务缺典型场景。` : ''),
    requirements:
      `拆出 ${requirements.length} 条需求（功能 ${requirementKinds['功能'] || 0} / 体验 ${requirementKinds['体验'] || 0} / ` +
      `约束 ${requirementKinds['约束'] || 0}），其中项目级需求 ${projectRequirements.length} 条` +
      (missingAcceptance > 0 ? `；${missingAcceptance} 个任务缺验收标准。` : '。'),
    relations:
      relations.length === 0
        ? '没有发现任务之间的关联；有关联时在 flow.md 写「关联任务：任务名」，更新时会同步刷新关联任务。'
        : `发现 ${relations.length} 组关联（显式 ${explicit} / 文档提及 ${mentions}）；--apply 会一并刷新关联任务的 UX 复核区块。`,
    flow:
      `${flowCovered}/${total} 个任务写了主流程，${diagramCovered}/${total} 个带流程图。` +
      (flowCovered < total ? '缺主流程的任务会阻断分析完成。' : ''),
    recovery:
      `${recoveryCovered}/${total} 个任务写了异常路径，共 ${exceptions.length} 条；` +
      (recoveryCovered < total ? `${total - recoveryCovered} 个任务还没写失败 / 超时 / 无权限怎么走。` : '恢复动作有文档依据。'),
    states:
      `${stateCovered}/${total} 个任务写了状态流转，共 ${states.length} 条；` +
      (stateCovered < total ? `${total - stateCovered} 个任务缺加载 / 空 / 失败 / 锁定的去向。` : '状态去向清楚。'),
    usability:
      `可用性检查 ${heuristics.length} 项：通过 ${pass} 项 / 待补 ${todo} 项；判的是文档里有没有依据，不是体验打分。`,
    docs:
      `${uiCovered}/${total} 个任务有 UI 设计稿；${placeholderTasks} 个任务文档仍留占位符。`,
  };
}

function buildNextSteps(facts) {
  const steps = [];
  if (facts.summary.blocking > 0) {
    steps.push({
      text:
        `先按维度优先级补 ${facts.summary.blocking} 处阻断缺口（用户与场景 → 需求拆解 → 体验流程 → ` +
        '异常与恢复）；每补完一条重跑 ux，清单会自动移除已补项。',
    });
  }
  if (facts.summary.gaps > 0) {
    steps.push({
      text:
        `剩余 ${facts.summary.gaps} 处待确认：补文档后重跑 ux；已经确认、文档无法自动证明的，` +
        '用 `ux --resolve <编号> --by "确认人"` 逐条关闭。',
    });
  }
  if (facts.tasks.length > 0) {
    const related = facts.summary.relations > 0 ? '；有关联任务时会一并刷新它们的 UX 复核区块' : '';
    steps.push({text: `把结论回写到任务设计：在 DSH 里选择「更新任务」，或跑 ux --apply <任务名>${related}。`});
    steps.push({text: '更新完跑 review 与 plan，确认后再按步骤实现。'});
  }
  if (facts.hasCustom) {
    steps.push({text: '需要新任务时，在 DSH 里选择「创建任务」，会建任务页与规范文档并派发后续流程。'});
  }
  steps.push({text: '有界面的任务补 ui/README.md 的状态与契约对应，报告会随之刷新。'});
  return steps;
}

/**
 * 生成报告数据（不写盘）。
 * @param {string} root - 仓库根目录。
 * @param {object} config - 生效配置。
 * @param {{tasks?: string[], userWords?: string}} options - 要回写的任务与本次新增需求。
 * @returns {object} 模板作用域 + 缺口 / 风险清单。
 */
function collectUxFacts(root, config, options = {}) {
  const selected = uniq(Array.isArray(options.tasks) ? options.tasks : []);
  const customText = String(options.userWords || '').trim();
  const all = collectTasks(root, config);
  const byName = new Map(all.map((task) => [task.name, task]));
  const unknown = selected.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    const hint = all.length > 0 ? `现有任务：${all.map((task) => task.name).join('、')}` : '仓库里还没有任务';
    throw new Error(`没有找到任务：${unknown.join('、')}。${hint}`);
  }

  const storedRequirements = readProjectRequirements(root, config);
  const newRequirements = uniq(
    splitRequirements(customText).filter((text) => !storedRequirements.includes(text))
  );
  const projectTexts = uniq([...storedRequirements, ...newRequirements]);
  if (all.length === 0 && projectTexts.length === 0) {
    throw new Error(
      '仓库里还没有任务，也没有项目需求：先用 page 建任务，或 ux --user-words "谁在什么场景下要解决什么"'
    );
  }

  const protoDir = protoDirOf(config);
  const specBase = config.paths.specs || 'docs/specs';
  const requirementRows = [];
  const userRows = [];
  const scenarioRows = [];
  const flowRows = [];
  const exceptionRows = [];
  const stateRows = [];
  const heuristicRows = [];
  const riskRows = [];
  const taskRows = [];
  const taskGaps = [];
  const taskFacts = [];

  for (const task of all) {
    const specDir = path.join(root, specBase, task.name);
    const proposal = readProposal(specDir, task.name) || emptyProposal();
    for (const key of ['why', 'scopeIn', 'scopeOut', 'acceptance']) {
      proposal[key] = (proposal[key] || []).filter((text) => !PLACEHOLDER.test(text));
    }
    const spec = readSpec(specDir, task.name) || {contracts: []};
    spec.contracts = (spec.contracts || []).filter(
      (contract) => !PLACEHOLDER.test(`${contract.id} ${contract.title}`)
    );
    const design = readDesign(specDir, task.name) || {terms: [], invariants: []};
    design.terms = (design.terms || []).filter((term) => !PLACEHOLDER.test(term.meaning));
    const flow = parseFlow(task.docs.flow);
    const uiText = readIfExists(path.join(root, protoDir, task.name, 'ui', 'README.md')) || '';
    const ui = parseUi(uiText);
    const uiMissing = readIfExists(path.join(root, protoDir, task.name, 'ui', 'index.html')) === null;
    const uiTaskGaps = uiGaps(root, task.name, config);
    taskFacts.push({
      name: task.name,
      status: task.status,
      progress: task.total,
      docs: task.docs,
      uiText,
      proposal,
      spec,
      design,
      flow,
      ui,
      uiMissing,
      uiTaskGaps,
      hasUi: !uiMissing,
      hasPlaceholder: [task.docs.flow, task.docs.proposal, task.docs.design].some((text) =>
        PLACEHOLDER.test(text || '')
      ),
    });

    const requirements = [];
    for (const text of proposal.scopeIn) requirements.push({text, source: '提案范围'});
    for (const text of proposal.acceptance) requirements.push({text, source: '验收标准'});
    for (const contract of spec.contracts) requirements.push({text: `${contract.id} ${contract.title}`, source: '契约'});
    const uniqueRequirements = [];
    const seen = new Set();
    for (const item of requirements) {
      if (seen.has(item.text) || !item.text || PLACEHOLDER.test(item.text)) continue;
      seen.add(item.text);
      uniqueRequirements.push(item);
    }
    uniqueRequirements.slice(0, 14).forEach((item) => {
      requirementRows.push({
        id: `R-${String(requirementRows.length + 1).padStart(2, '0')}`,
        task: task.name,
        kind: classifyRequirement(item.text),
        text: clip(item.text.replace(/[；;，,。]+$/, ''), 150),
        source: item.source,
      });
    });

    const roles = flow.roles.filter((line) => ROLE_LINE_RE.test(line));
    for (const text of roles.slice(0, 6)) userRows.push({task: task.name, text: clip(text, 140)});

    const scenarios = [];
    if (flow.hasMain) scenarios.push(flow.main);
    for (const line of proposal.acceptance) if (/当|时|之后|之前|第一次/.test(line)) scenarios.push(line);
    if (scenarios.length === 0 && proposal.why.length > 0) scenarios.push(proposal.why[0]);
    for (const text of uniq(scenarios).slice(0, 5)) scenarioRows.push({task: task.name, text: clip(text, 150)});

    flowRows.push({
      task: task.name,
      main: flow.hasMain ? clip(flow.main, 180) : '待补：主流程（读 docs/specs/' + task.name + '/flow.md）',
      hasMain: flow.hasMain,
      hasDiagram: flow.hasDiagram,
      exceptions: flow.exceptions.length,
      states: flow.states.length,
    });
    for (const text of flow.exceptions.slice(0, 6)) exceptionRows.push({task: task.name, text: clip(text, 150)});
    for (const text of flow.states.slice(0, 6)) stateRows.push({task: task.name, text: clip(text, 150)});

    const checks = evaluateHeuristics({proposal, spec, design, flow, ui, customText: ''});
    for (const check of checks) {
      heuristicRows.push({
        task: task.name,
        name: check.name,
        status: check.ok ? '通过' : '待补',
        tone: check.ok ? 'pass' : 'todo',
        note: check.ok ? '文档里有依据' : check.hint,
      });
    }
    const pass = checks.filter((check) => check.ok).length;
    const todo = checks.length - pass;

    const context = {task: task.name};
    const pushGap = (dimension, level, item, hint, blocking) => {
      const row = gapRow(context, dimension, level, item, hint, blocking);
      taskGaps.push(row);
      return row;
    };

    if (roles.length === 0) {
      pushGap('users', '中', '没有写清目标用户 / 角色', `补 docs/specs/${task.name}/flow.md 的「参与角色」`, false);
    }
    if (scenarios.length === 0) {
      pushGap('users', '中', '没有可读的典型使用场景', '补「谁在什么时候用、要完成什么」', false);
    }
    if (!flow.hasMain) {
      pushGap(
        'flow',
        '高',
        '业务流程图没有主流程',
        `补 docs/specs/${task.name}/flow.md 的主流程与异常路径`,
        true
      );
    }
    if (!flow.hasDiagram) {
      pushGap('flow', '低', '没有业务流程图', '补 flow.md 的 mermaid 流程图，页面与测试都以它为准', false);
    }
    if (proposal.why.length === 0) {
      pushGap('requirements', '高', '没有说明为什么做', '补 proposal.md 的「为什么做」', true);
    }
    if (proposal.acceptance.length === 0) {
      pushGap('requirements', '高', '没有验收标准', '补 proposal.md 的「验收」', true);
    }
    if (proposal.scopeIn.length === 0) {
      pushGap('requirements', '中', '提案没有写范围', '补 proposal.md 的「做什么」', false);
    }
    if (spec.contracts.length === 0) {
      pushGap(
        'requirements',
        '中',
        '没有可核对的契约',
        '补 spec.md 的输入 / 输出 / 错误语义 / 验收标准',
        false
      );
    }
    if (flow.exceptions.length === 0) {
      pushGap('recovery', '中', '没有写异常路径', '补失败 / 超时 / 并发冲突 / 无权限怎么走', false);
    }
    if (flow.states.length === 0) {
      pushGap('states', '低', '没有写状态流转', '补哪些状态可以互转、谁触发', false);
    }
    if (design.terms.length === 0) {
      pushGap('docs', '低', '统一语言缺失', '补 design.md 的「统一语言」', false);
    }
    let uiGapId = '';
    if (uiMissing) {
      uiGapId = pushGap('docs', '中', '没有 UI 设计稿', `需要界面时跑 ui ${task.name}`, false).id;
    } else if (uiTaskGaps.length > 0) {
      pushGap(
        'docs',
        '低',
        'UI 设计说明还有待补项',
        '补 ui/README.md 的页面目标 / 状态 / 契约对应',
        false
      );
    }
    if (taskFacts[taskFacts.length - 1].hasPlaceholder) {
      pushGap('docs', '中', '任务文档里还留着待补占位', '把「待补 / 待业务确认」换成事实，再重跑 ux', true);
    }

    const high = taskGaps.filter((gap) => gap.task === task.name && gap.level === '高');
    for (const gap of high.slice(0, 3)) {
      riskRows.push({level: '高', tone: 'high', text: gap.item, source: task.name, gapId: gap.id});
    }
    if (uiMissing) {
      riskRows.push({
        level: '中',
        tone: 'mid',
        text: '体验细节只能从文档推断，界面状态未验证',
        source: task.name,
        gapId: uiGapId,
      });
    }

    taskRows.push({
      name: task.name,
      status: task.status,
      progress: task.total,
      goal: clip(proposal.why[0] || '待确认：这个任务为谁解决什么问题', 180),
      requirementCount: Math.min(uniqueRequirements.length, 14),
      pass,
      todo,
      hasUi: !uiMissing,
      hasPlaceholder: taskFacts[taskFacts.length - 1].hasPlaceholder,
      risks: high.slice(0, 2).map((gap) => gap.item),
    });
  }

  // 关联任务：报告里显式列出，--apply 时按这个关系同步刷新。
  const {relations, byTask: relatedByTask} = buildRelationsForTask(
    taskFacts.map((item) => ({
      name: item.name,
      docs: item.docs,
      uiText: item.uiText,
    }))
  );
  for (const task of taskRows) task.related = relatedByTask.get(task.name) || [];

  // 关联任务间的术语口径不一致：两边都会在待确认里看到同一条。
  const seenPairs = new Set();
  for (const relation of relations) {
    const pairKey = [relation.from, relation.to].sort().join('\u0000');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const left = taskFacts.find((item) => item.name === relation.from);
    const right = taskFacts.find((item) => item.name === relation.to);
    if (!left || !right) continue;
    for (const term of left.design.terms) {
      const other = right.design.terms.find((item) => item.term === term.term);
      if (!other || other.meaning.trim() === term.meaning.trim()) continue;
      const item = `术语「${term.term}」在「${relation.from}」与「${relation.to}」中定义不一致`;
      const conflictGap = gapRow(
        {task: relation.from, related: [relation.from, relation.to]},
        'relations',
        '中',
        item,
        `统一 design.md 的「统一语言」，再重跑 ux`,
        false
      );
      taskGaps.push(conflictGap);
      riskRows.push({
        level: '中',
        tone: 'mid',
        text: item,
        source: '任务关联',
        gapId: conflictGap.id,
      });
    }
  }

  // 同一维度、同一缺口出现在关联任务里时，提示一起改，避免只修一半。
  for (const gap of taskGaps) {
    const related = relatedTaskNames({relations}, gap.task);
    const same = taskGaps.filter(
      (other) =>
        other !== gap &&
        other.task !== gap.task &&
        other.dimension === gap.dimension &&
        other.item === gap.item &&
        related.includes(other.task)
    );
    if (same.length === 0) continue;
    gap.alsoIn = uniq(same.map((other) => other.task));
    gap.hint = `${gap.hint}；关联任务 ${gap.alsoIn.join('、')} 也有同类项，一起处理`;
  }

  let projectRequirements = null;
  if (projectTexts.length > 0) {
    const items = projectTexts.map((text) => ({
      kind: classifyRequirement(text),
      text: clip(text, 160),
    }));
    items.forEach((item) => {
      requirementRows.push({
        id: `R-${String(requirementRows.length + 1).padStart(2, '0')}`,
        task: '项目需求',
        kind: item.kind,
        text: item.text.replace(/[；;，,。]+$/, ''),
        source: '项目需求',
      });
    });
    const joined = projectTexts.join('；');
    const checks = evaluateHeuristics({
      proposal: {why: [joined], scopeIn: [], acceptance: []},
      spec: {contracts: []},
      design: {terms: []},
      flow: {main: '', exceptions: [], states: []},
      ui: {goal: [], states: [], accessibility: []},
      customText: joined,
    });
    for (const check of checks) {
      heuristicRows.push({
        task: '项目需求',
        name: check.name,
        status: check.ok ? '通过' : '待补',
        tone: check.ok ? 'pass' : 'todo',
        note: check.ok ? '需求原文里有依据' : check.hint,
      });
    }
    const users = rolesIn(joined);
    for (const user of users) userRows.push({task: '项目需求', text: user});
    const customScenarios = projectTexts.filter((line) => /当|场景|时|每次|失败|超时/.test(line));
    for (const text of uniq(customScenarios).slice(0, 5)) {
      scenarioRows.push({task: '项目需求', text: clip(text, 150)});
    }
    if (users.length === 0) {
      taskGaps.push(
        gapRow({task: '项目需求'}, 'users', '中', '项目需求没有点明目标用户', '补一句「谁在什么场景下用」', false)
      );
    }
    if (!/验收|成功|完成|失败|标准|通过/.test(joined)) {
      taskGaps.push(
        gapRow({task: '项目需求'}, 'requirements', '高', '项目需求没有写成功标准', '补「什么算做成、什么算失败」', true)
      );
    }
    const keyword = (joined.match(/支付|权限|通知|实时|导出|对接|第三方|短信|邮件|审批/) || [])[0];
    if (keyword) {
      riskRows.push({
        level: '中',
        tone: 'mid',
        text: `需求涉及「${keyword}」，外部依赖与边界待确认`,
        source: '项目需求',
      });
    }
    projectRequirements = {
      count: items.length,
      newCount: newRequirements.length,
      requirements: items,
      users,
      scenarios: uniq(customScenarios).slice(0, 5),
      text: joined,
    };
  }

  // 关闭记录：只保留当前仍能算出来的缺口，文档修好后条目自动清理。
  const store = readResolutions(root, config);
  const rawIds = new Set(taskGaps.map((gap) => gap.id));
  const resolutions = (store || []).filter((entry) => entry && rawIds.has(entry.id));
  const closedIds = new Set(resolutions.map((entry) => entry.id));
  const openGaps = sortGaps(taskGaps.filter((gap) => !closedIds.has(gap.id)));
  const byId = new Map(resolutions.map((entry) => [entry.id, entry]));
  const resolvedGaps = sortGaps(
    taskGaps
      .filter((gap) => closedIds.has(gap.id))
      .map((gap) => {
        const entry = byId.get(gap.id) || {};
        return {
          ...gap,
          resolved: true,
          resolvedAt: entry.resolvedAt || '',
          by: entry.by || '用户',
        };
      })
  );

  // 已关闭的缺口不再算风险，否则「待确认清零」了风险表还在报同一条
  const closedKeys = new Set(resolvedGaps.map((gap) => `${gap.task}\u0000${gap.item}`));
  const closedGapIds = new Set(resolvedGaps.map((gap) => gap.id));
  const riskMap = new Map();
  for (const risk of riskRows) {
    if (risk.gapId && closedGapIds.has(risk.gapId)) continue;
    if (closedKeys.has(`${risk.source}\u0000${risk.text}`)) continue;
    const key = `${risk.level}\u0000${risk.tone}\u0000${risk.text}\u0000${risk.source}`;
    if (!riskMap.has(key)) riskMap.set(key, risk);
  }

  const scopeParts = [];
  scopeParts.push(all.length > 0 ? `全部 ${all.length} 个任务` : '无任务');
  if (projectRequirements) scopeParts.push(`项目需求 ${projectRequirements.count} 条`);

  return finalizeFacts({
    config,
    tasks: taskRows,
    requirements: requirementRows,
    users: userRows,
    scenarios: scenarioRows,
    flows: flowRows,
    exceptions: exceptionRows,
    states: stateRows,
    heuristics: heuristicRows,
    gaps: openGaps,
    resolvedGaps,
    risks: [...riskMap.values()],
    relations,
    relatedByTask,
    projectRequirements,
    storedRequirements,
    newRequirements,
    selected,
    title: `${config.project.name || '项目'} · UX 与需求分析报告`,
    scopeLabel: scopeParts.join(' + '),
    reportPath: toPosix(path.join(protoDir, 'ux.html')),
    isGlobal: true,
    resolutions: {entries: resolutions, path: toPosix(path.join(protoDir, RESOLVED_FILE))},
    generatedAt: new Date().toISOString(),
  });
}

/** 从整体事实里切出单个任务的一份报告（不再重复读文档）。 */
function sliceFacts(facts, task, protoDir, config) {
  const name = task.name;
  const pick = (list, key = 'task') => list.filter((item) => item[key] === name);
  const requirements = pick(facts.requirements);
  const gaps = facts.gaps.filter((gap) => appliesTo(gap, name));
  const resolvedGaps = facts.resolvedGaps.filter((gap) => appliesTo(gap, name));
  const heuristics = pick(facts.heuristics);
  const risks = facts.risks.filter((risk) => risk.source === name);
  const relations = facts.relations.filter(
    (relation) => relation.from === name || relation.to === name
  );
  const sliced = finalizeFacts({
    config,
    tasks: [task],
    requirements,
    users: pick(facts.users),
    scenarios: pick(facts.scenarios),
    flows: pick(facts.flows),
    exceptions: pick(facts.exceptions),
    states: pick(facts.states),
    heuristics,
    gaps,
    resolvedGaps,
    risks,
    relations,
    relatedByTask: new Map([[name, relatedTaskNames(facts, name)]]),
    projectRequirements: null,
    storedRequirements: [],
    newRequirements: [],
    selected: [],
    title: `${name} · UX 与需求分析报告`,
    scopeLabel: name,
    reportPath: toPosix(path.join(protoDir, name, 'ux', REPORT_FILE)),
    globalPath: facts.reportPath,
    isGlobal: false,
    resolutions: {entries: [], path: facts.resolutions.path},
    generatedAt: facts.generatedAt,
  });
  return sliced;
}

function writeJsonFile(file, value) {
  const plain = {...value};
  delete plain.blockingGaps;
  writeFileSafe(file, `${JSON.stringify(plain, null, 2)}\n`);
}

function writeGapJson(file, facts) {
  writeFileSafe(
    file,
    `${JSON.stringify(
      {
        generatedAt: facts.generatedAt,
        project: facts.project.name,
        count: facts.gaps.length,
        blocking: facts.blockingGaps.length,
        resolved: facts.resolvedGaps.length,
        requirements: facts.requirementsPath,
        gaps: facts.gaps,
        resolvedGaps: facts.resolvedGaps,
      },
      null,
      2
    )}\n`
  );
}

/**
 * 写两类报告：
 * - 全量：`prototype/ux.html`（+ `prototype/ux.json`、`prototype/.ux-gaps.json`），永远覆盖全部任务；
 * - 单任务：`prototype/<任务>/ux/index.html`（+ `report.json`、`.ux-gaps.json`）。
 *
 * @param {string} root - 仓库根目录。
 * @param {object} config - 生效配置。
 * @param {object} facts - collectUxFacts() 的结果（全量）。
 * @returns {{global: object, tasks: Array<object>}} 相对仓库的路径。
 */
function writeUxReports(root, config, facts) {
  const protoDir = protoDirOf(config);
  const base = path.join(root, protoDir);
  const global = {
    html: toPosix(path.join(protoDir, 'ux.html')),
    json: toPosix(path.join(protoDir, 'ux.json')),
    gaps: toPosix(path.join(protoDir, GAP_FILE)),
    requirements: facts.requirementsPath,
    resolutions: facts.resolutions.path,
  };
  writeFileSafe(path.join(base, 'ux.html'), render(loadTemplate('uxReport'), deepEscape(facts)));
  writeJsonFile(path.join(base, 'ux.json'), facts);
  writeGapJson(path.join(base, GAP_FILE), facts);

  const tasks = [];
  for (const task of facts.tasks) {
    const sliced = sliceFacts(facts, task, protoDir, config);
    const dir = path.join(base, task.name, 'ux');
    writeFileSafe(path.join(dir, REPORT_FILE), render(loadTemplate('uxReport'), deepEscape(sliced)));
    writeJsonFile(path.join(dir, REPORT_JSON), sliced);
    writeGapJson(path.join(dir, GAP_FILE), sliced);
    tasks.push({
      name: task.name,
      html: toPosix(path.join(protoDir, task.name, 'ux', REPORT_FILE)),
      json: toPosix(path.join(protoDir, task.name, 'ux', REPORT_JSON)),
      gaps: toPosix(path.join(protoDir, task.name, 'ux', GAP_FILE)),
    });
  }

  writeResolutions(root, config, facts.resolutions.entries);
  return {global, tasks};
}

/**
 * 把报告结论写回任务 design.md（受管区块，可重复执行）。
 *
 * `--apply` 只回写选中的任务，但会顺带刷新与它们直接关联的任务，保证跨任务口径同步。
 * @param {string[]} [selected] - 用户明确要更新的任务；省略时用 collect 时的 tasks 参数。
 * @returns {{updated: string[], unchanged: string[], skipped: string[], related: string[]}}
 */
function applyUxContext(root, config, facts, selected) {
  const updated = [];
  const unchanged = [];
  const skipped = [];
  const base = uniq(selected && selected.length > 0 ? selected : facts.selected || []);
  const targets = uniq([
    ...base,
    ...base.flatMap((name) => relatedTaskNames(facts, name)),
  ]);
  const related = targets.filter((name) => !base.includes(name));
  const specBase = config.paths.specs || 'docs/specs';
  for (const task of facts.tasks) {
    if (!targets.includes(task.name)) continue;
    const file = path.join(root, specBase, task.name, 'design.md');
    const text = readIfExists(file);
    if (text === null) {
      skipped.push(task.name);
      continue;
    }
    const taskGaps = facts.gaps.filter((gap) => appliesTo(gap, task.name));
    const taskResolved = facts.resolvedGaps.filter((gap) => appliesTo(gap, task.name));
    const relatedNames = relatedTaskNames(facts, task.name);
    const risks =
      taskGaps
        .filter((gap) => gap.level === '高')
        .slice(0, 2)
        .map((gap) => gap.item)
        .join('；') || '未发现高优先级风险';
    const gaps =
      taskGaps.length > 0
        ? taskGaps
            .slice(0, 4)
            .map((gap) => `${gap.id} ${gap.item}`)
            .join('；')
        : '无';
    const reportPath = toPosix(path.join(protoDirOf(config), task.name, 'ux', REPORT_FILE));
    const body = [
      '## UX 复核（与 `' + reportPath + '` 同步）',
      '',
      `- 单任务报告：\`${reportPath}\``,
      `- 整体报告：\`${facts.reportPath}\``,
      `- 生成：${facts.today}`,
      `- 需求：${task.requirementCount} 条；可用性检查：通过 ${task.pass} / 待补 ${task.todo}`,
      ...(facts.projectRequirements ? [`- 项目需求：${facts.projectRequirements.count} 条（见报告）`] : []),
      ...(relatedNames.length > 0 ? [`- 关联任务：${relatedNames.join('、')}（本次一并刷新）`] : []),
      ...(taskResolved.length > 0 ? [`- 已确认关闭：${taskResolved.length} 项`] : []),
      `- 主要风险：${risks}`,
      `- 待确认：${gaps}`,
      '',
      '> 这一段由 `ux` 自动维护；改任务文档后重新跑 `ux --apply` 即可同步。',
    ].join('\n');
    const next = upsertBlock(text, UX_BEGIN, UX_END, body);
    if (next === text) {
      unchanged.push(task.name);
      continue;
    }
    writeFileSafe(file, next);
    updated.push(task.name);
  }
  return {updated, unchanged, skipped, related, selected: base};
}

/**
 * 逐条关闭待确认项：写入 `prototype/.ux-resolved.json`，下次重跑仍保持关闭；
 * 文档改好后缺口本身消失，关闭记录会一起被清理。
 * @param {string[]} ids - 缺口编号。
 * @param {string} by - 确认人。
 * @returns {{resolved: object[], already: string[], unknown: string[], path: string}}
 */
function resolveUxGaps(root, config, ids, by) {
  const facts = collectUxFacts(root, config, {});
  const wanted = uniq(ids);
  const openById = new Map(facts.gaps.map((gap) => [gap.id, gap]));
  const closedIds = new Set(facts.resolvedGaps.map((gap) => gap.id));
  const entries = facts.resolutions.entries.slice();
  const resolved = [];
  const already = [];
  const unknown = [];
  for (const id of wanted) {
    const gap = openById.get(id);
    if (gap) {
      entries.push({
        id,
        task: gap.task,
        dimension: gap.dimension,
        item: gap.item,
        level: gap.level,
        resolvedAt: new Date().toISOString(),
        by: by || '用户',
      });
      resolved.push(gap);
      continue;
    }
    if (closedIds.has(id)) already.push(id);
    else unknown.push(id);
  }
  writeResolutions(root, config, entries);
  return {
    resolved,
    already,
    unknown,
    path: toPosix(path.relative(root, resolutionsFileOf(root, config))),
  };
}

module.exports = {
  UX_BEGIN,
  UX_END,
  REQUIREMENTS_BEGIN,
  REQUIREMENTS_END,
  REPORT_FILE,
  RESOLVED_FILE,
  DIMENSIONS,
  collectUxFacts,
  writeUxReports,
  sliceFacts,
  applyUxContext,
  resolveUxGaps,
  saveUxRequirements,
  readProjectRequirements,
  splitRequirements,
  classifyRequirement,
  parseFlow,
  parseUi,
  evaluateHeuristics,
  gapId,
  relatedTaskNames,
  escapeHtml,
  deepEscape,
};
