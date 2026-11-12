'use strict';

/**
 * 配置：`harness-cli.json` 是唯一的可调整入口。
 *
 * 设计约束（见 docs/adr/ADR-0001-harness-cli.md §4）：
 * - 默认值只写在代码里这一处，模板不含任何“规则性文字”的判断；
 * - 配置文件只覆盖它显式声明的字段，其余走默认值（最小覆盖）；
 * - 配置解析失败一律抛错退出 2，不静默降级成默认值。
 */

const path = require('path');
const {readJsonIfExists, isText, toArray, exists} = require('./util');
const {detect} = require('./detect');

const CONFIG_FILE = 'harness-cli.json';
/**
 * 历史文件名，新→旧排列：改名前的仓库仍能用，读到就提示，不静默忽略。
 * harness-pro.json = 上一版名字；common-agent.json = 最初的名字。
 */
const LEGACY_CONFIG_FILES = ['harness-pro.json', 'common-agent.json'];

/** 路径默认值：与平台 harness 骨架（docs/feature_list.json 等）保持一致。 */
const DEFAULT_PATHS = {
  agents: 'AGENTS.md',
  init: 'init.sh',
  gate: 'scripts/gate.sh',
  featureList: 'docs/feature_list.json',
  progress: 'claude-progress.md',
  taskQueue: 'task_queue.json',
  docs: 'docs',
  decisions: 'docs/adr',
  adr: 'docs/adr/ADR-0001-harness.md',
  versionInfo: '_VERSIONS',
  harness: '.harness',
  prototype: 'prototype',
  prototypeCheck: 'scripts/prototype-check.js',
  claims: 'docs/claims',
  specs: 'docs/specs',
  wiki: 'docs/wiki',
  claimScript: 'scripts/claim.js',
};

/**
 * 并行 loop：跨会话 / 跨 Agent 同时推进多个 feature 时的认领约定。
 *
 * - `enabled`：false 时整条链路（生成物 + C2xx 判定）都跳过，单 WIP 仍然有效；
 * - `ttlHours`：认领的心跳超过这个小时数没更新，视为死循环留下的陈旧认领（只警告，不自动删）。
 *
 * 并行度本身来自 `task_queue.json` 的 `wipLimit`（默认 1 = 原来的单 WIP），这里不重复一个开关。
 */
/**
 * 业务 wiki：从仓库文件生成 `docs/wiki/`。
 * - `mode`：冲突时怎么办——`ask`（交互询问，非交互环境视为保留并退出 1）、`auto`（全部更新）、`keep`（全部保留）；
 * - 单次运行可用 `--update` / `--keep` / `--ask` 覆盖。
 */
const DEFAULT_WIKI = {
  mode: 'merge',
};

const DEFAULT_CLAIMS = {
  enabled: true,
  ttlHours: 12,
};

/**
 * 可选预设：默认全部关闭，init --preset <name> 时打开。
 * prototype = 「任务进度页」约定（一个任务一页、总进度实时汇总、只留最近 N 个）。
 */
const PRESET_NAMES = ['prototype'];

const DEFAULT_PRESETS = {
  prototype: {
    enabled: false,
    dir: 'prototype',
    keep: 10,
    progressPage: 'progress.html',
    templatePage: '_template/progress.html',
    indexPage: 'progress.html',
  },
};

const DEFAULT_CONVENTIONS = [
  '遵循仓库既有格式化与 Lint 配置，不重排无关文件。',
  '只做最小范围修改，不顺带重构无关代码。',
  '新增目录必须在本文件「目录地图」补一行说明。',
  '测试命名要能当文档读：`should_<行为>_when_<条件>`。',
];

const DEFAULT_FORBIDDEN = [
  '不修改本次 feature 范围之外的文件。',
  '不跳过测试直接把 feature 标为 `done`。',
  '不用 `git commit --no-verify` 绕过门禁。',
  '不提交 `.env`、日志、构建产物与依赖目录。',
  '不在同一会话来开始第二个 feature（全局单 WIP）。',
];

