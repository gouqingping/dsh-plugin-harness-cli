'use strict';

/**
 * 任务内容模型：`plan` 用它一次性补齐 `docs/specs/<任务>/*.md`、任务页与方案页。
 *
 * 设计取舍：
 * - 只做「能确定的」：任务名、用户原话、契约骨架、步骤骨架；
 * - 人可以直接改文档；再跑 plan 时，已填好的文档默认不覆盖（除非 --force）；
 * - 生成内容不带「待填」，让 review/确认能往下走；真正的质量判断留给 review + 人工确认。
 */

const SPEC_FILES = ['proposal.md', 'spec.md', 'design.md', 'tasks.md'];

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 文本转义（Markdown 里只需要处理行首的特殊情况，这里保持原文）。 */
function asText(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text.length > 0 ? text : fallback;
}

/**
 * 生成默认内容模型。
 * @param {{task: string, userWords?: string}} input - 任务名与原话。
 * @returns {object} 内容模型。
 */
function defaultModel(input) {
  const task = input.task;
  const words = asText(input.userWords, `实现「${task}」`);
  return {
    task,
    userWords: words,
    goal: asText(input.userWords, `完成「${task}」`),
    scope: `「${task}」涉及的页面 / 接口 / 数据改动`,
    nonGoals: [`与「${task}」无关的重构`, `本任务之外的新功能`],
    context: `${task}（默认取任务名，确认时请核对边界）`,
    terms: [
      {term: task, definition: `本任务要交付的能力`},
      {term: '用户', definition: '触发本任务的人或系统'},
      {term: '结果', definition: '任务完成后可观测的变化'},
    ],
    aggregates: [`${task} 的核心对象（含它守住的规则）`],
    invariants: ['失败不改变已保存的数据；同一请求重复提交结果一致'],
    contracts: [
      {
        id: 'S-01',
        title: `「${task}」主流程`,
        input: '用户按入口进入并提交合法输入',
        output: `完成「${task}」并返回可观测结果`,
        error: '输入非法时给出可读错误，不写半成品',
        accept: '主流程测试通过，错误提示可读',
      },
      {
        id: 'S-02',
        title: `「${task}」错误与边界`,
        input: '空值 / 超长 / 并发重复提交',
        output: '明确拒绝，或幂等返回同一结果',
        error: '越权、重复、超时都返回可识别错误',
        accept: '边界用例覆盖空值、重复与超时',
      },
    ],
    steps: [
      {title: '确认目标与边界', spec: 'S-01'},
      {title: '实现主流程', spec: 'S-01'},
      {title: '补错误与边界用例', spec: 'S-02'},
      {title: '回归与交付', spec: 'S-02'},
    ],
    acceptance: [
      'S-01 主流程可执行验证',
      'S-02 边界用例全部通过',
      '门禁（lint + 测试 + 校验）全绿',
    ],
    flow: {
      main: '用户进入入口 → 提交 → 系统校验 → 返回结果',
      error: '校验失败返回可读错误；重复提交幂等；超时提示重试',
      state: '待开始 → 进行中 → 待验收 → 完成',
    },
    risks: {
      data: '失败回滚，不留下半成品数据',
      deps: '无外部强依赖；如有，在方案页写明',
      none: '不改造与本任务无关的模块',
    },
  };
}

/**
 * 把命令行参数合并进模型（参数优先）。
 * @param {object} model - 默认模型。
 * @param {object} flags - 已解析的命令行参数。
 * @returns {object} 合并后的模型。
 */
function mergeFlags(model, flags) {
  const next = JSON.parse(JSON.stringify(model));
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  if (text(flags.goal)) next.goal = text(flags.goal);
  if (text(flags.scope)) next.scope = text(flags.scope);
  if (text(flags.context)) next.context = text(flags.context);
  if (text(flags['non-goal'])) next.nonGoals = [text(flags['non-goal'])];
  if (Array.isArray(flags['non-goal'])) next.nonGoals = flags['non-goal'].map(text).filter(Boolean);

  const terms = (Array.isArray(flags.term) ? flags.term : [flags.term]).filter(Boolean);
  if (terms.length) {
    next.terms = terms
      .map((item) => {
        const [term, ...rest] = String(item).split('=');
        return {term: term.trim(), definition: rest.join('=').trim()};
      })
      .filter((item) => item.term && item.definition);
  }

  const aggregates = (Array.isArray(flags.aggregate) ? flags.aggregate : [flags.aggregate]).filter(Boolean);
  if (aggregates.length) next.aggregates = aggregates.map((item) => String(item).trim());

  const invariants = (Array.isArray(flags.invariant) ? flags.invariant : [flags.invariant]).filter(Boolean);
  if (invariants.length) next.invariants = invariants.map((item) => String(item).trim());

  const contracts = (Array.isArray(flags.contract) ? flags.contract : [flags.contract]).filter(Boolean);
  if (contracts.length) {
    next.contracts = contracts.map((item, index) => {
      const [id, title, input, output, error, accept] = String(item).split('|').map((part) => part.trim());
      return {
        id: id || `S-${String(index + 1).padStart(2, '0')}`,
        title: title || `契约 ${index + 1}`,
        input: input || '待补',
        output: output || '待补',
        error: error || '待补',
        accept: accept || '待补',
      };
    });
  }

  const steps = (Array.isArray(flags.step) ? flags.step : [flags.step]).filter(Boolean);
  if (steps.length) {
    next.steps = steps.map((item) => {
      const [title, spec] = String(item).split('|').map((part) => part.trim());
      return {title: title || '未命名步骤', spec: spec || next.contracts[0].id};
    });
  }

  const accept = (Array.isArray(flags.accept) ? flags.accept : [flags.accept]).filter(Boolean);
  if (accept.length) next.acceptance = accept.map((item) => String(item).trim());

  if (typeof flags['input-json'] === 'string' && flags['input-json'].trim().length > 0) {
    let parsed;
    try {
      parsed = JSON.parse(flags['input-json']);
    } catch (err) {
      throw new Error(`--input-json 不是合法 JSON：${err.message}`);
    }
    for (const key of Object.keys(parsed)) next[key] = parsed[key];
  }
  return next;
}

