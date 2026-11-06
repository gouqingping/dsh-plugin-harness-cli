'use strict';

/**
 * 极简模板引擎（不引入 handlebars/mustache，避免离线环境装不上）。
 *
 * 支持：
 *   {{key}} / {{a.b}}      变量替换；数组按 ", " 拼接
 *   {{#if key}}…{{/if}}    真值块
 *   {{#unless key}}…{{/unless}}
 *   {{#each list}}…{{/each}}  循环体里 {{this}}/{{.}} 指当前项，
 *                             项是对象时也可直接写 {{name}}
 *
 * 不支持表达式、过滤器、部分模板——模板里需要判断的逻辑放在 JS 里算好再传进来。
 */

const TOKEN = /\{\{([^{}]+)\}\}/g;
const OPEN = new Set(['if', 'unless', 'each']);

function tokenize(text) {
  const out = [];
  let last = 0;
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text)) !== null) {
    if (m.index > last) out.push({type: 'text', value: text.slice(last, m.index)});
    out.push({type: 'tag', value: m[1].trim()});
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({type: 'text', value: text.slice(last)});
  return out;
}

function parse(tokens) {
  const root = {children: []};
  const stack = [root];
  for (const tk of tokens) {
    const top = stack[stack.length - 1];
    if (tk.type === 'text') {
      top.children.push({kind: 'text', value: tk.value});
      continue;
    }
    const tag = tk.value;
    if (tag.startsWith('#') || tag.startsWith('/')) {
      const closing = tag.startsWith('/');
      const body = tag.slice(1).trim();
      const [name, ...rest] = body.split(/\s+/);
      if (closing) {
        if (stack.length === 1) throw new Error(`模板多余的结束标签 {{/${name}}}`);
        const open = stack.pop();
        if (open.name !== name) {
          throw new Error(`模板标签不配对：{{#${open.name}}} 与 {{/${name}}}`);
        }
        continue;
      }
      if (!OPEN.has(name)) throw new Error(`模板不支持的块标签 {{#${name}}}`);
      const node = {kind: name, name, key: rest.join(' '), children: []};
      top.children.push(node);
      stack.push(node);
      continue;
    }
    top.children.push({kind: 'var', key: tag});
  }
  if (stack.length !== 1) {
    throw new Error(`模板标签未闭合：{{#${stack[stack.length - 1].name}}}`);
  }
  return root;
}

function lookup(scope, key) {
  if (key === '' || key === '.' || key === 'this') return scope;
  if (key.startsWith('./')) return lookup(scope, key.slice(2));
  if (key.startsWith('.')) return lookup(scope, key.slice(1));
  if (key.startsWith('this.')) return lookup(scope, key.slice(5));
  if (scope === null || scope === undefined) return undefined;
  if (typeof scope !== 'object') return undefined;
  let cur = scope;
  for (const seg of key.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function truthy(v) {
  if (v === undefined || v === null || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

function scalar(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function walk(node, scope) {
  let out = '';
  for (const child of node.children) {
    if (child.kind === 'text') {
      out += child.value;
    } else if (child.kind === 'var') {
      out += scalar(lookup(scope, child.key));
    } else if (child.kind === 'if') {
      if (truthy(lookup(scope, child.key))) out += walk(child, scope);
    } else if (child.kind === 'unless') {
      if (!truthy(lookup(scope, child.key))) out += walk(child, scope);
    } else if (child.kind === 'each') {
      const list = lookup(scope, child.key);
      for (const item of Array.isArray(list) ? list : []) {
        out += walk(child, item);
      }
    }
  }
  return out;
}

/** 渲染模板文本。 */
function render(template, scope) {
  return walk(parse(tokenize(template)), scope || {});
}

/**
 * 收集模板里引用到的顶层变量，doctor 用它做“模板与上下文是否对得上”的检查。
 * 只统计变量与块条件，不展开 each 内部的字段。
 */
function requiredKeys(template) {
  const keys = new Set();
  for (const tk of tokenize(template)) {
    if (tk.type !== 'tag') continue;
    const tag = tk.value;
    if (tag.startsWith('/')) continue;
    const body = tag.startsWith('#') ? tag.slice(1) : tag;
    const parts = body.trim().split(/\s+/);
    const name = tag.startsWith('#') ? parts[1] : parts[0];
    if (!name || name === 'this' || name === '.' || name.startsWith('./') || name.startsWith('this.')) {
      continue;
    }
    keys.add(name);
  }
  return [...keys];
}

module.exports = {render, requiredKeys, tokenize};