const DEFAULT_DOD = [
  '`acceptance` 逐条核对通过，每条能说出验证方式。',
  '至少一个测试覆盖本次变更，且测试名可读。',
  '门禁命令全绿（lint + 测试 + 单 WIP 检查）。',
  '无遗留调试代码、被注释掉的代码、无主 TODO。',
  '相关文档已同步（本文件 / `docs/`）。',
  '`{featureList}` 的 `evidence` 已填写。',
  '`{progress}` 已记录本次会话。',
];

/** 默认工作流：四件套闭环。用 {占位符} 引用配置里的路径。 */
const DEFAULT_WORKFLOW = [
  '开工先读 `{progress}`：恢复上次进度；有未完成任务时先继续完成，不要从零重做或另起无关任务。',
  '读 `{featureList}`，取一个 `status = pending` 且依赖已完成的 feature，置为 `in_progress`（全局最多一个）。',
  '按该 feature 的 `acceptance` 实现并补测试，不碰范围外文件。',
  '跑 `{gate}`，全绿才算过。',
  '回填 `evidence` → 状态推进到 `done` → 更新 `{progress}`（收工必写）。',
  '需求有变先改 `{featureList}`，再改代码；范围变更只能通过改文件显式发生。',
];

const DEFAULT_LINKS = [
  {title: '任务日志', path: 'docs/current.md'},
  {title: '功能清单', path: 'docs/feature_list.json'},
  {title: '任务队列', path: 'task_queue.json'},
  {title: 'Harness 设计决策', path: '{adr}'},
];

