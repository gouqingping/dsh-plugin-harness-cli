'use strict';

/**
 * wikidocs：从仓库里**已经写好的规范文档**里反推业务事实，供 wiki 模板使用。
 *
 * 背景：wiki 以前只扫配置 / 功能清单 / 任务页，业务内容一律写「待业务确认」，
 * 只能靠人或 Agent 手工补进受管区块；重跑时这些补写又会被当成「人工改过」。
 * 现在把 docs/specs/<任务>/proposal.md（为什么做 / 范围 / 验收）、spec.md（契约标题）、
 * design.md（统一语言 / 不变量）与 docs/adr（关键决策）当作事实来源，生成器自己就能反补。
 *
 * 两条硬约束（wiki 的用例会守着）：
 * - 生成物是业务白话：代码块、命令、文件路径、测试用例名一律丢掉；
 * - 只读：这里只读文件，不写任何东西。
 */

const fs = require('fs');
const path = require('path');
const {isDir, readIfExists} = require('./util');

const MAX_ITEMS = 8;
const MAX_CHARS = 240;

/** 去 Markdown 记号，留下人话（含行内代码里的字，但不留反引号）。 */
function stripInline(raw) {
  return String(raw)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/\|/g, '／')
    .trim();
}

/** 判断一行是不是业务白话：命令、路径、代码、测试名都算技术细节。 */
function isBusiness(text) {
  if (typeof text !== 'string') return false;
  if (text.length < 6) return false;
  if (/```|<!--|mermaid|<[a-z/][^>]*>/i.test(text)) return false;
  if (/\b(node|npm|pnpm|git|bash|python3?|pip|npx)\s+[^\s]+/i.test(text)) return false;
  // 文件路径：docs/specs、src/app、plugin/bin/...（带空格的「注册 / 登录」不算）
  if (/(^|[\s(（])(?:\.\/|\/)?[\w.-]+(?:\/[\w.-]+)+/i.test(text)) return false;
  if (/\b[\w-]+\.(?:js|ts|mjs|cjs|jsx|tsx|py|json|md|sh|html|css|sql|yml|yaml)\b/i.test(text)) return false;
  if (/\bshould_[a-z0-9_]+\b/i.test(text)) return false;
  // 字段名 / 数据建模术语属于技术细节，留给技术文档
  if (/\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\b/.test(text)) return false;
  if (/\b(varchar|char_length|primary key|foreign key|not null|between\s+\d+\s+and\s+\d+)\b/i.test(text)) return false;
  return true;
}

function clip(text) {
  const value = String(text).trim();
  return value.length > MAX_CHARS ? `${value.slice(0, MAX_CHARS)}…` : value;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = String(item).trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 按 Markdown 标题切段；第一段是标题之前的内容。 */
function sections(markdown) {
  const out = [];
  let current = {heading: '', lines: []};
  out.push(current);
  for (const raw of String(markdown).split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+)$/.exec(raw.trim());
    if (match) {
      current = {heading: match[2].trim(), level: match[1].length, lines: []};
      out.push(current);
      continue;
    }
    current.lines.push(raw);
  }
  return out;
}

/**
 * 找一个小节：按候选正则依次匹配，跳过「与 docs/wiki 同步」这类生成区块。
 * @param {Array} secs - sections() 的结果。
 * @param {RegExp[]} patterns - 标题候选（按优先级）。
 * @returns {string[]} 小节正文行；找不到返回空数组。
 */
function findSection(secs, patterns) {
  for (const pattern of patterns) {
    for (const section of secs) {
      // 一级标题是文档标题（例如「登录页面 · 业务流程图」），不能当成同名小节
      if (section.heading === '' || section.level === 1) continue;
      if (pattern.test(section.heading) === false) continue;
      if (/docs\/wiki|与.*同步|wiki-context/i.test(section.heading)) continue;
      if (section.lines.some((line) => line.trim() !== '')) return section.lines;
    }
  }
  return [];
}

/** 把段落与列表项读成人话：空行分段，列表项各自成条。 */
function paragraphs(lines) {
  const out = [];
  let buffer = [];
  let item = null; // 上一条列表项在 out 里的下标（用于吸收续行）
  const flush = () => {
    if (buffer.length === 0) return;
    const text = stripInline(buffer.join(' '));
    if (isBusiness(text)) out.push(clip(text));
    buffer = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || /^#{1,6}\s/.test(line) || /^\|/.test(line) || /^<!--/.test(line) || /^```/.test(line)) {
      flush();
      item = null;
      continue;
    }
    const bullet = /^(?:[-*+]|\d+[.、])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      const text = stripInline(bullet[1]);
      if (isBusiness(text)) {
        out.push(clip(text));
        item = out.length - 1;
      } else {
        item = null;
      }
      continue;
    }
    // 列表项的缩进续行并回上一条，别拆成独立的一句
    if (item !== null && /^\s{2,}|^\t/.test(raw)) {
      const extra = stripInline(line);
      if (extra !== '') out[item] = clip(`${out[item]} ${extra}`);
      continue;
    }
    item = null;
    buffer.push(line);
  }
  flush();
  return dedupe(out);
}

/** 读「范围」小节里的「做什么 / 不做什么（非目标）」。 */
function scopeOf(lines) {
  const inside = [];
  const outside = [];
  let mode = null;
  const marker = /^[-*+]\s*(?:\*\*)?\s*(做什么|不做什么[^：:\n]*|非目标)\s*(?:\*\*)?\s*[:：]?\s*(.*)$/;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    const head = marker.exec(line);
    if (head) {
      mode = /不做|非目标/.test(head[1]) ? 'out' : 'in';
      const rest = stripInline(head[2] || '');
      if (isBusiness(rest)) (mode === 'out' ? outside : inside).push(clip(rest));
      continue;
    }
    if (mode === null) continue;
    const item = /^(?:[-*+]|\d+[.、])\s+(.*)$/.exec(line);
    if (!item) continue;
    const text = stripInline(item[1]);
    if (!isBusiness(text)) continue;
    (mode === 'out' ? outside : inside).push(clip(text));
  }
  return {inside: dedupe(inside), outside: dedupe(outside)};
}