/** 渲染四份规范文档。 */
function renderDocs(model) {
  const proposal = [
    `# ${model.task} · 提案（Proposal）`,
    '',
    '> 由 `dsh-plugin-harness-cli plan` 生成的草稿：人可以直接改，改完跑 review + plan --confirm。',
    '',
    '## 1. 用户原话',
    '',
    model.userWords,
    '',
    '## 2. 为什么做',
    '',
    model.goal,
    '',
    '## 3. 范围',
    '',
    `- 做什么：${model.scope}`,
    '- 不做什么（非目标）：',
    ...model.nonGoals.map((item) => `  - ${item}`),
    '',
    '## 4. 验收',
    '',
    ...model.acceptance.map((item) => `- ${item}`),
    '',
  ].join('\n');

  const spec = [
    `# ${model.task} · 契约（SDD / Spec）`,
    '',
    '> 一条契约 = 输入 → 输出 + 错误语义 + 验收标准；页面契约表与本文件必须一一对应。',
    '',
    ...model.contracts.flatMap((contract) => [
      `## ${contract.id} ${contract.title}`,
      '',
      `- 输入：${contract.input}`,
      `- 输出：${contract.output}`,
      `- 错误语义：${contract.error}`,
      `- 验收标准：${contract.accept}`,
      '',
    ]),
  ].join('\n');

  const design = [
    `# ${model.task} · 设计（DDD）`,
    '',
    '> 先划边界，再谈实现；四个小节都必须有内容。',
    '',
    '## 1. 限界上下文',
    '',
    model.context,
    '',
    '## 2. 统一语言',
    '',
    '| 术语 | 定义 |',
    '|---|---|',
    ...model.terms.map((item) => `| ${item.term} | ${item.definition} |`),
    '',
    '## 3. 聚合与实体',
    '',
    ...model.aggregates.map((item) => `- ${item}`),
    '',
    '## 4. 不变量',
    '',
    ...model.invariants.map((item) => `- ${item}`),
    '',
    '## 5. 方案与取舍',
    '',
    model.scope,
    '',
  ].join('\n');

  const tasks = [
    `# ${model.task} · 任务规划`,
    '',
    '> 编号必须与页面步骤一致（1..N），每步写清落地的契约编号。',
    '',
    ...model.steps.map((step, index) => `${index + 1}. ${step.title}（落地 ${step.spec}）`),
    '',
  ].join('\n');

  return {'proposal.md': proposal, 'spec.md': spec, 'design.md': design, 'tasks.md': tasks};
}

/** 渲染任务页里需要被内容替换的区块。 */
function renderPageSections(model) {
  const terms = model.terms
    .map((item) => `<dt>${escapeHtml(item.term)}</dt><dd>${escapeHtml(item.definition)}</dd>`)
    .join('\n      ');
  const specs = model.contracts
    .map(
      (contract) =>
        `<tr data-spec="${escapeHtml(contract.id)}">` +
        `<td>${escapeHtml(contract.id)}</td><td>${escapeHtml(contract.title)}</td>` +
        `<td>${escapeHtml(contract.input)}</td><td>${escapeHtml(contract.output)}</td>` +
        `<td>${escapeHtml(contract.error)}</td><td>${escapeHtml(contract.accept)}</td></tr>`
    )
    .join('\n        ');
  const cases = model.contracts
    .map((contract, index) => {
      const step = model.steps.find((item) => item.spec === contract.id) || model.steps[0];
      const stepNo = model.steps.indexOf(step) + 1;
      return (
        `<li class="case" data-case="T-${String(index + 1).padStart(2, '0')}" data-spec="${escapeHtml(contract.id)}" ` +
        `data-step="${stepNo}" data-tdd="red">should_${escapeHtml(contract.title)}_when_条件成立 · ` +
        `<code>命令见 spec.md 验收标准</code></li>`
      );
    })
    .join('\n      ');
  const steps = model.steps
    .map((step, index) => {
      const no = index + 1;
      return [
        `      <li class="step" data-step="${no}" data-spec="${escapeHtml(step.spec)}">`,
        '        <div class="row">',
        `          <h3><span class="step-no">${no}</span>. ${escapeHtml(step.title)}</h3>`,
        '          <span class="pct step-pct" data-pct="0">0%</span>',
        '        </div>',
        '        <div class="bar"><div class="fill" data-step-bar></div></div>',
        '        <dl>',
        `          <dt>落地契约</dt><dd>${escapeHtml(step.spec)}</dd>`,
        '          <dt>改动落点</dt><dd>—</dd>',
        '          <dt>验证结果</dt><dd>待跑</dd>',
        '        </dl>',
        '      </li>',
      ].join('\n');
    })
    .join('\n');
  return {terms, specs, cases, steps};
}

