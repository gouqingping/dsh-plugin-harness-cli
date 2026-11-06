'use strict';

/**
 * 模板作用域：所有“需要判断的内容”都在这里算成字符串，
 * 模板里只留 {{占位符}}，保证模板可以被人照着读（见 ADR-0001 §4）。
 */

const path = require('path');
const {today, toPosix, toKebab} = require('./util');

const POSITIONING_PLACEHOLDER =
  '待补：一句话说清「这是什么、给谁用、数据存在哪」，通用套话要删掉。';

const RUNTIME_CHECKS = {
  JavaScript: [
    'command -v node >/dev/null 2>&1 || { echo "❌ 未安装 Node.js（需要 >= 18）"; exit 1; }',
    'NODE_MAJOR=$(node -p "process.versions.node.split(\'.\')[0]")',
    '[ "$NODE_MAJOR" -ge 18 ] || { echo "❌ Node.js 版本过低：v$NODE_MAJOR，需要 >= 18"; exit 1; }',
  ],
  TypeScript: [
    'command -v node >/dev/null 2>&1 || { echo "❌ 未安装 Node.js（需要 >= 18）"; exit 1; }',
    'NODE_MAJOR=$(node -p "process.versions.node.split(\'.\')[0]")',
    '[ "$NODE_MAJOR" -ge 18 ] || { echo "❌ Node.js 版本过低：v$NODE_MAJOR，需要 >= 18"; exit 1; }',
  ],
  Python: [
    'command -v python3 >/dev/null 2>&1 || { echo "❌ 未安装 Python 3"; exit 1; }',
    'python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" || { echo "❌ Python 版本过低，需要 >= 3.9"; exit 1; }',
  ],
  Go: ['command -v go >/dev/null 2>&1 || { echo "❌ 未安装 Go"; exit 1; }'],
  Java: ['command -v java >/dev/null 2>&1 || { echo "❌ 未安装 Java"; exit 1; }'],
};

/**
 * gate.sh 的范围检查片段：in_progress 数不得超过 `wipLimit`（默认 1 = 单 WIP），
 * 并在开启认领时顺带跑 `claim.js verify`（并行 loop 的写冲突与认领一致性）。
 */
