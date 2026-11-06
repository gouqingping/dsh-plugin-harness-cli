'use strict';

/**
 * 模板加载：文件是唯一真源，缺失就报错（退出 2），不在代码里留一份内联副本。
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');

const NAMES = {
  agents: 'AGENTS.md.tmpl',
  init: 'init.sh.tmpl',
  gate: 'gate.sh.tmpl',
  progress: 'claude-progress.md.tmpl',
  current: 'current.md.tmpl',
  versionInfo: 'version-note.md.tmpl',
  adr: 'adr-0001-harness.md.tmpl',
  readme: 'readme.md.tmpl',
  ci: 'ci.yaml.tmpl',
  gitignore: 'gitignore.tmpl',
  progressHtml: 'progress.html.tmpl',
  progressIndex: 'progress-index.html.tmpl',
  prototypeCheck: 'prototype-check.js.tmpl',
  prototypeReadme: 'prototype-README.md.tmpl',
  prototypePlan: 'prototype-plan.html.tmpl',
  prototypeUi: 'prototype-ui.html.tmpl',
  prototypeUiReadme: 'prototype-ui-readme.md.tmpl',
  specsReadme: 'specs-README.md.tmpl',
  specProposal: 'spec-proposal.md.tmpl',
  specSpec: 'spec-spec.md.tmpl',
  specDesign: 'spec-design.md.tmpl',
  specTasks: 'spec-tasks.md.tmpl',
  wikiOverview: 'wiki-overview.md.tmpl',
  wikiDeployment: 'wiki-deployment.md.tmpl',
  wikiRoles: 'wiki-roles.md.tmpl',
  wikiFlows: 'wiki-flows.md.tmpl',
  wikiFeatures: 'wiki-features.md.tmpl',
  wikiRules: 'wiki-rules.md.tmpl',
  wikiConventions: 'wiki-conventions.md.tmpl',
  wikiQuality: 'wiki-quality.md.tmpl',
  wikiAcceptance: 'wiki-acceptance.md.tmpl',
  wikiRisks: 'wiki-risks.md.tmpl',
  wikiGlossary: 'wiki-glossary.md.tmpl',
  wikiManual: 'wiki-manual.md.tmpl',
  wikiReadme: 'wiki-readme.md.tmpl',
  plans: 'plans.html.tmpl',
  wikiDomain: 'wiki-domain.md.tmpl',
  claimsReadme: 'claims-README.md.tmpl',
  claimScript: 'claim.js.tmpl',
};

function templatePath(key) {
  const file = NAMES[key];
  if (!file) throw new Error(`未注册的模板键：${key}`);
  return path.join(TEMPLATE_DIR, file);
}

function loadTemplate(key) {
  const file = templatePath(key);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`模板缺失：${file}（工具安装不完整，先跑 dsh-plugin-harness-cli doctor）`);
    throw err;
  }
}

function loadAll() {
  const out = {};
  for (const key of Object.keys(NAMES)) out[key] = loadTemplate(key);
  return out;
}

module.exports = {NAMES, TEMPLATE_DIR, templatePath, loadTemplate, loadAll};