/** 读 Markdown 表格的数据行（去掉表头与分隔行）。 */
function tableRows(lines) {
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => stripInline(cell));
    if (cells.length < 2) continue;
    if (cells.every((cell) => cell === '' || /^:?-{2,}:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}

/** @param {string} dir - 任务目录。 @param {string} task - 任务名。 */
function readProposal(dir, task) {
  const text = readIfExists(path.join(dir, 'proposal.md'));
  if (text === null) return null;
  const secs = sections(text);
  const scope = scopeOf(findSection(secs, [/范围/, /边界/]));
  return {
    task,
    why: paragraphs(findSection(secs, [/为什么做/, /为什么/, /背景/, /目标/])).slice(0, 3),
    scopeIn: scope.inside,
    scopeOut: scope.outside,
    acceptance: paragraphs(findSection(secs, [/验收/])).slice(0, 8),
  };
}

/** @param {string} dir - 任务目录。 @param {string} task - 任务名。 */
function readSpec(dir, task) {
  const text = readIfExists(path.join(dir, 'spec.md'));
  if (text === null) return null;
  const contracts = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const match = /^#{2,4}\s+(S-\d+)\s+(.+)$/.exec(raw.trim());
    if (!match) continue;
    const title = stripInline(match[2]);
    if (isBusiness(`${match[1]} ${title}`)) contracts.push({id: match[1], title});
  }
  return {task, contracts};
}

/** @param {string} dir - 任务目录。 @param {string} task - 任务名。 */
function readDesign(dir, task) {
  const text = readIfExists(path.join(dir, 'design.md'));
  if (text === null) return null;
  const secs = sections(text);
  const terms = [];
  for (const cells of tableRows(findSection(secs, [/统一语言/, /术语/]))) {
    const [term, meaning, confusion] = cells;
    if (!term || /^术语$/.test(term) || !isBusiness(meaning)) continue;
    terms.push({term, meaning, confusion: isBusiness(confusion) ? confusion : ''});
  }
  return {
    task,
    terms,
    invariants: paragraphs(findSection(secs, [/不变量/])).slice(0, 6),
  };
}

/** @param {string} dir - ADR 目录。 */
function readDecisions(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('.md')).sort();
  } catch (err) {
    return [];
  }
  const out = [];
  for (const file of files) {
    const text = readIfExists(path.join(dir, file));
    if (text === null) continue;
    const title = (/^#\s+(.+)$/m.exec(text) || [])[1] || file.replace(/\.md$/, '');
    const status = (/状态[：:]\s*([^\n]+)/.exec(text) || [])[1] || '';
    const summary = paragraphs(findSection(sections(text), [/决策/, /结论/]))[0] || '';
    out.push({
      title: clip(stripInline(title)),
      status: clip(stripInline(status)),
      summary: summary ? clip(summary) : '要点见设计记录。',
    });
  }
  return out.slice(0, 5);
}

/**
 * 汇总 docs 里能反推出的业务事实。任何一项读不到都返回空数组，模板会自动退回「待业务确认」。
 * @param {string} root - 仓库根目录。
 * @param {object} [paths] - 生效配置里的 paths。
 * @returns {object} 模板作用域里的 docs。
 */
function collectDocFacts(root, paths = {}) {
  const facts = {
    proposals: [],
    decisions: [],
    terms: [],
    invariants: [],
    contracts: [],
    why: [],
    scopeOut: [],
    acceptance: [],
  };

  const specsDir = path.join(root, paths.specs || 'docs/specs');
  if (isDir(specsDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(specsDir, {withFileTypes: true});
    } catch (err) {
      entries = [];
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(specsDir, entry.name);
      const proposal = readProposal(dir, entry.name);
      if (proposal !== null) facts.proposals.push(proposal);
      const spec = readSpec(dir, entry.name);
      if (spec !== null) {
        for (const contract of spec.contracts) facts.contracts.push({task: entry.name, ...contract});
      }
      const design = readDesign(dir, entry.name);
      if (design !== null) {
        facts.terms.push(...design.terms);
        facts.invariants.push(...design.invariants);
      }
    }
  }

  facts.decisions = readDecisions(path.join(root, paths.decisions || 'docs/adr'));

  const why = [];
  const scopeOut = [];
  const acceptance = [];
  for (const proposal of facts.proposals) {
    why.push(...proposal.why);
    scopeOut.push(...proposal.scopeOut);
    if (proposal.acceptance.length > 0) {
      acceptance.push({task: proposal.task, items: proposal.acceptance.slice(0, 6)});
    }
  }

  const seenTerms = new Set();
  facts.terms = facts.terms
    .filter((item) => {
      if (seenTerms.has(item.term)) return false;
      seenTerms.add(item.term);
      return true;
    })
    .slice(0, 12);
  facts.invariants = dedupe(facts.invariants).slice(0, 8);
  facts.why = dedupe(why).slice(0, 4);
  facts.scopeOut = dedupe(scopeOut).slice(0, MAX_ITEMS);
  facts.acceptance = acceptance;
  return facts;
}

module.exports = {
  collectDocFacts,
  readProposal,
  readSpec,
  readDesign,
  findSection,
  stripInline,
  isBusiness,
  scopeOf,
  paragraphs,
  sections,
  tableRows,
  MAX_ITEMS,
};