function buildWipCheck(featureListPath, taskQueuePath, claimScript, claimsEnabled) {
  const quotedList = featureListPath.replace(/"/g, '\\"');
  const quotedQueue = taskQueuePath.replace(/"/g, '\\"');
  const inline = [
    'const fs=require("fs");',
    'const f=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));',
    'let q={};try{q=JSON.parse(fs.readFileSync(process.argv[2],"utf8"))}catch(e){}',
    'const limit=Number.isInteger(q.wipLimit)&&q.wipLimit>0?q.wipLimit:1;',
    'const n=(f.features||[]).filter(x=>x.status==="in_progress").length;',
    'if(n>limit){console.error("❌ 同时有 "+n+" 个 in_progress，超过上限 "+limit);process.exit(1)}',
    'console.log("   WIP 检查通过（in_progress = "+n+" / 上限 "+limit+"）");',
  ].join('');
  const lines = [
    'if command -v node >/dev/null 2>&1; then',
    `  node -e '${inline}' "${quotedList}" "${quotedQueue}"`,
  ];
  if (claimsEnabled) {
    lines.push(`  node "${claimScript}" verify || { echo "❌ 认领检查未通过：node ${claimScript} list 看谁在做什么"; exit 1; }`);
  }
  lines.push('else');
  lines.push('  echo "   ⚠️ 未安装 node，跳过 WIP 上限与认领检查"');
  lines.push('fi');
  return lines.join('\n');
}

function commandRows(commands) {
  const rows = [
    {label: '初始化环境（幂等）', cmd: commands.init},
    {label: '启动开发', cmd: commands.dev},
    {label: '跑测试', cmd: commands.test},
    {label: 'Lint', cmd: commands.lint},
    {label: '类型检查', cmd: commands.typecheck},
    {label: '门禁（提交前必跑）', cmd: commands.gate},
  ];
  return rows.filter((row) => row.cmd && String(row.cmd).trim() !== '');
}

/** 目录深度 → 回到仓库根的相对路径（gate.sh 用）。 */
function rootCd(filePath) {
  const depth = toPosix(filePath).split('/').length;
  if (depth <= 1) return '.';
  return new Array(depth).join('../').replace(/\/$/, '');
}

function ciImage(stack) {
  const list = stack || [];
  if (list.includes('Python') && !list.includes('JavaScript') && !list.includes('TypeScript')) {
    return 'python:3.11-slim';
  }
  return 'node:18-bullseye';
}

function buildCiSteps(config, image) {
  const cmds = config.commands;
  const steps = [];
  steps.push({
    name: 'Install dependencies',
    identifier: 'install_dependencies',
    image,
    commandLines: cmds.install ? [cmds.install] : ['echo "no install command"'],
  });
  steps.push({
    name: 'Harness config gate',
    identifier: 'harness_config_gate',
    image,
    commandLines: ['npx dsh-plugin-harness-cli check'],
  });
  steps.push({
    name: 'Lint',
    identifier: 'lint_gate',
    image,
    commandLines: cmds.lint ? [cmds.lint] : ['echo "no lint command"'],
  });
  steps.push({
    name: 'Test',
    identifier: 'test_gate',
    image,
    commandLines: cmds.test ? [cmds.test] : ['echo "no test command"'],
  });
  steps.push({
    name: 'Harness gate (gate.sh)',
    identifier: 'harness_gate',
    image,
    commandLines: [`bash ${config.paths.gate}`],
  });
  return steps;
}

/** 把配置文本里的 {占位符} 展开成真实路径，避免配置里写死相对路径。 */
function expand(text, paths, commands) {
  return String(text).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (m, key) => {
    if (paths[key] !== undefined) return paths[key];
    if (commands[key] !== undefined) return commands[key];
    return m;
  });
}

/** 组装模板作用域。opts.task / opts.userWords 供进度页模板使用。 */
function buildContext(config, opts = {}) {
  const paths = config.paths;
  const commands = config.commands;
  const stack = config.project.stack || [];
  const checks = [];
  for (const lang of stack) {
    for (const line of RUNTIME_CHECKS[lang] || []) {
      if (!checks.includes(line)) checks.push(line);
    }
  }
  if (checks.length === 0) checks.push('echo "   未声明运行时，跳过版本检查"');

  const positioning = (config.project.positioning || '').trim() || POSITIONING_PLACEHOLDER;

  const claimsCfg = config.claims || {};
  const claims = {
    enabled: claimsCfg.enabled !== false,
    ttlHours: Number(claimsCfg.ttlHours) > 0 ? Number(claimsCfg.ttlHours) : 12,
    dir: paths.claims || 'docs/claims',
    script: paths.claimScript || 'scripts/claim.js',
  };

  const presets = config.presets || {};
  const proto = {
    enabled: false,
    dir: paths.prototype || 'prototype',
    keep: 10,
    progressPage: 'progress.html',
    templatePage: '_template/progress.html',
    indexPage: 'progress.html',
    ...(presets.prototype || {}),
  };

  const expandAll = (list) => (list || []).map((item) => expand(item, paths, commands));
  const conventions = expandAll(config.conventions);
  const forbidden = expandAll(config.forbidden);
  const dod = expandAll(config.dod);
  const workflowSteps = expandAll(config.workflow).map((step, i) => `${i + 1}. ${step}`);
  const links = (config.links || []).map((item) => ({
    title: item.title,
    path: expand(item.path, paths, commands),
  }));

  if (proto.enabled) {
    conventions.push(
      `任务进度页 ${proto.dir}/{kebab-case 任务名}/${proto.progressPage}：只改进度页里的步骤百分比，总进度由页面脚本汇总。`
    );
    forbidden.push('不手填进度页总进度，不写假百分比：真机未验收、回归没跑完时不标 100%。');
    forbidden.push(
      `不把新任务追加进旧进度页，也不让 ${proto.dir}/ 超过 ${proto.keep} 个任务目录。`
    );
    dod.push('任务进度页已更新，且总进度 = 各步骤百分比等权汇总。');
    dod.push(`\`node ${paths.prototypeCheck}\` 通过（目录数 / 进度一致性 / 与 docs 一致）。`);
  }

  if (claims.enabled) {
    conventions.push(
      `并行推进靠认领：开工先 \`node ${claims.script} add <F-xxx> --owner <会话/Agent 标识> --scope <路径>\`；` +
        '认出上限或 scope 冲突说明该换任务，不要硬上。'
    );
    conventions.push(
      `长任务定期 \`node ${claims.script} heartbeat <F-xxx> --owner <标识>\`：心跳超过 ${claims.ttlHours}h 会被判成死掉的 loop。`
    );
    forbidden.push('不在没有认领的情况下把 feature 置为 in_progress，也不改别人 scope 里的文件。');
    dod.push(`收工已 \`node ${claims.script} release <F-xxx>\`，认领与 feature 状态一致。`);
    dod.push(`\`node ${claims.script} verify\` 通过：每个 in_progress 都有认领，scope 不重叠。`);
  }

  const rows = commandRows(commands);
  if (claims.enabled) {
    rows.push({label: '查看并行认领', cmd: `node ${claims.script} list`});
    rows.push({label: '认领 / 释放任务', cmd: `node ${claims.script} add F-001 --owner <标识> --scope <路径>`});
  }

  return {
    project: config.project,
    configFile: opts.configFile || 'harness-cli.json',
    paths,
    commands,
    presets,
    prototype: proto,
    dirs: config.dirs || [],
    conventions,
    workflowSteps,
    forbidden,
    dod,
    links,
    positioning,
    stackText: stack.length ? stack.join(' / ') : '待补',
    runtimeText: config.project.runtime || '待补',
    versionFile: paths.versionInfo
      ? toPosix(path.posix.join(paths.versionInfo, `v${config.project.version}.md`))
      : '',
    commandRows: rows,
    claims,
    preflightLines: checks,
    installCmd: commands.install || '',
    lintCmd: commands.lint || '',
    verifyCmd: commands.lint || commands.test || '',
    devCmd: commands.dev || '（待补）',
    testCmd: commands.test || '（待补）',
    gateCmd: commands.gate,
    gatePath: paths.gate,
    wipCheck: buildWipCheck(paths.featureList, paths.taskQueue, claims.script, claims.enabled),
    claimScript: claims.script,
    claimsDir: claims.dir,
    claimsTtl: String(claims.ttlHours),
    docs: paths.docs,
    featureList: paths.featureList,
    taskQueue: paths.taskQueue,
    rootCd: rootCd(paths.gate),
    ciIdentifier: `${toKebab(config.project.name) || 'project'}_ci`,
    ciSteps: buildCiSteps(config, ciImage(stack)),
    today: today(),
    todayIso: new Date().toISOString(),
    task: opts.task || '任务名称（kebab-case 目录名）',
    userWords: opts.userWords || '（粘贴用户原话，不要转述）',
    roleHint: '待补：写清谁在用这个页面（角色）',
    prototypeDir: proto.dir,
    prototypePage: proto.progressPage,
    prototypeTemplate: proto.templatePage,
    prototypeKeep: String(proto.keep),
    prototypeCheck: paths.prototypeCheck,
    prototypeIndex: proto.indexPage,
    specsDir: paths.specs || 'docs/specs',
  };
}

module.exports = {buildContext, POSITIONING_PLACEHOLDER, rootCd, commandRows, expand};