/**
 * 把模型写进任务页 HTML（只替换固定区块，保留页面其他手工内容）。
 * @param {string} html - 原页面。
 * @param {object} model - 内容模型。
 * @returns {string} 新页面。
 */
function applyToPage(html, model) {
  const sections = renderPageSections(model);
  let next = html
    .replace(/<span data-context>[^<]*<\/span>/, `<span data-context>${escapeHtml(model.context)}</span>`)
    .replace(/(<dl class="terms" data-language>)[\s\S]*?(<\/dl>)/, `$1\n      ${sections.terms}\n    $2`)
    .replace(
      /(<ul class="plain" data-aggregates>)[\s\S]*?(<\/ul>)/,
      `$1\n${model.aggregates.map((item) => `      <li>${escapeHtml(item)}</li>`).join('\n')}\n    $2`
    )
    .replace(
      /(<ul class="plain" data-invariants>)[\s\S]*?(<\/ul>)/,
      `$1\n${model.invariants.map((item) => `      <li>${escapeHtml(item)}</li>`).join('\n')}\n    $2`
    )
    .replace(/(<table data-specs>[\s\S]*?<tbody>)[\s\S]*?(<\/tbody>)/, `$1\n        ${sections.specs}\n      $2`)
    .replace(/(<ul class="case-list" data-cases>)[\s\S]*?(<\/ul>)/, `$1\n      ${sections.cases}\n    $2`)
    .replace(/(<ol data-plan>)[\s\S]*?(<\/ol>)/, `$1\n${sections.steps}\n    $2`);
  return next;
}

/** 把模型写进方案页 HTML（目标 / 方案 / 页面设计 / 流程 / 风险 / 验收）。 */
function applyToPlan(html, model) {
  const list = (items) => items.map((item) => `      <li>${escapeHtml(item)}</li>`).join('\n');
  let next = html
    .replace(
      /(<section id="goal"[^>]*>[\s\S]*?<ul>)[\s\S]*?(<\/ul>)/,
      `$1\n${list([`原话：${model.userWords}`, `目标：${model.goal}`, `非目标：${model.nonGoals.join('；')}`])}\n    $2`
    )
    .replace(
      /(<section id="approach"[^>]*>[\s\S]*?<ul>)[\s\S]*?(<\/ul>)/,
      `$1\n${list([
        `限界上下文：${model.context}`,
        `核心方案：${model.scope}`,
        `契约：${model.contracts.map((item) => `${item.id} ${item.title}`).join('；')}`,
      ])}\n    $2`
    )
    .replace(
      /(<section id="ui"[^>]*>[\s\S]*?<ul>)[\s\S]*?(<\/ul>)/,
      `$1\n${list(
        model.hasUi
          ? [
              '页面清单：ui/index.html（antd v5 设计稿）',
              '关键状态：加载 / 空 / 错误 / 无权限 / 成功',
              'UI 稿：ui/index.html',
            ]
          : ['页面清单：本任务暂无界面（如需界面先跑 ui）', '关键状态：不适用', 'UI 稿：未生成']
      )}\n    $2`
    )
    .replace(
      /(<section id="flow"[^>]*>[\s\S]*?<ul>)[\s\S]*?(<\/ul>)/,
      `$1\n${list([
        `主流程：${model.flow.main}`,
        `异常路径：${model.flow.error}`,
        `状态流转：${model.flow.state}`,
      ])}\n    $2`
    )
    .replace(
      /(<section id="risks"[^>]*>[\s\S]*?<ul>)[\s\S]*?(<\/ul>)/,
      `$1\n${list([
        `数据风险：${model.risks.data}`,
        `依赖：${model.risks.deps}`,
        `边界：${model.risks.none}`,
      ])}\n    $2`
    )
    .replace(
      /(<section id="accept"[^>]*>[\s\S]*?<ul>)[\s\S]*?(<\/ul>)/,
      `$1\n${list(model.acceptance)}\n    $2`
    );
  return next;
}

module.exports = {
  SPEC_FILES,
  defaultModel,
  mergeFlags,
  renderDocs,
  applyToPage,
  applyToPlan,
  escapeHtml,
};