/** 由探测结果生成默认配置（不含用户覆盖）。 */
function defaultConfig(root) {
  const facts = detect(root);
  return {
    version: 1,
    project: {
      name: facts.name,
      positioning: '',
      stack: facts.languages,
      runtime: facts.runtime,
      version: facts.version,
    },
    paths: {...DEFAULT_PATHS},
    commands: {
      install: facts.commands.install,
      dev: facts.commands.dev,
      test: facts.commands.test,
      lint: facts.commands.lint,
      typecheck: facts.commands.typecheck,
      init: `bash ${DEFAULT_PATHS.init}`,
      gate: `bash ${DEFAULT_PATHS.gate}`,
    },
    dirs: facts.dirs,
    conventions: [...DEFAULT_CONVENTIONS],
    forbidden: [...DEFAULT_FORBIDDEN],
    dod: [...DEFAULT_DOD],
    links: [...DEFAULT_LINKS],
    workflow: [...DEFAULT_WORKFLOW],
    presets: JSON.parse(JSON.stringify(DEFAULT_PRESETS)),
    claims: {...DEFAULT_CLAIMS},
    wiki: {...DEFAULT_WIKI},
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 实际生效的配置文件名（新名优先，其次旧名）。 */
function resolveConfigFile(root) {
  if (exists(path.join(root, CONFIG_FILE))) return {name: CONFIG_FILE, legacy: false};
  for (const name of LEGACY_CONFIG_FILES) {
    if (exists(path.join(root, name))) return {name, legacy: true};
  }
  return {name: CONFIG_FILE, legacy: false};
}

/** 深合并：数组整体替换（不拼接），对象逐键合并。 */
function merge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = Array.isArray(base) ? [] : {...base};
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

/**
 * 读取并合并配置。文件不存在时直接返回默认配置（init 会把它落盘）。
 * 兼容历史文件名（harness-pro.json / common-agent.json）：返回 legacy=true，由调用方提示改名。
 * @returns {{config: object, configPath: string, hadFile: boolean, legacy: boolean}}
 */
function loadConfig(root) {
  const resolved = resolveConfigFile(root);
  const configPath = path.join(root, resolved.name);
  const raw = readJsonIfExists(configPath, null);
  const legacy = resolved.legacy && raw !== null;
  const base = defaultConfig(root);
  if (raw === null) return {config: base, configPath, hadFile: false, legacy: false};
  if (!isPlainObject(raw)) {
    const err = new Error(`${CONFIG_FILE} 根节点必须是对象`);
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return {config: merge(base, raw), configPath, hadFile: true, legacy};
}

/** 语义校验：字段类型与必填项。返回问题数组，空数组表示通过。 */
function validateConfig(config) {
  const issues = [];
  const need = (cond, msg) => {
    if (!cond) issues.push(msg);
  };
  need(isPlainObject(config.project), 'config.project 必须是对象');
  need(isPlainObject(config.paths), 'config.paths 必须是对象');
  need(isPlainObject(config.commands), 'config.commands 必须是对象');
  for (const key of Object.keys(DEFAULT_PATHS)) {
    // versionInfo 允许为空：有些仓库不做版本说明，宁可没有，也不要指向不存在的文件
    if (key === 'versionInfo') continue;
    need(isText(config.paths[key]), `config.paths.${key} 为空，无法定位文件`);
  }
  for (const key of ['conventions', 'forbidden', 'dod', 'links', 'dirs', 'workflow']) {
    need(Array.isArray(config[key]), `config.${key} 必须是数组`);
  }
  need(toArray(config.forbidden).length >= 3, 'config.forbidden 少于 3 条（讲义的 AGENTS.md 自检项）');
  need(toArray(config.dod).length >= 4, 'config.dod 少于 4 条，完成定义会退化成形容词');
  for (const item of toArray(config.dirs)) {
    need(isPlainObject(item) && isText(item.path), 'config.dirs 的每一项都要有 path');
    need(
      isPlainObject(item) && (item.name === undefined || isText(item.name)),
      'config.dirs 的 name 是业务名（可省略），写了就必须有值'
    );
  }
  for (const item of toArray(config.links)) {
    need(isPlainObject(item) && isText(item.path), 'config.links 的每一项都要有 path');
  }
  const wiki = config.wiki || {};
  need(isPlainObject(wiki), 'config.wiki 必须是对象');
  if (isPlainObject(wiki)) {
    need(
      wiki.mode === undefined || ['merge', 'ask', 'auto', 'keep'].includes(wiki.mode),
      'config.wiki.mode 只能是 merge / auto / keep（ask 为旧名，等价于 merge）'
    );
  }

  const claims = config.claims || {};
  need(isPlainObject(claims), 'config.claims 必须是对象');
  if (isPlainObject(claims)) {
    need(
      claims.enabled === undefined || typeof claims.enabled === 'boolean',
      'config.claims.enabled 必须是布尔值'
    );
    need(
      claims.ttlHours === undefined || (typeof claims.ttlHours === 'number' && Number.isFinite(claims.ttlHours) && claims.ttlHours > 0),
      'config.claims.ttlHours 必须是正数（小时）'
    );
  }

  const presets = config.presets || {};
  for (const name of PRESET_NAMES) {
    const preset = presets[name];
    if (preset === undefined) continue;
    need(isPlainObject(preset), `config.presets.${name} 必须是对象`);
    if (!isPlainObject(preset)) continue;
    need(
      preset.enabled === undefined || typeof preset.enabled === 'boolean',
      `config.presets.${name}.enabled 必须是布尔值`
    );
    need(
      preset.keep === undefined || (Number.isInteger(preset.keep) && preset.keep > 0),
      `config.presets.${name}.keep 必须是正整数`
    );
    need(
      preset.dir === undefined || isText(preset.dir),
      `config.presets.${name}.dir 不能为空`
    );
    need(
      preset.indexPage === undefined || isText(preset.indexPage),
      `config.presets.${name}.indexPage 不能为空`
    );
  }
  return issues;
}

module.exports = {
  CONFIG_FILE,
  LEGACY_CONFIG_FILES,
  PRESET_NAMES,
  DEFAULT_PRESETS,
  DEFAULT_CLAIMS,
  DEFAULT_WIKI,
  DEFAULT_PATHS,
  DEFAULT_CONVENTIONS,
  DEFAULT_FORBIDDEN,
  DEFAULT_DOD,
  DEFAULT_LINKS,
  DEFAULT_WORKFLOW,
  defaultConfig,
  resolveConfigFile,
  loadConfig,
  validateConfig,
  merge,
};
